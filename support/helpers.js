import { Bridge } from '../lib/core/bridge.js'
import { MemoryStore } from '../lib/core/store.js'

export const THREAD = '00000000-0000-4000-8000-000000000001'
export const SESSION = 'session-test-0001'
export const WORKDIR = 'D:/workspace/dsh-codex-bridge'

export function makeClock(start = Date.parse('2026-11-13T00:00:00Z')) {
  const clock = {
    now: start,
    advance(ms) {
      clock.now += ms
    },
  }
  return clock
}

export async function makeBridge({ config = {}, clock = makeClock() } = {}) {
  const store = new MemoryStore()
  const bridge = new Bridge({ store, clock: () => clock.now, config })
  await bridge.init()
  return { bridge, store, clock }
}

export async function paired({ config = {}, budgets, clock = makeClock() } = {}) {
  const env = await makeBridge({ config, clock })
  const created = await env.bridge.createRoom({
    member: 'dsh',
    identity: SESSION,
    goal: 'Build and verify the DSH x Codex bridge',
    cwd: WORKDIR,
    scope: { text: 'bridge project only', writeScopes: [WORKDIR] },
    budgets,
  })
  const joined = await env.bridge.joinRoom({
    member: 'codex',
    identity: THREAD,
    code: created.code,
    cwd: WORKDIR,
  })
  return { ...env, code: created.code, room: joined.room }
}
