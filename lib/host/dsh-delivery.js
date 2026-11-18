import { randomUUID } from 'node:crypto'

/**
 * Delivers a collaboration message into an existing, user-created DSH session.
 * It never creates a session: a cold session is resumed through the public
 * AgentRegistry.resume path, and an already loaded session receives the text
 * through its public inbox (`steer`).
 */
export class DshDelivery {
  constructor({ agents, timeoutMs = 45_000, logger } = {}) {
    if (!agents) throw new Error('DshDelivery requires the DSH agents service')
    this.agents = agents
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.pendingResumes = new Map()
  }

  attached(sessionId) {
    return this.agents.get(sessionId)
  }

  async #resolve(sessionId) {
    const existing = this.agents.get(sessionId)
    if (existing) return { agent: existing, resumed: false }

    let pending = this.pendingResumes.get(sessionId)
    if (!pending) {
      pending = Promise.resolve().then(() =>
        this.agents.resume({ resumeSessionId: sessionId, agentOptions: {} }),
      )
      this.pendingResumes.set(sessionId, pending)
      pending.finally(() => this.pendingResumes.delete(sessionId)).catch(() => {})
    }
    const agent = await withTimeout(pending, this.timeoutMs)
    if (!agent) throw new Error(`timed out resuming DSH session ${sessionId}`)
    return { agent, resumed: true }
  }

  /**
   * @returns {Promise<{state:'queued', detail:string, evidence:object, agent:object}>}
   */
  async deliver({ room, message, text }) {
    if (!room.dshSessionId) throw new Error('room has no bound DSH session')
    if (message.to !== 'dsh') throw new Error('message is not addressed to the DSH member')
    const { agent, resumed } = await this.#resolve(room.dshSessionId)
    if (!agent) throw new Error(`DSH session ${room.dshSessionId} is not available`)
    if (agent.id !== room.dshSessionId) {
      throw new Error(`resolved agent ${agent.id} does not match room session ${room.dshSessionId}`)
    }

    const input = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'agent-message',
        form: 'relay',
        senderSessionId: `codex:${room.codexThreadId ?? 'unbound'}`,
      },
    }
    const wasRunning = agent.status === 'running'
    agent.steer(input)
    return {
      state: 'queued',
      detail: resumed
        ? 'session resumed through AgentRegistry.resume and message steered into its inbox'
        : wasRunning
          ? 'message steered into the running session inbox'
          : 'message steered into the idle session inbox (wake requested)',
      evidence: { sessionId: agent.id, resumed, wasRunning, inputId: input.id },
      agent,
    }
  }

  /** Independent observation, never implied by `steer` returning. */
  statusOf(sessionId) {
    return this.agents.get(sessionId)?.status ?? 'detached'
  }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
