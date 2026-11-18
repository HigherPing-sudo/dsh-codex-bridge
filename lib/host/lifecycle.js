import { randomUUID } from 'node:crypto'

// Only a receipt in the envelope header counts; peer body text cannot ack a wake.
export function wakeFromInput(text) {
  if (!String(text).startsWith('[DSH × Codex Bridge')) return undefined
  return String(text).split('\n---')[0].match(/^wake_id=(wake_[A-Za-z0-9_-]+)$/m)?.[1]
}

export function mailText(result) {
  return [result?.incoming?.text, ...(result?.controlNotices ?? []).map((n) => n.text)]
    .filter(Boolean).join('\n\n')
}

export function hostMessage(text, room) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: `codex:${room.codexThreadId}` } }
}

/** Native boundary integration. No polling, hidden sessions, or cancel overrides. */
export function installDshLifecycle(ctx, runtime, ready) {
  const turns = new Map()
  const report = (error) => ctx.logger?.warn?.('[dsh-codex-bridge] native boundary failed', error)
  const call = async (agent, turn, event, extra = {}) => {
    await ready
    if (runtime.startError || runtime.stopping) return {}
    return runtime.lifecycle({ member: 'dsh', identity: agent.id, event, turnId: String(turn), ...extra })
  }
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const text = message.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? ''
    const wakeId = wakeFromInput(text)
    if (wakeId) return call(agent, turn, 'claimed', { wakeId }).catch(report)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter' || signal.aborted) return decision
    if (turns.get(agent)?.signal !== signal) {
      const previous = turns.get(agent)
      previous?.signal.removeEventListener('abort', previous.onAbort)
      const onAbort = () => { call(agent, turn, 'Interrupt').catch(report) }
      turns.set(agent, { signal, onAbort, turn })
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const result = await call(agent, turn, 'step', { eventId: `step:${step}`, signal })
      const text = mailText(result)
      const room = runtime.bridge.findRoomFor('dsh', agent.id)
      if (text && room && !signal.aborted) return { ...decision, messages: [...decision.messages, hostMessage(text, room)] }
    } catch (error) { report(error) }
    return decision
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted) return
    try {
      const result = await call(agent, turn, 'Stop', { signal })
      const text = mailText(result)
      const room = runtime.bridge.findRoomFor('dsh', agent.id)
      // DSH re-reads steering before committing the stop boundary.
      if (text && room && !signal.aborted) agent.steer(hostMessage(text, room))
    } catch (error) { report(error) }
  })
  ctx.on('agent/status', ({ agent, status }) => {
    const active = turns.get(agent)
    if (status === 'idle' && active && !active.signal.aborted) return call(agent, active.turn, 'idle').catch(report)
  })
  ctx.on('agent/error', ({ agent, turn }) => { call(agent, turn, 'Interrupt').catch(report) })
  ctx.on('agent/disposed', ({ agent }) => {
    const previous = turns.get(agent)
    previous?.signal.removeEventListener('abort', previous.onAbort)
    turns.delete(agent)
  })
  return () => {
    for (const { signal, onAbort } of turns.values()) signal.removeEventListener('abort', onAbort)
    turns.clear()
  }
}
