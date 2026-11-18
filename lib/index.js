import { BridgeRuntime } from './host/runtime.js'
import { PARAMETERS, DESCRIPTION } from './core/tool-schema.js'
import { toLossless } from './core/json.js'
import { installDshLifecycle } from './host/lifecycle.js'

export const name = 'dsh-codex-bridge'
export const inject = ['agents', 'tools', 'systemPrompt']

/**
 * Registers one scoped `bridge` tool plus a compact room context per DSH agent.
 * Uses only public ctx services and no @deepseek-ai value import, so it loads as
 * an ordinary third-party bundle.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const runtime = new BridgeRuntime({ ctx, config, logger })
  const ready = runtime.start().catch((error) => {
    logger?.error?.('[dsh-codex-bridge] failed to start host runtime', error)
    runtime.startError = error
    return null
  })

  const installed = new Map()
  const disposeLifecycle = installDshLifecycle(ctx, runtime, ready)
  const install = (agent) => {
    if (!agent?.ctx?.tools || installed.has(agent)) return
    const scoped = agent.ctx
    const disposers = []
    try {
      disposers.push(
        scoped.tools.register({
          name: 'bridge',
          description: DESCRIPTION,
          parameters: PARAMETERS,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          async execute(args, exec) {
            await ready
            if (runtime.startError) {
              throw new Error(`bridge host failed to start: ${runtime.startError.message}`)
            }
            const calling = exec?.agent
            if (!calling?.id) throw new Error('bridge must be called by a DSH agent session')
            const meta = {
              sessionId: calling.id,
              cwd: calling.session?.header?.cwd,
              callId: exec.callId ?? exec.toolCallId,
            }
            return toLossless(await runtime.toolCall({ member: 'dsh', identity: calling.id, meta, args }))
          },
        }),
      )

      if (scoped.systemPrompt?.context && typeof scoped.systemPrompt.getContextOrder === 'function') {
        // DSH 0.2.2-rc.3 dropped the TEAM_IDENTITY context order; keep the
        // historical slot (125) as a fallback and never let the prompt
        // contribution remove the tool that was just registered.
        const requested = scoped.systemPrompt.getContextOrder('TEAM_IDENTITY')
        const order = Number.isFinite(requested) ? requested : 125
        try {
          disposers.push(
            scoped.systemPrompt.context({
              name: 'bridge:room',
              order,
              required: false,
              text: () => runtime.promptFor(agent.id),
            }),
          )
        } catch (error) {
          logger?.warn?.('[dsh-codex-bridge] prompt context unavailable; bridge tool stays installed', error)
        }
      }
      installed.set(agent, () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch (error) {
            logger?.warn?.('[dsh-codex-bridge] failed to remove scoped install', error)
          }
        }
      })
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // best effort during a failed install
        }
      }
      throw error
    }
  }

  for (const agent of ctx.agents.list()) {
    try {
      install(agent)
    } catch (error) {
      logger?.warn?.('[dsh-codex-bridge] could not install on an existing agent', error)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      install(agent)
    } catch (error) {
      logger?.warn?.('[dsh-codex-bridge] could not install on a new agent', error)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })

  ctx.effect(
    () => () => {
      disposeLifecycle()
      for (const dispose of installed.values()) {
        try {
          dispose()
        } catch {
          // best effort on shutdown
        }
      }
      installed.clear()
      return runtime.stop()
    },
    'dsh-codex-bridge: runtime and scoped tools',
  )
}
