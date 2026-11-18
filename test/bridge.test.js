import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/core/bridge.js'
import { SESSION, THREAD, WORKDIR, makeBridge, paired } from '../support/helpers.js'

test('pairing binds the two real ids and hides the code hash', async () => {
  const { bridge, room } = await paired()
  assert.equal(room.status, 'active')
  assert.match(room.id, /^room_/)
  assert.equal(room.dshSessionId, SESSION)
  assert.equal(room.codexThreadId, THREAD)
  assert.equal(room.viewer, 'codex')
  assert.equal(bridge.roomView(bridge.getRoom(room.id), 'dsh').viewer, 'dsh')
  assert.equal(room.codeHash, undefined)
  assert.equal(room.codeSalt, undefined)

  const raw = bridge.getRoom(room.id)
  assert.equal(raw.codeHash, null)
  assert.equal(raw.members.dsh.id, SESSION)
  assert.equal(raw.members.codex.id, THREAD)
})

test('a wrong or absent pairing code never binds a session', async () => {
  const { bridge } = await makeBridge()
  await assert.rejects(
    () => bridge.joinRoom({ member: 'codex', identity: THREAD, code: '123456' }),
    /does not match any waiting room/,
  )

  const created = await bridge.createRoom({ member: 'dsh', identity: SESSION, goal: 'g', cwd: WORKDIR })
  const wrong = created.code === '000000' ? '000001' : '000000'
  await assert.rejects(
    () => bridge.joinRoom({ member: 'codex', identity: THREAD, code: wrong }),
    /does not match any waiting room/,
  )
  await assert.rejects(
    () => bridge.joinRoom({ member: 'codex', identity: THREAD, code: 'not-a-code' }),
    /six digits/,
  )
  assert.equal(bridge.getRoom(created.room.id).status, 'pairing')
})

test('join rejects a working directory that differs from the declaration', async () => {
  const { bridge } = await makeBridge()
  const created = await bridge.createRoom({ member: 'dsh', identity: SESSION, goal: 'g', cwd: WORKDIR })
  await assert.rejects(
    () => bridge.joinRoom({ member: 'codex', identity: THREAD, code: created.code, cwd: 'D:/other' }),
    /declares working directory/,
  )
})

test('one session cannot open two rooms', async () => {
  const { bridge } = await paired()
  await assert.rejects(
    () => bridge.createRoom({ member: 'dsh', identity: SESSION, goal: 'second', cwd: WORKDIR }),
    /already belongs to room/,
  )
})

test('send, unread status, reply linkage and no self-send', async () => {
  const { bridge, room } = await paired()
  const sent = await bridge.sendMessage({
    member: 'dsh',
    identity: SESSION,
    kind: 'question',
    body: 'Which transport should the adapter use?',
  })
  assert.equal(sent.message.seq, 1)
  assert.equal(sent.message.from, 'dsh')
  assert.equal(sent.message.to, 'codex')
  assert.equal(sent.message.delivery.state, 'saved')

  const codexView = bridge.roomView(bridge.getRoom(room.id), 'codex')
  assert.equal(codexView.unread, 1)

  const inbox = await bridge.status({ member: 'codex', identity: THREAD })
  assert.equal(inbox.messages.length, 1)
  assert.equal(inbox.messages[0].id, sent.message.id)

  const reply = await bridge.sendMessage({
    member: 'codex',
    identity: THREAD,
    kind: 'reply',
    replyTo: sent.message.id,
    body: 'Use a small stdio MCP adapter.',
  })
  assert.equal(reply.message.hop, 1)
  assert.equal(bridge.state.messages[sent.message.id].delivery.state, 'replied')
  assert.equal(bridge.state.messages[sent.message.id].repliedBy, reply.message.id)

  const dshInbox = await bridge.status({ member: 'dsh', identity: SESSION })
  assert.equal(dshInbox.messages.length, 1)
  assert.equal(dshInbox.messages[0].id, reply.message.id)
  assert.equal(dshInbox.room.unread, 0, 'status marks the returned increment as seen')

  await assert.rejects(
    () => bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'x', to: 'dsh' }),
    /cannot send a collaboration message to itself/,
  )
  await assert.rejects(
    () => bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'gossip', body: 'x' }),
    /unknown message kind/,
  )
  await assert.rejects(
    () => bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: '   ' }),
    /must not be empty/,
  )
})

test('reply_to must reference a peer message', async () => {
  const { bridge } = await paired()
  const own = await bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'mine' })
  await assert.rejects(
    () => bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'reply', body: 'x', replyTo: own.message.id }),
    /must reference a message from the peer/,
  )
})

test('client_message_id makes retries idempotent', async () => {
  const { bridge } = await paired()
  const first = await bridge.sendMessage({
    member: 'dsh',
    identity: SESSION,
    kind: 'notice',
    body: 'once',
    clientMessageId: 'call-1',
  })
  const second = await bridge.sendMessage({
    member: 'dsh',
    identity: SESSION,
    kind: 'notice',
    body: 'once',
    clientMessageId: 'call-1',
  })
  assert.equal(second.duplicate, true)
  assert.equal(second.message.id, first.message.id)
  assert.equal(bridge.getRoom(first.room.id).seq, 1)
})

test('hop budget pauses the room and records the skipped message', async () => {
  const { bridge } = await paired({ budgets: { maxHops: 2 } })
  const one = await bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'question', body: 'q1' })
  const two = await bridge.sendMessage({
    member: 'codex',
    identity: THREAD,
    kind: 'reply',
    body: 'a1',
    replyTo: one.message.id,
  })
  const three = await bridge.sendMessage({
    member: 'dsh',
    identity: SESSION,
    kind: 'reply',
    body: 'q2',
    replyTo: two.message.id,
  })
  assert.equal(three.paused, true)
  assert.equal(three.pauseReason, 'hop_budget')
  assert.equal(three.message.delivery.state, 'skipped')
  assert.equal(three.room.status, 'paused')
  await assert.rejects(
    () => bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'reply', body: 'again' }),
    /is paused/,
  )
})

test('wake and time budgets also pause instead of looping', async () => {
  const wakes = await paired({ budgets: { maxWakes: 1 } })
  await wakes.bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'one' })
  const blocked = await wakes.bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'two' })
  assert.equal(blocked.pauseReason, 'wake_budget')

  const timed = await paired({ budgets: { maxMinutes: 1 } })
  timed.clock.advance(61_000)
  const expired = await timed.bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'late' })
  assert.equal(expired.pauseReason, 'time_budget')
})

test('task proposal is not ownership until the assignee accepts', async () => {
  const { bridge } = await paired()
  const created = await bridge.taskAction({
    member: 'dsh',
    identity: SESSION,
    taskAction: 'create',
    title: 'Write the MCP adapter',
    acceptance: 'MCP initialize/tools/call works over stdio',
    owner: 'codex',
    writeScopes: [WORKDIR],
  })
  assert.equal(created.task.status, 'proposed')
  assert.equal(created.task.owner, 'codex')

  await assert.rejects(
    () => bridge.taskAction({ member: 'dsh', identity: SESSION, taskAction: 'accept', taskId: created.task.id }),
    /only the assignee can accept/,
  )

  const accepted = await bridge.taskAction({
    member: 'codex',
    identity: THREAD,
    taskAction: 'accept',
    taskId: created.task.id,
  })
  assert.equal(accepted.task.status, 'claimed')

  const started = await bridge.taskAction({
    member: 'codex',
    identity: THREAD,
    taskAction: 'start',
    taskId: created.task.id,
  })
  assert.equal(started.task.status, 'in_progress')

  const done = await bridge.taskAction({
    member: 'codex',
    identity: THREAD,
    taskAction: 'complete',
    taskId: created.task.id,
    note: 'adapter merged',
  })
  assert.equal(done.task.status, 'done')
  assert.equal(done.task.completionNote, 'adapter merged')
})

test('task updates use revision CAS and enforce the declared write scope', async () => {
  const { bridge } = await paired()
  const created = await bridge.taskAction({
    member: 'dsh',
    identity: SESSION,
    taskAction: 'create',
    title: 'Change one file',
  })
  assert.equal(created.task.status, 'open')

  const updated = await bridge.taskAction({
    member: 'dsh',
    identity: SESSION,
    taskAction: 'update',
    taskId: created.task.id,
    revision: 1,
    details: 'only this file',
    blocked: true,
    blockedReason: 'waiting for the interface decision',
  })
  assert.equal(updated.task.revision, 2)
  assert.equal(updated.task.blocked, true)

  await assert.rejects(
    () =>
      bridge.taskAction({
        member: 'dsh',
        identity: SESSION,
        taskAction: 'update',
        taskId: created.task.id,
        revision: 1,
        details: 'stale write',
      }),
    /revision is 2/,
  )

  await assert.rejects(
    () =>
      bridge.taskAction({
        member: 'dsh',
        identity: SESSION,
        taskAction: 'create',
        title: 'escape',
        writeScopes: ['C:/Windows'],
      }),
    /outside the room's declared scope/,
  )
})

test('decisions require matching confirmations; disagreement is a conflict', async () => {
  const { bridge } = await paired()
  const proposed = await bridge.decisionAction({
    member: 'dsh',
    identity: SESSION,
    decisionAction: 'propose',
    question: 'Which state store?',
    options: ['JSON file', 'SQLite'],
  })
  assert.equal(proposed.decision.status, 'proposed')

  const first = await bridge.decisionAction({
    member: 'dsh',
    identity: SESSION,
    decisionAction: 'confirm',
    decisionId: proposed.decision.id,
    choice: 'JSON file',
  })
  assert.equal(first.decision.status, 'proposed')

  const conflicted = await bridge.decisionAction({
    member: 'codex',
    identity: THREAD,
    decisionAction: 'confirm',
    decisionId: proposed.decision.id,
    choice: 'SQLite',
  })
  assert.equal(conflicted.decision.status, 'conflict')
  assert.deepEqual(conflicted.decision.conflict, { dsh: 'JSON file', codex: 'SQLite' })

  const agreed = await bridge.decisionAction({
    member: 'dsh',
    identity: SESSION,
    decisionAction: 'propose',
    question: 'Envelope language?',
    options: ['Bilingual', 'English only'],
  })
  await bridge.decisionAction({
    member: 'codex',
    identity: THREAD,
    decisionAction: 'confirm',
    decisionId: agreed.decision.id,
    choice: 'Bilingual',
  })
  const confirmed = await bridge.decisionAction({
    member: 'dsh',
    identity: SESSION,
    decisionAction: 'confirm',
    decisionId: agreed.decision.id,
    choice: 'Bilingual',
  })
  assert.equal(confirmed.decision.status, 'confirmed')
  assert.equal(confirmed.decision.outcome, 'Bilingual')

  await assert.rejects(
    () =>
      bridge.decisionAction({
        member: 'dsh',
        identity: SESSION,
        decisionAction: 'confirm',
        decisionId: agreed.decision.id,
        choice: 'Bilingual',
      }),
    /already confirmed/,
  )
})

test('decision options must be distinct strings', async () => {
  const { bridge } = await paired()
  await assert.rejects(
    () =>
      bridge.decisionAction({
        member: 'dsh',
        identity: SESSION,
        decisionAction: 'propose',
        question: 'object options?',
        options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }],
      }),
    /must be a string/,
  )
  await assert.rejects(
    () =>
      bridge.decisionAction({
        member: 'dsh',
        identity: SESSION,
        decisionAction: 'propose',
        question: 'duplicate options?',
        options: ['A', 'A'],
      }),
    /must be distinct/,
  )
})

test('pause stops delivery, resume restores it, end and leave close the room', async () => {
  const { bridge, room } = await paired()
  await bridge.pauseRoom({ member: 'dsh', identity: SESSION, reason: 'user asked' })
  await assert.rejects(
    () => bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'while paused' }),
    /is paused/,
  )
  await bridge.resumeRoom({ member: 'codex', identity: THREAD })
  const sent = await bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'resumed' })
  assert.equal(sent.message.delivery.state, 'saved')

  await bridge.endRoom({ member: 'codex', identity: THREAD, summary: 'done' })
  assert.equal(bridge.roomView(bridge.getRoom(room.id), 'dsh').status, 'ended')

  const other = await paired()
  await other.bridge.leaveRoom({ member: 'codex', identity: THREAD })
  const left = other.bridge.getRoom(other.room.id)
  assert.equal(left.status, 'ended')
  assert.equal(left.codexThreadId, null)
  await assert.rejects(
    () => other.bridge.sendMessage({ member: 'codex', identity: THREAD, kind: 'notice', body: 'x' }),
    /not in an active bridge room/,
  )
})

test('recover marks in-flight deliveries unknown and expires pairing rooms', async () => {
  const { bridge, store, clock } = await paired()
  const sent = await bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'maybe delivered' })
  await bridge.markDelivery({ roomId: sent.room.id, messageId: sent.message.id, state: 'queued', detail: 'ack' })

  const reopened = new Bridge({ store, clock: () => clock.now })
  await reopened.init()
  const recovery = await reopened.recover()
  assert.equal(recovery.changed, 1)
  assert.equal(reopened.state.messages[sent.message.id].delivery.state, 'unknown')

  const waiting = await makeBridge()
  const created = await waiting.bridge.createRoom({ member: 'dsh', identity: SESSION, goal: 'g', cwd: WORKDIR })
  waiting.clock.advance(31 * 60_000)
  await assert.rejects(
    () => waiting.bridge.joinRoom({ member: 'codex', identity: THREAD, code: created.code }),
    /expired/,
  )
  const expired = await waiting.bridge.recover()
  assert.equal(expired.changed, 1)
  assert.equal(waiting.bridge.getRoom(created.room.id).pauseReason, 'pairing_expired')
})

test('rooms never leak messages across pairings', async () => {
  const first = await paired()
  const second = await makeBridge()
  const created = await second.bridge.createRoom({
    member: 'dsh',
    identity: 'session-other-0002',
    goal: 'second goal',
    cwd: WORKDIR,
  })
  const otherThread = '00000000-0000-4000-8000-000000000002'
  await second.bridge.joinRoom({ member: 'codex', identity: otherThread, code: created.code, cwd: WORKDIR })

  await first.bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'room one only' })
  const secondInbox = await second.bridge.status({ member: 'codex', identity: otherThread })
  assert.equal(secondInbox.messages.length, 0)
  assert.equal(secondInbox.room.id, created.room.id)

  const view = second.bridge.roomView(second.bridge.getRoom(created.room.id), 'codex')
  assert.equal(view.unread, 0)
})

async function budgetPaused(options = {}) {
  const env = await paired(options)
  const room = env.bridge.getRoom(env.room.id)
  room.status = 'paused'
  room.pauseReason = 'wake_budget'
  room.pausedBy = 'system'
  await env.bridge.save()
  return env
}

test('budget requests wait for an explicit DSH approval with user confirmation', async () => {
  const { bridge, room } = await budgetPaused()
  const requested = await bridge.requestBudget({
    member: 'codex',
    identity: THREAD,
    addWakes: 20,
    addMinutes: 30,
    reason: '需要继续交换验收证据',
  })
  assert.equal(requested.existing, false)
  assert.equal(requested.request.status, 'pending')
  assert.equal(requested.request.requestedBy, 'codex')
  assert.equal(bridge.roomView(bridge.getRoom(room.id), 'dsh').budgetRequests.length, 1)

  await assert.rejects(
    () =>
      bridge.decideBudget({
        member: 'codex',
        identity: THREAD,
        requestId: requested.request.id,
        approve: true,
        userConfirmed: true,
      }),
    /only the DSH member/,
  )
  await assert.rejects(
    () =>
      bridge.decideBudget({
        member: 'dsh',
        identity: SESSION,
        requestId: requested.request.id,
        approve: true,
        userConfirmed: false,
      }),
    /user_confirmed/,
  )

  const approved = await bridge.decideBudget({
    member: 'dsh',
    identity: SESSION,
    requestId: requested.request.id,
    approve: true,
    userConfirmed: true,
  })
  assert.equal(approved.approved, true)
  const after = bridge.getRoom(room.id)
  assert.equal(after.status, 'active')
  assert.equal(after.pauseReason, null)
  assert.equal(after.budgets.maxWakes, 80)
  assert.equal(after.budgets.maxMinutes, 150)
  assert.equal(bridge.roomView(after, 'dsh').budgetRequests.length, 0)
})

test('a budget pause cannot be bypassed with resume, and rejection keeps it paused', async () => {
  const { bridge, room } = await budgetPaused()
  await assert.rejects(
    () => bridge.resumeRoom({ member: 'dsh', identity: SESSION, resetBudget: true }),
    /approved budget request/,
  )

  const requested = await bridge.requestBudget({
    member: 'dsh',
    identity: SESSION,
    addWakes: 10,
    reason: '继续检查',
  })
  const rejected = await bridge.decideBudget({
    member: 'dsh',
    identity: SESSION,
    requestId: requested.request.id,
    approve: false,
    note: '用户暂不追加',
  })
  assert.equal(rejected.approved, false)
  assert.equal(bridge.getRoom(room.id).status, 'paused')
  assert.equal(bridge.roomView(bridge.getRoom(room.id), 'dsh').budgetRequests.length, 0)
})

test('budget requests are rejected unless the room is paused for a budget reason', async () => {
  const { bridge, room } = await paired()
  await assert.rejects(
    () => bridge.requestBudget({ member: 'dsh', identity: SESSION, addWakes: 5, reason: 'x' }),
    /budget reason/,
  )

  const raw = bridge.getRoom(room.id)
  raw.status = 'paused'
  raw.pauseReason = 'paused_by_user'
  await bridge.save()
  await assert.rejects(
    () => bridge.requestBudget({ member: 'dsh', identity: SESSION, addWakes: 5, reason: 'x' }),
    /budget reason/,
  )
})

test('a new DSH session adopts the room and keeps history', async () => {
  const { bridge, room } = await paired()
  await bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'before handoff' })
  const next = 'session-new-0002'

  await assert.rejects(
    () => bridge.adoptRoom({ member: 'dsh', identity: next, roomId: room.id, userConfirmed: false }),
    /user_confirmed/,
  )
  await assert.rejects(
    () => bridge.adoptRoom({ member: 'dsh', identity: next, roomId: room.id, userConfirmed: true, oldAttached: true }),
    /still attached/,
  )

  const adopted = await bridge.adoptRoom({
    member: 'dsh',
    identity: next,
    roomId: room.id,
    userConfirmed: true,
    oldAttached: true,
    force: true,
    reason: '上下文已满',
  })
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.previous, SESSION)
  assert.equal(bridge.getRoom(room.id).dshSessionId, next)
  assert.equal(bridge.getRoom(room.id).handoffs.length, 1)
  assert.equal(adopted.brief.recentMessages.at(-1).body, 'before handoff')

  await assert.rejects(() => bridge.status({ member: 'dsh', identity: SESSION }), /not in an active/)
  const inbox = await bridge.status({ member: 'codex', identity: THREAD })
  assert.equal(inbox.messages.length, 1)
})

test('a one-time handoff code lets a new Codex thread rebind', async () => {
  const { bridge, room, clock } = await paired()
  const issued = await bridge.issueHandoffCode({ member: 'dsh', identity: SESSION, roomId: room.id })
  assert.match(issued.code, /^\d{6}$/)
  assert.equal(issued.role, 'codex')
  assert.equal(bridge.roomView(bridge.getRoom(room.id), 'dsh').handoffPending, true)

  await assert.rejects(
    () => bridge.issueHandoffCode({ member: 'codex', identity: THREAD, roomId: room.id }),
    /only the DSH member/,
  )

  const nextThread = '00000000-0000-4000-8000-000000000002'
  await assert.rejects(
    () => bridge.redeemHandoffCode({ member: 'codex', identity: nextThread, roomId: room.id, code: '000000' }),
    /does not match/,
  )
  const rebound = await bridge.redeemHandoffCode({
    member: 'codex',
    identity: nextThread,
    roomId: room.id,
    code: issued.code,
    reason: '新线程接管',
  })
  assert.equal(rebound.rebound, true)
  assert.equal(rebound.previous, THREAD)
  assert.equal(bridge.getRoom(room.id).codexThreadId, nextThread)
  assert.equal(bridge.roomView(bridge.getRoom(room.id), 'dsh').handoffPending, false)

  await assert.rejects(() => bridge.status({ member: 'codex', identity: THREAD }), /not in an active/)
  const status = await bridge.status({ member: 'codex', identity: nextThread })
  assert.equal(status.room.id, room.id)

  await assert.rejects(
    () => bridge.redeemHandoffCode({ member: 'codex', identity: nextThread, roomId: room.id, code: issued.code }),
    /no pending handoff code/,
  )
  await bridge.issueHandoffCode({ member: 'dsh', identity: SESSION, roomId: room.id })
  clock.advance(31 * 60_000)
  await assert.rejects(
    () => bridge.redeemHandoffCode({ member: 'codex', identity: nextThread, roomId: room.id, code: issued.code }),
    /expired/,
  )
})

test('the handoff brief carries open tasks and confirmed decisions', async () => {
  const { bridge, room } = await paired()
  const task = await bridge.taskAction({
    member: 'dsh',
    identity: SESSION,
    roomId: room.id,
    taskAction: 'create',
    title: 'continue the migration',
    details: 'pick up at step 3',
  })
  await bridge.decisionAction({
    member: 'dsh',
    identity: SESSION,
    roomId: room.id,
    decisionAction: 'propose',
    question: 'which branch?',
    options: ['main', 'next'],
  })
  const decision = Object.values(bridge.state.decisions).at(-1)
  await bridge.decisionAction({
    member: 'dsh',
    identity: SESSION,
    roomId: room.id,
    decisionAction: 'confirm',
    decisionId: decision.id,
    choice: 'main',
  })
  await bridge.decisionAction({
    member: 'codex',
    identity: THREAD,
    roomId: room.id,
    decisionAction: 'confirm',
    decisionId: decision.id,
    choice: 'main',
  })

  const adopted = await bridge.adoptRoom({
    member: 'dsh',
    identity: 'session-new-0003',
    roomId: room.id,
    userConfirmed: true,
  })
  assert.equal(adopted.brief.openTasks.some((entry) => entry.id === task.task.id), true)
  assert.equal(adopted.brief.confirmedDecisions.some((entry) => entry.id === decision.id), true)
  assert.equal(adopted.brief.room.id, room.id)
})

test('manual delete removes an ended room and keeps a tombstone', async () => {
  const { bridge, room } = await paired()
  await bridge.sendMessage({ member: 'dsh', identity: SESSION, kind: 'notice', body: 'keep me?' })
  await bridge.taskAction({ member: 'dsh', identity: SESSION, taskAction: 'create', title: 't', owner: 'dsh' })
  await bridge.endRoom({ member: 'dsh', identity: SESSION, roomId: room.id, summary: 'done' })

  await assert.rejects(
    () => bridge.deleteRoom({ member: 'codex', identity: THREAD, roomId: room.id, userConfirmed: true }),
    /only the DSH member/,
  )
  await assert.rejects(
    () => bridge.deleteRoom({ member: 'dsh', identity: SESSION, roomId: room.id }),
    /user_confirmed/,
  )
  const deleted = await bridge.deleteRoom({
    member: 'dsh',
    identity: SESSION,
    roomId: room.id,
    userConfirmed: true,
    reason: '用户确认清理',
  })
  assert.equal(deleted.deleted, true)
  assert.equal(deleted.tombstone.id, room.id)
  assert.equal(deleted.tombstone.reason, '用户确认清理')
  assert.throws(() => bridge.getRoom(room.id), /does not exist/)
  assert.equal(Object.values(bridge.state.messages).filter((m) => m.roomId === room.id).length, 0)
  assert.equal(Object.values(bridge.state.tasks).filter((t) => t.roomId === room.id).length, 0)
  assert.ok(bridge.state.tombstones[room.id])
})

test('manual delete refuses a room that is not ended', async () => {
  const { bridge, room } = await paired()
  await assert.rejects(
    () => bridge.deleteRoom({ member: 'dsh', identity: SESSION, roomId: room.id, userConfirmed: true }),
    /end or leave it before deleting/,
  )
})

test('retention expires old ended rooms but never active ones', async () => {
  const env = await paired()
  const active = env.room
  const ended = await env.bridge.createRoom({
    member: 'dsh',
    identity: 'session-other-0003',
    goal: 'old room',
    cwd: WORKDIR,
  })
  await env.bridge.endRoom({
    member: 'dsh',
    identity: 'session-other-0003',
    roomId: ended.room.id,
    summary: 'old',
  })
  env.clock.advance(31 * 24 * 60 * 60 * 1000)
  const result = await env.bridge.retentionSweep({ endedRoomDays: 30, maxRooms: 100 })
  assert.equal(result.removed, 1)
  assert.ok(env.bridge.getRoom(active.id))
  assert.throws(() => env.bridge.getRoom(ended.room.id), /does not exist/)
  assert.ok(env.bridge.state.tombstones[ended.room.id])
})

test('retention trims only ended rooms and keeps the newest messages', async () => {
  const { bridge, room } = await paired()
  for (let index = 0; index < 5; index += 1) {
    await bridge.sendMessage({
      member: 'dsh',
      identity: SESSION,
      kind: 'notice',
      body: `message ${index}`,
      clientMessageId: `trim-${index}`,
    })
  }
  const activeBefore = Object.values(bridge.state.messages).filter((m) => m.roomId === room.id).length
  const activeSweep = await bridge.retentionSweep({ maxMessagesPerRoom: 2 })
  assert.deepEqual(activeSweep.trimmed, {})
  assert.equal(Object.values(bridge.state.messages).filter((m) => m.roomId === room.id).length, activeBefore)

  await bridge.endRoom({ member: 'dsh', identity: SESSION, roomId: room.id, summary: 'done' })
  const endedSweep = await bridge.retentionSweep({ maxMessagesPerRoom: 2 })
  assert.equal(endedSweep.trimmed[room.id], 3)
  const remaining = Object.values(bridge.state.messages)
    .filter((m) => m.roomId === room.id)
    .sort((a, b) => a.seq - b.seq)
  assert.equal(remaining.length, 2)
  assert.equal(bridge.getRoom(room.id).trimmedThroughSeq, 3)
  assert.ok(bridge.getRoom(room.id).trimmedMessages >= 3)
})

test('retention evicts the oldest ended rooms beyond maxRooms', async () => {
  const env = await paired()
  const created = []
  for (let index = 0; index < 3; index += 1) {
    const room = await env.bridge.createRoom({
      member: 'dsh',
      identity: `session-evict-000${index}`,
      goal: `room ${index}`,
      cwd: WORKDIR,
    })
    created.push(room.room.id)
    await env.bridge.endRoom({
      member: 'dsh',
      identity: `session-evict-000${index}`,
      roomId: room.room.id,
      summary: 'old',
    })
    env.clock.advance(1000)
  }
  const result = await env.bridge.retentionSweep({ endedRoomDays: 365, maxRooms: 2 })
  assert.ok(result.removed >= 2)
  assert.ok(Object.keys(env.bridge.state.rooms).length <= 2)
  assert.ok(env.bridge.getRoom(env.room.id))
})

test('approving a time-budget pause starts a fresh time window', async () => {
  const env = await paired()
  const raw = env.bridge.getRoom(env.room.id)
  raw.status = 'paused'
  raw.pauseReason = 'time_budget'
  raw.activatedAt = new Date(env.clock.now - 3 * 60 * 60_000).toISOString()
  await env.bridge.save()

  const requested = await env.bridge.requestBudget({
    member: 'dsh',
    identity: SESSION,
    addMinutes: 60,
    reason: '用户要求继续测试',
  })
  const approved = await env.bridge.decideBudget({
    member: 'dsh',
    identity: SESSION,
    requestId: requested.request.id,
    approve: true,
    userConfirmed: true,
  })
  assert.equal(approved.approved, true)
  const after = env.bridge.getRoom(env.room.id)
  assert.equal(after.status, 'active')
  assert.equal(after.pauseReason, null)
  assert.equal(after.budgets.maxMinutes, 180)
  assert.equal(after.activatedAt, new Date(env.clock.now).toISOString())
  assert.equal(after.timeWindowResetAt, after.activatedAt)
})
