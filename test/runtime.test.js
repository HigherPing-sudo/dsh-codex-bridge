import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeRuntime } from '../lib/host/runtime.js'
import { SESSION, THREAD, WORKDIR } from '../support/helpers.js'
import { installDshLifecycle } from '../lib/host/lifecycle.js'
import { runHook } from '../bin/dsh-bridge-hook.js'

const ADAPTER = fileURLToPath(new URL('../bin/dsh-bridge-mcp.js', import.meta.url))

function makeRuntime({ agents, codex, delivery, dir, overrides = {} }) {
  return new BridgeRuntime({
    ctx: { agents },
    logger: { info() {}, warn() {}, error() {} },
    config: {
      dshHome: dir,
      profile: 'test',
      port: 0,
      sendWaitMs: 5_000,
      sweepMs: 60_000,
      probeDelaysMs: [10],
      codexCli: codex,
      dshDelivery: delivery,
      desktopCodex: false,
      ...overrides,
    },
  })
}

test('desktop observation drains a stale busy bridge without hooks or model readiness calls', async (t) => {
  let observed = { threadId: THREAD, status: { type: 'active', activeFlags: [] }, turn: { id: 'native-1', status: 'inProgress' }, wakeIds: [] }
  const sends = []
  const desktop = { snapshot: async () => observed, send: async (threadId, text) => {
    sends.push({ threadId, text }); return { state: 'queued', evidence: { channel: 'desktop' } }
  }, close() {} }
  const env = await runtimePair(t, { desktopCodex: desktop, desktopPollMs: 60000 })
  await env.call('codex', { action: 'availability', status: 'busy' })
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Unblock through the actual desktop' })
  assert.equal(sends.length, 0)
  observed = { ...observed, status: { type: 'idle' }, turn: { id: 'native-1', status: 'completed' } }
  await env.runtime.pollDesktop()
  assert.equal(sends.length, 1)
  assert.match(sends[0].text, /Unblock through the actual desktop/)
  assert.equal(env.codex.queueCalls.length, 0, 'no CLI queue fallback into a different writer')
})

test('the running host automatically observes idle and drains saved mail without another model tool call', async (t) => {
  let status = { type: 'active', activeFlags: [] }
  let delivered
  const seen = new Promise((resolve) => { delivered = resolve })
  const desktop = { snapshot: async () => ({ threadId: THREAD, status, turn: { id: 'automatic-1', status: status.type === 'idle' ? 'completed' : 'inProgress' } }),
    send: async (_id, text) => { delivered(text); return { state: 'queued' } }, close() {} }
  const env = await runtimePair(t, { desktopCodex: desktop, desktopPollMs: 500 })
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Automatic host delivery' })
  status = { type: 'idle' }
  let timer
  try {
    const text = await Promise.race([seen, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('automatic native polling failed to drain the outbox')), 2500) })])
    assert.match(text, /Automatic host delivery/)
    assert.equal(env.codex.queueCalls.length, 0)
  } finally { clearTimeout(timer) }
})

test('desktop polling respects real interruptions and consumes only matching native input receipts', async (t) => {
  let observed = { threadId: THREAD, status: { type: 'idle' }, turn: { id: 'native-1', status: 'interrupted' }, wakeIds: [] }
  const sends = []
  const desktop = { snapshot: async () => observed, send: async (_id, text) => { sends.push(text); return { state: 'queued' } }, close() {} }
  const env = await runtimePair(t, { desktopCodex: desktop, desktopPollMs: 60000 })
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Wait after interruption' })
  await env.runtime.pollDesktop()
  assert.equal(sends.length, 0)
  observed = { ...observed, status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turn: { id: 'native-2', status: 'inProgress' } }
  await env.runtime.pollDesktop()
  assert.equal(sends.length, 0)
  observed = { ...observed, status: { type: 'idle' }, turn: { id: 'native-2', status: 'completed' } }
  await env.runtime.pollDesktop()
  assert.equal(sends.length, 1)
  const wakeId = wakeIdFrom(sends[0])
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Second saved update' })
  await env.runtime.pollDesktop()
  assert.equal(sends.length, 1, 'idle without actual envelope consumption must not grant a second wake')
  observed = { ...observed, wakeIds: [wakeId] }
  await env.runtime.pollDesktop()
  assert.equal(sends.length, 2)
  assert.equal(env.runtime.bridge.state.messages[env.runtime.bridge.wakeFor('codex', THREAD).pending.messageIds[0]].handledAt, undefined)
})

test('native bridge tool results piggyback mail without completing earlier work', async (t) => {
  const desktop = { snapshot: async () => ({ threadId: THREAD, status: { type: 'active', activeFlags: [] }, turn: { id: 'native-1', status: 'inProgress' } }), close() {} }
  const env = await runtimePair(t, { desktopCodex: desktop, desktopPollMs: 60000 })
  const sent = await env.call('dsh', { action: 'send', kind: 'question', body: 'Inline without hooks' })
  const got = await env.call('codex', { action: 'status' })
  assert.match(got.incoming.text, /Inline without hooks/)
  assert.equal(env.runtime.bridge.state.messages[sent.message.id].handledAt, undefined)
  assert.equal(env.codex.queueCalls.length, 0)
})

test('native unavailable and paused rooms retain mail, and a send race returns it to saved', async (t) => {
  let observed = { threadId: THREAD, unavailable: 'desktop_owner_unavailable' }
  let raced = true, sends = 0
  const desktop = { snapshot: async () => observed, send: async () => {
    sends++; if (raced) return { state: 'failed', evidence: { notSubmitted: true } }; return { state: 'queued' }
  }, close() {} }
  const env = await runtimePair(t, { desktopCodex: desktop, desktopPollMs: 60000 })
  const sent = await env.call('dsh', { action: 'send', kind: 'review', body: 'Retain until safe' })
  await env.runtime.pollDesktop()
  assert.equal(sends, 0)
  observed = { threadId: THREAD, status: { type: 'idle' }, turn: { id: 'native-1', status: 'completed' } }
  await env.runtime.pollDesktop()
  assert.equal(env.runtime.bridge.state.messages[sent.message.id].delivery.state, 'saved')
  assert.equal(env.runtime.bridge.wakeFor('codex', THREAD).pending, null)
  raced = false
  await env.call('dsh', { action: 'pause', reason: 'User break' })
  await env.runtime.pollDesktop()
  assert.equal(sends, 1)
  assert.equal(env.codex.queueCalls.length, 0)
})

function fakeCodex() {
  const queueCalls = []
  return {
    queueCalls,
    resolve: async () => ({ file: 'fake-codex', source: 'test', version: '0.168.0' }),
    queue: async (args) => {
      queueCalls.push(args)
      return { state: 'queued', detail: 'fake transport accepted', evidence: { threadId: args.threadId } }
    },
    startDaemon: async () => ({ started: false, error: 'test' }),
  }
}

function fakeDelivery() {
  const deliveries = []
  return {
    deliveries,
    deliver: async ({ room, message, text }) => {
      deliveries.push({ roomId: room.id, to: message.to, text })
      return { state: 'queued', detail: 'fake DSH inbox accepted', evidence: { sessionId: room.dshSessionId } }
    },
    statusOf: () => 'running',
    attached: () => undefined,
  }
}

const fakeAgents = {
  get: () => undefined,
  list: () => [],
  resume: async () => null,
}

function wakeIdFrom(text) {
  const id = text.match(/^wake_id=(\S+)$/m)?.[1]
  assert.ok(id, 'the actual transport envelope must carry its wake receipt id')
  return id
}

async function runtimePair(t, overrides = {}, transports = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-flow-'))
  const codex = transports.codex ?? fakeCodex()
  const delivery = transports.delivery ?? fakeDelivery()
  let runtime = makeRuntime({ agents: fakeAgents, codex, delivery, dir, overrides })
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })
  await runtime.start()
  const created = await runtime.toolCall({ member: 'dsh', identity: SESSION,
    args: { action: 'create', goal: 'Flow control', cwd: WORKDIR } })
  await runtime.toolCall({ member: 'codex', identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR } })
  return {
    codex, delivery, roomId: created.room.id,
    get runtime() { return runtime },
    async restart() {
      await runtime.stop()
      runtime = makeRuntime({ agents: fakeAgents, codex, delivery, dir, overrides })
      await runtime.start()
    },
    call(member, args) {
      return runtime.toolCall({ member, identity: member === 'dsh' ? SESSION : THREAD, args })
    },
  }
}

test('native boundaries drain both busy members without model checkpoint calls or extra client wakes', async (t) => {
  const env = await runtimePair(t)
  for (const member of ['dsh', 'codex']) await env.call(member, { action: 'availability', status: 'busy' })
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Codex please review' })
  await env.call('codex', { action: 'send', kind: 'question', body: 'DSH please review' })
  const codex = await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'PostToolUse', turnId: 'turn-1', eventId: 'tool-1' })
  const dsh = await env.runtime.lifecycle({ member: 'dsh', identity: SESSION, event: 'step', turnId: '1', eventId: 'step-1' })
  assert.match(codex.incoming.text, /Codex please review/)
  assert.match(dsh.incoming.text, /DSH please review/)
  assert.equal(env.codex.queueCalls.length, 0)
  assert.equal(env.delivery.deliveries.length, 0)
  for (const member of ['dsh', 'codex']) {
    await env.runtime.lifecycle({ member, identity: member === 'dsh' ? SESSION : THREAD, event: 'Stop', turnId: member === 'dsh' ? '1' : 'turn-1' })
    if (member === 'dsh') await env.runtime.lifecycle({ member, identity: SESSION, event: 'idle', turnId: '1' })
    assert.equal(env.runtime.bridge.getRoom(env.roomId).deliveryFlow[member].status, 'idle')
  }
})

test('DSH native pre-step and stopping events carry mail in the original agent', async (t) => {
  const env = await runtimePair(t)
  const handlers = new Map()
  const ctx = { on: (event, fn) => handlers.set(event, fn) }
  const dispose = installDshLifecycle(ctx, env.runtime, Promise.resolve())
  t.after(dispose)
  const steered = []
  const agent = { id: SESSION, steer: (input) => steered.push(input) }
  const controller = new AbortController()
  await env.call('dsh', { action: 'availability', status: 'busy' })
  await env.call('codex', { action: 'send', kind: 'review', body: 'Review during a long turn' })
  const original = { id: 'original', role: 'user', content: [] }
  const decision = await handlers.get('agent/pre-step')({ agent, turn: 1, step: 2, signal: controller.signal },
    async () => ({ kind: 'enter', messages: [original] }))
  assert.equal(decision.messages[0], original)
  assert.match(decision.messages[1].content[0].text, /Review during a long turn/)
  assert.equal(decision.messages[1].source.kind, 'agent-message')
  await env.call('codex', { action: 'send', kind: 'review', body: 'Review at stopping boundary' })
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: controller.signal })
  assert.equal(steered.length, 1)
  assert.match(steered[0].content[0].text, /Review at stopping boundary/)
  assert.equal(env.delivery.deliveries.length, 0)
  await handlers.get('agent/turn-stopping')({ agent, turn: 1, signal: controller.signal })
  assert.equal(steered.length, 1, 'empty stop must not steer a heartbeat')
  await handlers.get('agent/status')({ agent, status: 'idle' })
  assert.equal(env.runtime.bridge.getRoom(env.roomId).deliveryFlow.dsh.status, 'idle')
})

test('DSH inbox claimed event automatically releases only the actual native envelope wake', async (t) => {
  const env = await runtimePair(t)
  const handlers = new Map()
  const dispose = installDshLifecycle({ on: (name, fn) => handlers.set(name, fn) }, env.runtime, Promise.resolve())
  t.after(dispose)
  await env.call('codex', { action: 'send', kind: 'question', body: 'Native wake receipt' })
  const text = env.delivery.deliveries[0].text
  assert.ok(env.runtime.bridge.wakeFor('dsh', SESSION).pending)
  await handlers.get('agent/inbox/claimed')({ agent: { id: SESSION }, turn: 7, message: { content: [{ type: 'text', text }] } })
  assert.equal(env.runtime.bridge.wakeFor('dsh', SESSION).pending, null)
})

test('native mail appends to unfinished work without claiming it is handled or completing tasks', async (t) => {
  const env = await runtimePair(t)
  const first = await env.call('dsh', { action: 'send', kind: 'question', body: 'Original work' })
  const oldBatch = env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.batch.id
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Additional context' })
  const got = await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'PostToolUse', turnId: '1', eventId: 'a' })
  assert.equal(got.incoming.batchId, oldBatch)
  assert.equal(env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.batch.messageIds.length, 2)
  assert.equal(env.runtime.bridge.state.messages[first.message.id].handledAt, undefined)
  assert.equal(env.runtime.bridge.wakeFor('codex', THREAD).pending != null, true)
  await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'Stop', turnId: '1' })
  assert.equal(env.runtime.bridge.state.messages[first.message.id].handledAt, undefined)
  assert.ok(env.runtime.bridge.state.messages[first.message.id].turnEndedAt)
  assert.ok(env.runtime.bridge.wakeFor('codex', THREAD).pending, 'native completion cannot invent a wake receipt')
})

test('native running state overrides premature model idle and DSH stop races drain on real idle', async (t) => {
  const env = await runtimePair(t)
  await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'UserPromptSubmit', turnId: 'one' })
  await env.call('codex', { action: 'availability', status: 'idle' })
  const held = await env.call('dsh', { action: 'send', kind: 'review', body: 'Still executing despite model idle' })
  assert.equal(held.delivery.held, true)
  assert.equal(env.codex.queueCalls.length, 0)
  await env.runtime.lifecycle({ member: 'dsh', identity: SESSION, event: 'step', turnId: '1', eventId: 'step:1' })
  await env.runtime.lifecycle({ member: 'dsh', identity: SESSION, event: 'Stop', turnId: '1' })
  await env.call('codex', { action: 'send', kind: 'review', body: 'Raced with provisional stop' })
  assert.equal(env.delivery.deliveries.length, 0, 'provisional stop must not queue before true idle')
  await env.runtime.lifecycle({ member: 'dsh', identity: SESSION, event: 'idle', turnId: '1' })
  assert.equal(env.delivery.deliveries.length, 1)
  const wakeId = wakeIdFrom(env.delivery.deliveries[0].text)
  await env.runtime.lifecycle({ member: 'dsh', identity: SESSION, event: 'claimed', turnId: '2', wakeId })
  assert.equal(env.runtime.bridge.wakeFor('dsh', SESSION).pending, null, 'receipt in a new turn must ack before its first pre-step')
})

test('native events consume actual wake envelopes and ignore delayed and duplicate callbacks', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Waking input' })
  const wakeId = wakeIdFrom(env.codex.queueCalls[0].message)
  await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'UserPromptSubmit', turnId: 'one', wakeId })
  assert.equal(env.runtime.bridge.wakeFor('codex', THREAD).pending, null)
  await env.call('dsh', { action: 'send', kind: 'review', body: 'One inline update' })
  const event = { member: 'codex', identity: THREAD, event: 'PostToolUse', turnId: 'one', eventId: 'tool-a' }
  const [one, duplicate] = await Promise.all([env.runtime.lifecycle(event), env.runtime.lifecycle(event)])
  assert.ok(one.incoming)
  assert.equal(duplicate.ignored, 'duplicate_event')
  await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'UserPromptSubmit', turnId: 'two' })
  assert.equal((await env.runtime.lifecycle({ ...event, event: 'Stop' })).ignored, 'closed_turn')
  assert.equal(env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.status, 'busy')
})

test('an actual native wake receipt still clears its identity ledger after the room ended', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Queued before end' })
  const wakeId = wakeIdFrom(env.codex.queueCalls[0].message)
  await env.call('dsh', { action: 'end', summary: 'User ended the room' })
  await env.runtime.lifecycle({ member: 'codex', identity: THREAD, event: 'UserPromptSubmit', turnId: 'one', wakeId })
  assert.equal(env.runtime.bridge.wakeFor('codex', THREAD).pending, null)
})

test('interrupt and approval waits cannot be resumed by automatic stop or late tool callbacks', async (t) => {
  const env = await runtimePair(t)
  const event = { member: 'codex', identity: THREAD, turnId: 'one', eventId: 'approval-tool' }
  await env.runtime.lifecycle({ ...event, event: 'UserPromptSubmit' })
  await env.runtime.lifecycle({ ...event, event: 'PermissionRequest' })
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Waiting for user' })
  assert.equal((await env.runtime.lifecycle({ ...event, event: 'Stop' })).ignored, 'awaiting_user_or_interrupted')
  assert.match((await env.runtime.lifecycle({ ...event, event: 'PostToolUse' })).incoming.text, /Waiting for user/)
  await env.runtime.lifecycle({ ...event, event: 'Interrupt' })
  assert.equal((await env.runtime.lifecycle({ ...event, event: 'PostToolUse', eventId: 'later-tool' })).ignored, 'awaiting_user_or_interrupted')
  assert.equal((await env.runtime.lifecycle({ ...event, event: 'Stop' })).ignored, 'awaiting_user_or_interrupted')
  assert.equal(env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.status, 'busy')
  assert.equal(env.codex.queueCalls.length, 0)
})

test('DSH rejected steps, aborted turns and idle after a cancellation never create automatic mail', async (t) => {
  const env = await runtimePair(t)
  const handlers = new Map()
  const dispose = installDshLifecycle({ on: (event, fn) => handlers.set(event, fn) }, env.runtime, Promise.resolve())
  t.after(dispose)
  const controller = new AbortController()
  const agent = { id: SESSION, steer() { assert.fail('must not resume a cancelled agent') } }
  await env.call('dsh', { action: 'availability', status: 'busy' })
  await env.call('codex', { action: 'send', kind: 'review', body: 'Do not wake cancelled work' })
  const data = { agent, turn: 1, step: 1, signal: controller.signal }
  await handlers.get('agent/pre-step')(data, async () => ({ kind: 'reject' }))
  controller.abort()
  await handlers.get('agent/turn-stopping')(data)
  assert.equal(env.runtime.bridge.savedFor(env.runtime.bridge.getRoom(env.roomId), 'dsh').length, 1)
  assert.equal(env.delivery.deliveries.length, 0)
})

test('native boundaries honor paused rooms and restart preserves interrupted state', async (t) => {
  const env = await runtimePair(t)
  await env.call('codex', { action: 'availability', status: 'busy' })
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Held work' })
  await env.call('dsh', { action: 'pause', reason: 'User break' })
  const event = { member: 'codex', identity: THREAD, turnId: 'one' }
  const result = await env.runtime.lifecycle({ ...event, event: 'PostToolUse', eventId: 'a' })
  assert.equal(result.incoming, null)
  assert.equal(env.runtime.bridge.savedFor(env.runtime.bridge.getRoom(env.roomId), 'codex').length, 1)
  await env.runtime.lifecycle({ ...event, event: 'Interrupt' })
  await env.restart()
  assert.equal((await env.runtime.lifecycle({ ...event, event: 'Stop' })).ignored, 'awaiting_user_or_interrupted')
})

test('Codex hook HTTP path takes mail inline and only continues Stop when real mail exists', async (t) => {
  const env = await runtimePair(t)
  const input = { session_id: THREAD, turn_id: 'one', hook_event_name: 'UserPromptSubmit', prompt: 'ordinary user task' }
  const options = { hostFile: env.runtime.hostFile, timeoutMs: 5000 }
  await runHook(input, options)
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Inline hook mail' })
  const post = await runHook({ ...input, hook_event_name: 'PostToolUse', tool_use_id: 'a' }, options)
  assert.match(post.hookSpecificOutput.additionalContext, /Inline hook mail/)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Before stop mail' })
  const stop = await runHook({ ...input, hook_event_name: 'Stop', stop_hook_active: false }, options)
  assert.equal(stop.decision, 'block')
  assert.match(stop.reason, /Before stop mail/)
  assert.deepEqual(await runHook({ ...input, hook_event_name: 'Stop', stop_hook_active: true }, options), {})
  assert.equal(env.codex.queueCalls.length, 0)
})

test('checkpoint reads during one long client turn never reopen client wakes', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Start a long turn' })
  const room = env.runtime.bridge.getRoom(env.roomId)
  await env.call('codex', { action: 'availability', status: 'ready', batch_id: room.deliveryFlow.codex.batch?.id })
  await env.call('dsh', { action: 'send', kind: 'progress', body: 'Seen through bridge status before the queued envelope' })
  await env.call('codex', { action: 'status' })
  await env.call('codex', { action: 'availability', status: 'ready', batch_id: room.deliveryFlow.codex.batch?.id })
  await env.call('dsh', { action: 'send', kind: 'review', body: 'Another update in the same long turn' })
  assert.equal(env.codex.queueCalls.length, 1, 'reading and completing a bridge batch must not rearm the client queue')
})

for (const receiver of ['dsh', 'codex']) {
  test(`${receiver} cannot replace a client wake receipt with checkpoint or idle`, async (t) => {
    const env = await runtimePair(t)
    const sender = receiver === 'dsh' ? 'codex' : 'dsh'
    const calls = receiver === 'codex' ? env.codex.queueCalls : env.delivery.deliveries
    const envelope = () => receiver === 'codex' ? calls.at(-1).message : calls.at(-1).text
    const first = await env.call(sender, { action: 'send', kind: 'question', body: 'First client wake' })
    const oldWake = wakeIdFrom(envelope())
    const room = env.runtime.bridge.getRoom(env.roomId)
    const viewed = await env.call(receiver, { action: 'status' })
    assert.equal(JSON.stringify(viewed).includes(oldWake), false, 'bridge status must not reveal a receipt for an unconsumed UI input')
    await env.call(receiver, { action: 'checkpoint', batch_id: room.deliveryFlow[receiver].batch.id })
    assert.ok(env.runtime.bridge.state.messages[first.message.id].handledAt)
    await env.call(receiver, { action: 'availability', status: 'idle' })
    const later = await env.call(sender, { action: 'send', kind: 'review', body: 'Later work while first notification remains queued' })
    assert.equal(later.delivery.held, true)
    assert.equal(calls.length, 1)
    await assert.rejects(() => env.call(receiver, { action: 'ack_wake', wake_id: 'wake_wrong' }), /copy wake_id/)
    await assert.rejects(() => env.call(sender, { action: 'ack_wake', wake_id: oldWake }), /no matching/)
    // The real client has now dequeued the first envelope; its receipt is valid.
    await env.call(receiver, { action: 'ack_wake', wake_id: oldWake })
    const pulled = await env.call(receiver, { action: 'availability', status: 'idle' })
    assert.match(pulled.incoming.text, /Later work/)
    assert.equal(pulled.room.deliveryFlow[receiver].status, 'busy')
    assert.equal(calls.length, 1, 'work already waiting is returned directly, never re-queued')
    await env.call(receiver, { action: 'availability', status: 'idle', batch_id: pulled.incoming.batchId })
    await env.call(sender, { action: 'send', kind: 'question', body: 'New wake after actual receipt and idle' })
    assert.equal(calls.length, 2)
    const newWake = wakeIdFrom(envelope())
    assert.notEqual(newWake, oldWake)
    const retried = await env.call(receiver, { action: 'ack_wake', wake_id: oldWake })
    assert.equal(retried.duplicate, true)
    assert.equal(retried.pending, true, 'an old receipt cannot clear the new wake')
    assert.equal(env.runtime.bridge.wakeFor(receiver, receiver === 'codex' ? THREAD : SESSION).pending.id, newWake)
  })
}

test('consumed business batches keep their client wake gate across restart and room replacement', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Old room notification' })
  const wakeId = wakeIdFrom(env.codex.queueCalls[0].message)
  const room = env.runtime.bridge.getRoom(env.roomId)
  await env.call('codex', { action: 'checkpoint', batch_id: room.deliveryFlow.codex.batch.id })
  await env.restart()
  await env.call('dsh', { action: 'end', summary: 'Replace room, not recipient thread' })
  const created = await env.call('dsh', { action: 'create', goal: 'New room same thread', cwd: WORKDIR })
  await env.call('codex', { action: 'join', code: created.code, cwd: WORKDIR })
  const pending = await env.call('dsh', { action: 'send', kind: 'question', body: 'New room data' })
  assert.equal(pending.delivery.held, true)
  assert.equal(env.codex.queueCalls.length, 1)
  await env.call('codex', { action: 'ack_wake', wake_id: wakeId })
  const pulled = await env.call('codex', { action: 'checkpoint' })
  assert.match(pulled.incoming.text, /New room data/)
  assert.equal(env.codex.queueCalls.length, 1)
})

test('legacy client wakes need exact user-confirmed reconciliation, never an automatic checkpoint', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Legacy queue' })
  delete env.runtime.bridge.state.wakeProtocolVersion
  env.runtime.bridge.state.wakeLedger = {}
  await env.runtime.bridge.save()
  await env.restart()
  const status = await env.call('codex', { action: 'status' })
  assert.equal(status.room.pendingWake.codex.legacy, true)
  const ref = status.room.pendingWake.codex.reconciliationId
  await env.call('codex', { action: 'checkpoint', batch_id: status.room.deliveryFlow.codex.batch.id })
  await env.call('codex', { action: 'availability', status: 'idle' })
  await env.call('dsh', { action: 'send', kind: 'notice', body: 'Held after legacy ready' })
  assert.equal(env.codex.queueCalls.length, 1)
  await assert.rejects(() => env.call('codex', { action: 'ack_wake', reconcile_id: ref }), /direct user confirmation/)
  await assert.rejects(() => env.call('codex', { action: 'ack_wake', reconcile_id: 'wrong', user_confirmed: true }), /direct user confirmation/)
  const ack = await env.call('codex', { action: 'ack_wake', reconcile_id: ref, user_confirmed: true })
  assert.equal(ack.reconciled, true)
  const next = await env.call('codex', { action: 'checkpoint' })
  await env.call('codex', { action: 'availability', status: 'idle', batch_id: next.incoming.batchId })
  await env.call('dsh', { action: 'send', kind: 'question', body: 'New notification after reconciliation' })
  const newWake = wakeIdFrom(env.codex.queueCalls.at(-1).message)
  const repeated = await env.call('codex', { action: 'ack_wake', reconcile_id: ref, user_confirmed: true })
  assert.equal(repeated.duplicate, true)
  assert.equal(repeated.pending, true)
  assert.equal(env.runtime.bridge.wakeFor('codex', THREAD).pending.id, newWake)
})

test('control notifications use the same busy and pending-wake gates', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Pending original wake' })
  const room = env.runtime.bridge.getRoom(env.roomId)
  room.status = 'paused'
  room.pauseReason = 'wake_budget'
  await env.runtime.bridge.save()
  const request = await env.call('dsh', { action: 'budget_request', add_wakes: 1, reason: 'Control notice test' })
  const approved = await env.call('dsh', { action: 'budget_approve', request_id: request.request.id, user_confirmed: true })
  assert.equal(approved.notified.state, 'saved')
  assert.equal(env.codex.queueCalls.length, 1)
  const status = await env.call('codex', { action: 'status' })
  assert.equal(status.controlNotices.length, 1)
  assert.match(status.controlNotices[0].text, /已由用户在 DSH 会话批准/)
  const again = await env.call('codex', { action: 'status' })
  assert.equal(again.controlNotices.length, 0)
  assert.equal(env.codex.queueCalls.length, 1)
})

test('fast wake receipt and peer reply cannot be undone by a late transport acknowledgement', async (t) => {
  const codex = fakeCodex()
  let env
  codex.queue = async (args) => {
    codex.queueCalls.push(args)
    await env.call('codex', { action: 'ack_wake', wake_id: wakeIdFrom(args.message) })
    const room = env.runtime.bridge.getRoom(env.roomId)
    await env.runtime.bridge.sendMessage({ member: 'codex', identity: THREAD, kind: 'reply', body: 'Very fast receipt', replyTo: room.deliveryFlow.codex.batch.messageIds[0] })
    return { state: 'queued', detail: 'late queue acknowledgement' }
  }
  env = await runtimePair(t, {}, { codex })
  const sent = await env.call('dsh', { action: 'send', kind: 'question', body: 'Fast recipient' })
  assert.equal(sent.message.delivery.state, 'replied')
  assert.equal(env.runtime.bridge.wakeFor('codex', THREAD).pending, null)
  assert.equal(codex.queueCalls.length, 1)
})

test('uncertain wake outcomes stay held until actual receipt or exact user reconciliation', async (t) => {
  const codex = fakeCodex()
  codex.queue = async (args) => {
    codex.queueCalls.push(args)
    return { state: 'unknown', detail: 'connection lost after possible admission' }
  }
  const env = await runtimePair(t, {}, { codex })
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Uncertain admission' })
  const status = await env.call('codex', { action: 'status' })
  assert.equal(status.room.pendingWake.codex.state, 'unknown')
  await env.call('codex', { action: 'availability', status: 'idle', batch_id: status.room.deliveryFlow.codex.batch.id })
  await env.call('dsh', { action: 'send', kind: 'notice', body: 'Held while uncertain' })
  assert.equal(codex.queueCalls.length, 1)
  await assert.rejects(() => env.call('codex', { action: 'ack_wake', user_confirmed: true }), /copy wake_id/)
  const reconciled = await env.call('codex', {
    action: 'ack_wake', user_confirmed: true, reconcile_id: status.room.pendingWake.codex.reconciliationId,
  })
  assert.equal(reconciled.reconciled, true)
  const pulled = await env.call('codex', { action: 'checkpoint' })
  assert.match(pulled.incoming.text, /Held while uncertain/)
  assert.equal(codex.queueCalls.length, 1)
})

test('a stopped runtime cannot overwrite recovered wake state with a late transport result', async (t) => {
  const codex = fakeCodex()
  let settle
  codex.queue = (args) => {
    codex.queueCalls.push(args)
    return new Promise((resolve) => { settle = resolve })
  }
  const env = await runtimePair(t, { sendWaitMs: 10 }, { codex })
  const first = await env.call('dsh', { action: 'send', kind: 'question', body: 'Transport still in flight' })
  assert.equal(first.delivery_pending, true)
  await env.restart()
  const status = await env.call('codex', { action: 'status' })
  assert.equal(status.room.pendingWake.codex.state, 'unknown')
  await env.call('dsh', { action: 'send', kind: 'notice', body: 'Saved by the new runtime' })
  const before = await readFile(env.runtime.stateFile)
  settle({ state: 'queued', detail: 'late response to the stopped instance' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(await readFile(env.runtime.stateFile), before)
  assert.equal(codex.queueCalls.length, 1)
})

test('prompt context stays silent before the runtime has loaded state', () => {
  const runtime = makeRuntime({
    agents: fakeAgents,
    codex: fakeCodex(),
    delivery: fakeDelivery(),
    dir: path.join(os.tmpdir(), 'dsh-bridge-not-started'),
  })
  assert.equal(runtime.promptFor(SESSION), '')
  assert.deepEqual(runtime.listRooms(), [])
})

test('runtime drives create, join, send, reply and probe end to end', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-'))
  const codex = fakeCodex()
  const delivery = fakeDelivery()
  const runtime = makeRuntime({ agents: fakeAgents, codex, delivery, dir })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'create', goal: 'Ship the bridge', cwd: WORKDIR, scope: 'bridge only' },
  })
  assert.match(created.code, /^\d{6}$/)
  assert.equal(created.room.status, 'pairing')
  assert.equal(created.room.dshSessionId, SESSION)

  const joined = await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR },
  })
  assert.equal(joined.room.status, 'active')
  assert.equal(joined.room.codexThreadId, THREAD)

  const sent = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    meta: { callId: 'dsh-call-1' },
    args: { action: 'send', kind: 'question', body: 'Which transport?', client_message_id: 'dsh-call-1' },
  })
  assert.equal(sent.delivery.state, 'queued')
  assert.equal(sent.message.delivery.state, 'queued')
  assert.equal(codex.queueCalls.length, 1)
  assert.equal(codex.queueCalls[0].threadId, THREAD)
  assert.match(codex.queueCalls[0].message, /Which transport\?/)

  const duplicate = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    meta: { callId: 'dsh-call-1' },
    args: { action: 'send', kind: 'question', body: 'Which transport?', client_message_id: 'dsh-call-1' },
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(codex.queueCalls.length, 1)

  const inbox = await runtime.toolCall({ member: 'codex', identity: THREAD, args: { action: 'status' } })
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].id, sent.message.id)

  const reply = await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    meta: { callId: 'codex-call-1' },
    args: { action: 'send', kind: 'reply', reply_to: sent.message.id, body: 'stdio MCP' },
  })
  assert.equal(reply.delivery.state, 'queued')
  assert.equal(delivery.deliveries.length, 1)
  assert.match(delivery.deliveries[0].text, /stdio MCP/)

  await new Promise((resolve) => setTimeout(resolve, 60))
  const status = await runtime.toolCall({ member: 'dsh', identity: SESSION, args: { action: 'status' } })
  assert.equal(status.messages.length, 1)
  assert.equal(status.messages[0].delivery.state, 'processing')
  assert.equal(runtime.bridge.state.messages[sent.message.id].delivery.state, 'replied')
})

test('runtime records a budget request and only DSH can approve it', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-budget-'))
  const codex = fakeCodex()
  const delivery = fakeDelivery()
  const runtime = makeRuntime({ agents: fakeAgents, codex, delivery, dir })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'create', goal: 'Budget drill', cwd: WORKDIR },
  })
  const joined = await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR },
  })
  const room = runtime.bridge.getRoom(joined.room.id)
  room.status = 'paused'
  room.pauseReason = 'wake_budget'
  await runtime.bridge.save()

  const requested = await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'budget_request', add_wakes: 5, reason: 'need more cross-checks' },
  })
  assert.equal(requested.request.status, 'pending')
  assert.equal(requested.notified.state, 'queued')
  assert.match(delivery.deliveries.at(-1).text, /控制通知/)
  assert.match(delivery.deliveries.at(-1).text, /breq_/)
  assert.equal(runtime.bridge.getRoom(joined.room.id).budgets.maxWakes, 60)

  const approved = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'budget_approve', request_id: requested.request.id, user_confirmed: true },
  })
  assert.equal(approved.approved, true)
  assert.equal(runtime.bridge.getRoom(joined.room.id).status, 'active')
  assert.equal(runtime.bridge.getRoom(joined.room.id).budgets.maxWakes, 65)
  assert.match(codex.queueCalls.at(-1).message, /已由用户在 DSH 会话批准/)
})

test('runtime HTTP API requires the bearer token and a loopback Host', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-http-'))
  const runtime = makeRuntime({ agents: fakeAgents, codex: fakeCodex(), delivery: fakeDelivery(), dir })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const url = runtime.health().url
  const unauthorized = await fetch(`${url}/v1/health`)
  assert.equal(unauthorized.status, 401)

  const authorized = await fetch(`${url}/v1/health`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  })
  assert.equal(authorized.status, 200)
  const health = await authorized.json()
  assert.equal(health.ok, true)
  assert.equal(health.profile, 'test')

  const badHost = await new Promise((resolve, reject) => {
    const req = request(
      `${url}/v1/health`,
      { headers: { authorization: `Bearer ${runtime.token}`, host: 'evil.example' } },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode })
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(badHost.status, 403)

  const badAction = await fetch(`${url}/v1/tool`, {
    method: 'POST',
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ member: 'codex', identity: THREAD, args: { action: 'nope' } }),
  })
  assert.equal(badAction.status, 400)
  const payload = await badAction.json()
  assert.equal(payload.error.code, 'bad_action')
})

test('the MCP adapter learns the real thread id from call metadata', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-mcp-'))
  const runtime = makeRuntime({ agents: fakeAgents, codex: fakeCodex(), delivery: fakeDelivery(), dir })
  await runtime.start()
  const child = spawn(process.execPath, [ADAPTER], {
    env: { ...process.env, DSH_BRIDGE_HOST_FILE: runtime.hostFile },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(async () => {
    child.kill()
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const pending = new Map()
  let buffer = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })

  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out; stderr=${stderr}`)), 5_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const initialized = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  assert.equal(initialized.result.serverInfo.name, 'dsh-codex-bridge')
  const listed = await rpc(2, 'tools/list', {})
  assert.equal(listed.result.tools.length, 1)
  assert.equal(listed.result.tools[0].name, 'bridge')

  const who = await rpc(3, 'tools/call', {
    name: 'bridge',
    arguments: { action: 'create', goal: 'MCP transport check', cwd: WORKDIR },
    _meta: { threadId: THREAD, callId: 'mcp-call-1' },
  })
  assert.equal(who.result.isError, undefined, JSON.stringify(who.result))
  const payload = JSON.parse(who.result.content[0].text)
  assert.equal(payload.identity, THREAD)
  assert.equal(payload.room.codexThreadId, THREAD)
  assert.match(payload.code, /^\d{6}$/)
})

test('the codex outbox holds new messages and delivers them as one digest', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-digest-'))
  const codex = fakeCodex()
  const runtime = makeRuntime({
    agents: fakeAgents,
    codex,
    delivery: fakeDelivery(),
    dir,
    overrides: { wakeHoldMs: 60_000, digestMaxMessages: 20 },
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'create', goal: 'Digest drill', cwd: WORKDIR },
  })
  await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR },
  })

  const first = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'send', kind: 'progress', body: 'CHECKPOINT-ONE' },
  })
  assert.equal(first.delivery.state, 'queued')
  assert.equal(codex.queueCalls.length, 1)

  const second = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'send', kind: 'progress', body: 'CHECKPOINT-TWO' },
  })
  assert.equal(second.delivery.state, 'saved')
  assert.equal(second.delivery.held, true)
  const third = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'send', kind: 'progress', body: 'CHECKPOINT-THREE' },
  })
  assert.equal(third.delivery.held, true)
  assert.equal(codex.queueCalls.length, 1)

  const ack = await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'send', kind: 'reply', reply_to: first.message.id, body: 'ACK, first batch received' },
  })
  assert.equal(ack.delivery.state, 'queued')

  assert.equal(codex.queueCalls.length, 1, 'a reply is not readiness for the next batch')
  const batchId = runtime.bridge.getRoom(created.room.id).deliveryFlow.codex.batch.id
  const pulled = await runtime.toolCall({ member: 'codex', identity: THREAD,
    args: { action: 'availability', status: 'ready', batch_id: batchId } })
  assert.equal(codex.queueCalls.length, 1, 'checkpoint delivery must not add a client queue entry')
  const digest = pulled.incoming.text
  assert.match(digest, /合并投递 2 条/)
  assert.match(digest, /CHECKPOINT-TWO/)
  assert.match(digest, /CHECKPOINT-THREE/)
  assert.doesNotMatch(digest, /CHECKPOINT-ONE/)
  assert.equal(runtime.bridge.state.messages[first.message.id].delivery.state, 'replied')
  assert.equal(runtime.bridge.state.messages[second.message.id].delivery.state, 'processing')
  assert.equal(runtime.bridge.state.messages[third.message.id].delivery.state, 'processing')
})

test('the outbox waits until the earlier codex batch is no longer queued', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-gate-'))
  const codex = fakeCodex()
  const runtime = makeRuntime({
    agents: fakeAgents,
    codex,
    delivery: fakeDelivery(),
    dir,
    overrides: { wakeHoldMs: 60_000, digestMaxMessages: 20 },
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'create', goal: 'Gate drill', cwd: WORKDIR },
  })
  await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR },
  })

  const first = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'send', kind: 'progress', body: 'FIRST-BATCH' },
  })
  const second = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'send', kind: 'progress', body: 'SECOND-BATCH' },
  })
  assert.equal(first.delivery.state, 'queued')
  assert.equal(second.delivery.held, true)
  assert.equal(codex.queueCalls.length, 1)

  // A progress note is not proof that the earlier work finished.
  await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'send', kind: 'progress', body: 'still working on the first batch' },
  })
  assert.equal(codex.queueCalls.length, 1)
  assert.equal(runtime.bridge.state.messages[second.message.id].delivery.state, 'saved')

  // Even a linked receipt reply does not grant another wake.
  await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'send', kind: 'reply', reply_to: first.message.id, body: 'received, still working' },
  })
  assert.equal(codex.queueCalls.length, 1)
  const batchId = runtime.bridge.getRoom(created.room.id).deliveryFlow.codex.batch.id
  const pulled = await runtime.toolCall({ member: 'codex', identity: THREAD,
    args: { action: 'availability', status: 'ready', batch_id: batchId } })
  assert.equal(codex.queueCalls.length, 1)
  assert.match(pulled.incoming.text, /SECOND-BATCH/)
  assert.equal(runtime.bridge.state.messages[second.message.id].delivery.state, 'processing')
})

test('runtime handoff moves both bindings without losing the room', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-handoff-'))
  const codex = fakeCodex()
  const runtime = makeRuntime({ agents: fakeAgents, codex, delivery: fakeDelivery(), dir })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const created = await runtime.toolCall({
    member: 'dsh',
    identity: SESSION,
    args: { action: 'create', goal: 'Handoff drill', cwd: WORKDIR },
  })
  await runtime.toolCall({
    member: 'codex',
    identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR },
  })

  const newSession = 'session-handoff-0001'
  const adopted = await runtime.toolCall({
    member: 'dsh',
    identity: newSession,
    args: { action: 'adopt', room_id: created.room.id, user_confirmed: true },
  })
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.previous, SESSION)
  assert.match(runtime.promptFor(newSession), /Handoff drill/)
  assert.equal(runtime.promptFor(SESSION), '')

  const issued = await runtime.toolCall({
    member: 'dsh',
    identity: newSession,
    args: { action: 'handoff_code', room_id: created.room.id, ttl_minutes: 10 },
  })
  assert.match(issued.code, /^\d{6}$/)

  const newThread = '00000000-0000-4000-8000-000000000009'
  const rebound = await runtime.toolCall({
    member: 'codex',
    identity: newThread,
    args: { action: 'rebind', room_id: created.room.id, code: issued.code },
  })
  assert.equal(rebound.rebound, true)
  assert.equal(rebound.previous, THREAD)
  assert.equal(runtime.bridge.getRoom(created.room.id).dshSessionId, newSession)
  assert.equal(runtime.bridge.getRoom(created.room.id).codexThreadId, newThread)
})

test('an unfinished peer batch never gains another queued wake just because time passes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-backpressure-'))
  const codex = fakeCodex()
  const runtime = makeRuntime({
    agents: fakeAgents, codex, delivery: fakeDelivery(), dir,
    overrides: { wakeHoldMs: 10 },
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop()
    await rm(dir, { recursive: true, force: true })
  })
  const created = await runtime.toolCall({ member: 'dsh', identity: SESSION,
    args: { action: 'create', goal: 'Finish current work before another wake', cwd: WORKDIR } })
  await runtime.toolCall({ member: 'codex', identity: THREAD,
    args: { action: 'join', code: created.code, cwd: WORKDIR } })
  const first = await runtime.toolCall({ member: 'dsh', identity: SESSION,
    args: { action: 'send', kind: 'task_offer', body: 'Long-running work' } })
  const second = await runtime.toolCall({ member: 'dsh', identity: SESSION,
    args: { action: 'send', kind: 'progress', body: 'Additional context' } })
  // More than the old four hold windows, with no evidence of task completion.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(codex.queueCalls.length, 1, 'unfinished work must keep later messages in the bridge outbox')
  assert.equal(runtime.bridge.state.messages[first.message.id].delivery.state, 'queued')
  assert.equal(runtime.bridge.state.messages[second.message.id].delivery.state, 'saved')
})

for (const receiver of ['dsh', 'codex']) {
  test(`${receiver} pulls bounded batches at checkpoints without adding client wakes`, async (t) => {
    const env = await runtimePair(t, { digestMaxMessages: 2 })
    const sender = receiver === 'dsh' ? 'codex' : 'dsh'
    await env.call(receiver, { action: 'availability', status: 'busy' })
    for (let i = 1; i <= 3; i++) {
      const sent = await env.call(sender, { action: 'send', kind: 'question', body: `ITEM-${i}` })
      assert.equal(sent.delivery.held, true)
    }
    const first = await env.call(receiver, { action: 'availability', status: 'ready' })
    assert.equal(first.incoming.count, 2)
    assert.match(first.incoming.text, /合并投递 2 条/)
    assert.equal(first.room.deliveryFlow[receiver].status, 'busy')
    const second = await env.call(receiver, {
      action: 'availability', status: 'ready', batch_id: first.incoming.batchId,
    })
    assert.equal(second.incoming.count, 1)
    assert.match(second.incoming.text, /ITEM-3/)
    const retried = await env.call(receiver, {
      action: 'availability', status: 'ready', batch_id: first.incoming.batchId,
    })
    assert.equal(retried.duplicate, true)
    assert.equal(retried.incoming.batchId, second.incoming.batchId)
    assert.equal(retried.incoming.replayed, true)
    await assert.rejects(() => env.call(sender, {
      action: 'availability', status: 'ready', batch_id: second.incoming.batchId,
    }), /current batch_id/)
    const last = await env.call(receiver, {
      action: 'availability', status: 'ready', batch_id: second.incoming.batchId,
    })
    assert.equal(last.incoming, null)
    assert.equal(last.room.deliveryFlow[receiver].status, 'busy')
    await assert.rejects(() => env.call(receiver, {
      action: 'availability', status: 'ready', batch_id: first.incoming.batchId,
    }), /current batch_id/)
    assert.equal(env.codex.queueCalls.length, 0)
    assert.equal(env.delivery.deliveries.length, 0)
  })
}

test('DSH processing and a receipt reply still hold its next batch', async (t) => {
  const env = await runtimePair(t)
  const first = await env.call('codex', { action: 'send', kind: 'question', body: 'Long DSH task' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(env.runtime.bridge.state.messages[first.message.id].delivery.state, 'processing')
  await env.call('dsh', { action: 'send', kind: 'reply', reply_to: first.message.id, body: 'Received, still executing' })
  const second = await env.call('codex', { action: 'send', kind: 'notice', body: 'Later DSH work' })
  assert.equal(second.delivery.held, true)
  assert.equal(env.delivery.deliveries.length, 1)
  const batchId = env.runtime.bridge.getRoom(env.roomId).deliveryFlow.dsh.batch.id
  const next = await env.call('dsh', { action: 'availability', status: 'ready', batch_id: batchId })
  assert.match(next.incoming.text, /Later DSH work/)
  assert.equal(env.delivery.deliveries.length, 1)
})

test('restart and read-only status do not clear an unresolved recipient batch', async (t) => {
  const env = await runtimePair(t)
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Already queued before restart' })
  const oldBatch = env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.batch.id
  await env.restart()
  const status = await env.call('codex', { action: 'status' })
  assert.equal(status.room.deliveryFlow.codex.batch.id, oldBatch)
  const later = await env.call('dsh', { action: 'send', kind: 'notice', body: 'New after restart' })
  assert.equal(later.delivery.held, true)
  assert.equal(env.codex.queueCalls.length, 1)
  const next = await env.call('codex', { action: 'availability', status: 'ready', batch_id: oldBatch })
  assert.match(next.incoming.text, /New after restart/)
  assert.doesNotMatch(next.incoming.text, /Already queued before restart/)
  assert.equal(env.codex.queueCalls.length, 1)
})

test('paused rooms can record readiness without delivering saved work or resetting budgets', async (t) => {
  const env = await runtimePair(t)
  await env.call('codex', { action: 'availability', status: 'busy' })
  await env.call('dsh', { action: 'send', kind: 'question', body: 'Saved work' })
  await env.call('dsh', { action: 'pause', reason: 'User requested a break' })
  const ready = await env.call('codex', { action: 'availability', status: 'ready' })
  assert.equal(ready.room.status, 'paused')
  assert.equal(ready.incoming, null)
  assert.equal(env.codex.queueCalls.length, 0)
  assert.equal(ready.room.budgets.usedWakes, 1)
})

test('legacy unknown delivery migrates to a durable held batch without replay', async (t) => {
  const env = await runtimePair(t)
  const first = await env.call('dsh', { action: 'send', kind: 'question', body: 'Legacy queued work' })
  const room = env.runtime.bridge.getRoom(env.roomId)
  delete room.deliveryFlow
  env.runtime.bridge.state.messages[first.message.id].delivery.state = 'unknown'
  await env.runtime.bridge.save()
  await env.restart()
  const batch = env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.batch
  assert.equal(batch.recovered, true)
  await env.restart()
  assert.equal(env.runtime.bridge.getRoom(env.roomId).deliveryFlow.codex.batch.id, batch.id)
  const later = await env.call('dsh', { action: 'send', kind: 'notice', body: 'Legacy later work' })
  assert.equal(later.delivery.held, true)
  assert.equal(env.codex.queueCalls.length, 1)
})

test('CLI status never writes a legacy state snapshot back to the live Host file', async (t) => {
  const env = await runtimePair(t)
  delete env.runtime.bridge.getRoom(env.roomId).deliveryFlow
  await env.runtime.bridge.save()
  await env.runtime.stop()
  const before = await readFile(env.runtime.stateFile)
  const cli = fileURLToPath(new URL('../bin/dsh-bridge.js', import.meta.url))
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'status'], {
      env: { ...process.env, DSH_HOME: env.runtime.dshHome, DSH_PROFILE: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5_000,
    })
    child.stdout.resume()
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`CLI failed: ${stderr}`)))
  })
  assert.deepEqual(await readFile(env.runtime.stateFile), before)
})
