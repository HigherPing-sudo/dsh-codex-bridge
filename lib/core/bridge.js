import {
  DEFAULT_BUDGETS,
  DEFAULT_RETENTION,
  DELIVERY_TRANSITIONS,
  MESSAGE_KINDS,
  ROOM_STATUS,
  TASK_ACTIONS,
  DECISION_ACTIONS,
  BUDGET_REASONS,
  HANDOFF_TTL_MINUTES,
  MEMBER_LABELS,
  assertKind,
  assertMember,
  assertRoomStatus,
  assertString,
  assertTransition,
  clampText,
  normalizeBudgets,
  optionalText,
  otherMember,
  nowIso,
} from './protocol.js'
import { fail } from './errors.js'
import { hashCode, newId, newPairingCode, newSalt, safeEqual } from './ids.js'

const DEFAULT_SCOPE = '仅限本次共同目标相关的讨论、任务与文件；不自动扩大目录或权限。'

/**
 * Transport-free collaboration core. Every method is async only because it
 * persists through the injected store; no DSH, HTTP, or Codex code lives here.
 */
export class Bridge {
  /**
   * @param {{store: import('./store.js').MemoryStore | import('./store.js').JsonFileStore, clock?: () => number, config?: Record<string, unknown>}} options
   */
  constructor({ store, clock = () => Date.now(), config = {} }) {
    this.store = store
    this.clock = clock
    this.config = { ...DEFAULT_BUDGETS, ...config }
    this.state = null
  }

  async init() {
    this.state = await this.store.load()
    if (this.#normalize()) await this.save()
    return this
  }

  #normalize() {
    const state = this.state
    let migrated = false
    state.rooms ??= {}
    state.messages ??= {}
    state.tasks ??= {}
    state.decisions ??= {}
    state.dedupe ??= {}
    state.tombstones ??= {}
    state.wakeLedger ??= {}
    for (const room of Object.values(state.rooms)) {
      room.members ??= { dsh: null, codex: null }
      room.lastSeen ??= { dsh: 0, codex: 0 }
      room.budgets = { ...DEFAULT_BUDGETS, ...(room.budgets ?? {}) }
      room.scope ??= { text: DEFAULT_SCOPE, writeScopes: [] }
      room.seq ??= 0
      room.wakes ??= 0
      // Old installations cannot prove that a recipient finished its work.
      // Migrate conservatively: keep uncertain batches held until a checkpoint.
      room.deliveryFlow ??= {}
      for (const member of ['dsh', 'codex']) {
        if (room.deliveryFlow[member]) continue
        migrated = true
        const pending = Object.values(state.messages).filter((message) =>
          message.roomId === room.id && message.to === member &&
          ['queued', 'queued_unresumed', 'processing', 'unknown'].includes(message.delivery?.state))
        room.deliveryFlow[member] = {
          status: 'busy',
          batch: pending.length ? {
            id: newId('batch'), messageIds: pending.map((message) => message.id),
            bindingId: room.members?.[member]?.id, createdAt: nowIso(this.clock), recovered: true,
          } : null,
          reason: 'legacy room: confirm a safe checkpoint before accepting another batch',
        }
      }
      if (room.inboxVersion !== 2) {
        for (const flow of Object.values(room.deliveryFlow)) flow.status = 'busy'
        room.inboxVersion = 2
        migrated = true
      }
    }
    if (state.wakeProtocolVersion !== 1) {
      // Old queue/steer acknowledgements cannot prove that the UI consumed a
      // notification. Preserve uncertainty across rooms using the same member.
      for (const message of Object.values(state.messages)) {
        const room = state.rooms[message.roomId]
        const evidence = message.delivery?.evidence ?? {}
        if (!room || evidence.channel === 'tool' || message.delivery?.state === 'saved' || message.delivery?.state === 'skipped') continue
        const identity = message.to === 'codex' ? evidence.threadId ?? room.codexThreadId : evidence.sessionId ?? room.dshSessionId
        if (!identity || (!evidence.queuedId && !evidence.inputId && !['queued', 'queued_unresumed', 'processing', 'unknown'].includes(message.delivery?.state))) continue
        const key = this.wakeKey(message.to, identity)
        state.wakeLedger[key] ??= { pending: { id: newId('wake'), reconciliationId: newId('reconcile'), legacy: true, state: 'unknown', roomId: room.id, messageIds: [], createdAt: nowIso(this.clock) } }
        state.wakeLedger[key].pending?.messageIds.push(message.id)
      }
      state.wakeProtocolVersion = 1
      migrated = true
    }
    return migrated
  }

  async save() {
    await this.store.save(this.state)
  }

  now() {
    return this.clock()
  }

  // ---------------------------------------------------------------------------
  // Rooms
  // ---------------------------------------------------------------------------

  getRoom(roomId) {
    const room = this.state.rooms[roomId]
    if (!room) fail('room_not_found', `room "${roomId}" does not exist`)
    return room
  }

  findRoomFor(member, identity) {
    assertMember(member)
    if (!identity) return undefined
    let found
    for (const room of Object.values(this.state.rooms)) {
      if (room.status === ROOM_STATUS.ENDED) continue
      if (room.members?.[member]?.id !== identity) continue
      if (!found || room.updatedAt > found.updatedAt) found = room
    }
    return found
  }

  requireRoomFor(member, identity) {
    const room = this.findRoomFor(member, identity)
    if (!room) {
      fail('not_in_room', `${MEMBER_LABELS[member]} session is not in an active bridge room`, {
        hint: 'Use action=create to open a room and share its pairing code, or action=join with a code.',
      })
    }
    return room
  }

  memberOf(room, member) {
    return room.members?.[member] ?? null
  }

  roomView(room, viewer) {
    const budgets = room.budgets ?? DEFAULT_BUDGETS
    const startedAt = room.activatedAt ? Date.parse(room.activatedAt) : null
    const elapsedMinutes = startedAt ? Math.max(0, (this.now() - startedAt) / 60000) : 0
    return {
      id: room.id,
      status: room.status,
      title: room.title,
      goal: room.goal,
      cwd: room.cwd,
      scope: room.scope,
      createdBy: room.createdBy,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      activatedAt: room.activatedAt,
      endedAt: room.endedAt,
      pauseReason: room.pauseReason,
      dshSessionId: room.dshSessionId,
      codexThreadId: room.codexThreadId,
      members: {
        dsh: room.members?.dsh ? { id: room.members.dsh.id, joinedAt: room.members.dsh.joinedAt } : null,
        codex: room.members?.codex ? { id: room.members.codex.id, joinedAt: room.members.codex.joinedAt } : null,
      },
      viewer,
      budgets: {
        maxHops: budgets.maxHops,
        maxWakes: budgets.maxWakes,
        maxMinutes: budgets.maxMinutes,
        usedWakes: room.wakes ?? 0,
        elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
      },
      budgetRequests: this.budgetRequestsFor(room),
      handoffPending: Boolean(room.handoffCode),
      handoffs: (room.handoffs ?? []).slice(-5),
      unread: this.unreadCount(room, viewer),
      deliveryFlow: room.deliveryFlow,
      pendingWake: {
        dsh: this.wakeView('dsh', room.dshSessionId),
        codex: this.wakeView('codex', room.codexThreadId),
      },
      controlNotices: (room.controlNotices ?? []).filter((notice) => notice.to === viewer && !notice.readAt),
    }
  }

  unreadCount(room, viewer) {
    const since = room.lastSeen?.[viewer] ?? 0
    let count = 0
    for (const message of Object.values(this.state.messages)) {
      if (message.roomId === room.id && message.seq > since && message.from !== viewer) count += 1
    }
    return count
  }

  /** Pending budget requests, safe to show to either member (no secrets). */
  budgetRequestsFor(room) {
    return Object.values(room.budgetRequests ?? {})
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        id: request.id,
        requestedBy: request.requestedBy,
        addWakes: request.addWakes,
        addMinutes: request.addMinutes,
        addHops: request.addHops,
        reason: request.reason,
        status: request.status,
        createdAt: request.createdAt,
      }))
  }

  async createRoom({ member, identity, goal, cwd, scope, budgets, title }) {
    assertMember(member)
    const sessionId = assertString(identity, 'identity', { max: 200 })
    const existing = this.findRoomFor(member, sessionId)
    if (existing) {
      fail('already_in_room', `${MEMBER_LABELS[member]} session already belongs to room ${existing.id}`, {
        roomId: existing.id,
      })
    }
    const roomId = newId('room')
    const code = newPairingCode()
    const salt = newSalt()
    const normalized = normalizeBudgets({ ...this.config, ...budgets })
    const now = this.now()
    const workDir = assertString(cwd ?? this.config.defaultCwd ?? process.cwd(), 'cwd', { max: 1000 })
    const rawScope = typeof scope === 'string' ? scope : scope?.text
    const scopeText = optionalText(rawScope, 1000, 'scope') ?? DEFAULT_SCOPE
    const writeScopes = normalizeWriteScopes(scope?.writeScopes ?? [])
    const room = {
      id: roomId,
      title: optionalText(title, 200, 'title'),
      goal: clampText(goal, 2000, 'goal'),
      cwd: workDir,
      scope: { text: scopeText, writeScopes },
      status: ROOM_STATUS.PAIRING,
      createdBy: member,
      createdAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
      activatedAt: null,
      endedAt: null,
      pauseReason: null,
      pausedBy: null,
      dshSessionId: member === 'dsh' ? sessionId : null,
      codexThreadId: member === 'codex' ? sessionId : null,
      members: {
        dsh: member === 'dsh' ? { id: sessionId, joinedAt: nowIso(this.clock) } : null,
        codex: member === 'codex' ? { id: sessionId, joinedAt: nowIso(this.clock) } : null,
      },
      codeHash: hashCode(code, salt),
      codeSalt: salt,
      codeExpiresAt: now + normalized.pairingTtlMinutes * 60_000,
      codeAttempts: 0,
      seq: 0,
      wakes: 0,
      lastSeen: { dsh: 0, codex: 0 },
      deliveryFlow: {
        dsh: { status: 'idle', batch: null },
        codex: { status: 'idle', batch: null },
      },
      inboxVersion: 2,
      budgets: {
        maxHops: normalized.maxHops,
        maxWakes: normalized.maxWakes,
        maxMinutes: normalized.maxMinutes,
        pairingTtlMinutes: normalized.pairingTtlMinutes,
      },
    }
    this.state.rooms[roomId] = room
    await this.save()
    return {
      room: this.roomView(room, member),
      code,
      codeExpiresAt: new Date(room.codeExpiresAt).toISOString(),
      instructions: `Show this one-time code to the user and ask them to enter it in the ${MEMBER_LABELS[otherMember(member)]} session.`,
    }
  }

  async joinRoom({ member, identity, code, cwd }) {
    assertMember(member)
    const sessionId = assertString(identity, 'identity', { max: 200 })
    const pairingCode = assertString(code, 'code', { max: 12 })
    if (!/^\d{6}$/.test(pairingCode)) fail('bad_pairing_code', 'pairing code must be exactly six digits')

    const existing = this.findRoomFor(member, sessionId)
    if (existing) {
      fail('already_in_room', `${MEMBER_LABELS[member]} session already belongs to room ${existing.id}`, {
        roomId: existing.id,
      })
    }

    const candidates = Object.values(this.state.rooms).filter(
      (room) => room.status === ROOM_STATUS.PAIRING && room.codeHash,
    )
    const room = candidates.find((candidate) => safeEqual(hashCode(pairingCode, candidate.codeSalt), candidate.codeHash))
    if (!room) fail('pairing_code_invalid', 'pairing code does not match any waiting room')
    if (room.codeExpiresAt < this.now()) {
      fail('pairing_code_expired', 'pairing code has expired; create a new room to get a fresh code')
    }
    if (room.members[member]?.id && room.members[member].id !== sessionId) {
      fail('member_already_bound', `room ${room.id} already has a different ${MEMBER_LABELS[member]} member`)
    }
    if (cwd && normalizePath(cwd) !== normalizePath(room.cwd)) {
      fail('cwd_mismatch', `room ${room.id} declares working directory ${room.cwd}`, { cwd })
    }
    if (room.members[member]?.id === sessionId) {
      return { room: this.roomView(room, member), joined: true }
    }

    room.members[member] = { id: sessionId, joinedAt: nowIso(this.clock) }
    if (member === 'dsh') room.dshSessionId = sessionId
    if (member === 'codex') room.codexThreadId = sessionId
    room.codeAttempts = 0
    if (room.members.dsh?.id && room.members.codex?.id) {
      room.status = ROOM_STATUS.ACTIVE
      room.activatedAt = nowIso(this.clock)
      room.codeHash = null
      room.codeSalt = null
      room.codeExpiresAt = null
    }
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), joined: true }
  }

  /**
   * Handoff: a new DSH session adopts the room binding. History, tasks,
   * decisions and budgets stay in the same room; the old session stops
   * matching immediately because findRoomFor compares the member id.
   */
  async adoptRoom({ member, identity, roomId, userConfirmed, force, reason, oldAttached }) {
    if (member !== 'dsh') {
      fail('forbidden', 'only the DSH member can adopt a room; Codex rebinds with a handoff code', { member })
    }
    if (userConfirmed !== true) {
      fail('user_confirmation_required', 'adopt needs user_confirmed=true after an explicit user instruction')
    }
    const sessionId = assertString(identity, 'identity', { max: 200 })
    const room = this.getRoom(assertString(roomId, 'room_id', { max: 100 }))
    if (room.status === ROOM_STATUS.ENDED) fail('room_ended', `room ${room.id} has ended`)
    const previous = room.members?.dsh?.id ?? null
    if (previous === sessionId) {
      return { adopted: false, already: true, previous, room: this.roomView(room, member), brief: this.handoffBrief(room, member) }
    }
    if (previous && oldAttached === true && force !== true) {
      fail('old_session_active', `DSH session ${previous} is still attached; close it first or pass force=true`, {
        roomId: room.id,
        previous,
      })
    }
    room.members ??= {}
    room.members.dsh = { id: sessionId, joinedAt: nowIso(this.clock) }
    room.dshSessionId = sessionId
    room.deliveryFlow.dsh = { status: 'busy', batch: null, reason: 'new member must read the handoff before accepting work' }
    this.#recordHandoff(room, {
      role: 'dsh',
      from: previous,
      to: sessionId,
      by: member,
      forced: force === true,
      reason: optionalText(reason, 500, 'reason'),
    })
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      adopted: true,
      already: false,
      previous,
      room: this.roomView(room, member),
      brief: this.handoffBrief(room, member),
    }
  }

  /**
   * A one-time code that lets a new Codex thread take over the Codex binding.
   * Only the DSH member may issue it; it is bound to this room and expires.
   */
  async issueHandoffCode({ member, identity, roomId, ttlMinutes }) {
    if (member !== 'dsh') fail('forbidden', 'only the DSH member can issue a handoff code')
    const room = this.#roomForAction(member, identity, roomId)
    if (room.status === ROOM_STATUS.ENDED) fail('room_ended', `room ${room.id} has ended`)
    const ttl = ttlMinutes === undefined ? HANDOFF_TTL_MINUTES : integerInRange(ttlMinutes, 5, 120, 'ttl_minutes')
    const code = newPairingCode()
    const salt = newSalt()
    room.handoffCode = {
      role: 'codex',
      hash: hashCode(code, salt),
      salt,
      createdAt: nowIso(this.clock),
      issuedBy: member,
      expiresAt: this.now() + ttl * 60_000,
    }
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      code,
      role: 'codex',
      ttlMinutes: ttl,
      expiresAt: new Date(room.handoffCode.expiresAt).toISOString(),
      room: this.roomView(room, member),
      instructions: 'Show this one-time code to the user and ask them to enter it in the new Codex thread with action=rebind plus the room id.',
    }
  }

  /** A new Codex thread takes over the Codex binding with the one-time code. */
  async redeemHandoffCode({ member, identity, roomId, code, reason }) {
    if (member !== 'codex') fail('forbidden', 'only a Codex thread can redeem a handoff code; DSH uses adopt')
    const threadId = assertString(identity, 'identity', { max: 200 })
    const room = this.getRoom(assertString(roomId, 'room_id', { max: 100 }))
    if (room.status === ROOM_STATUS.ENDED) fail('room_ended', `room ${room.id} has ended`)
    const pending = room.handoffCode
    if (!pending) fail('handoff_code_missing', `room ${room.id} has no pending handoff code`)
    if (pending.expiresAt < this.now()) {
      room.handoffCode = null
      await this.save()
      fail('handoff_code_expired', 'the handoff code has expired; ask DSH for a new one')
    }
    const given = assertString(code, 'code', { max: 12 })
    if (!/^\d{6}$/.test(given)) fail('bad_handoff_code', 'handoff code must be exactly six digits')
    if (!safeEqual(hashCode(given, pending.salt), pending.hash)) {
      fail('handoff_code_invalid', 'handoff code does not match this room')
    }
    const previous = room.members?.codex?.id ?? null
    if (previous === threadId) {
      room.handoffCode = null
      await this.save()
      return { rebound: false, already: true, previous, room: this.roomView(room, member), brief: this.handoffBrief(room, member) }
    }
    room.members ??= {}
    room.members.codex = { id: threadId, joinedAt: nowIso(this.clock) }
    room.codexThreadId = threadId
    room.deliveryFlow.codex = { status: 'busy', batch: null, reason: 'new member must read the handoff before accepting work' }
    room.handoffCode = null
    this.#recordHandoff(room, {
      role: 'codex',
      from: previous,
      to: threadId,
      by: member,
      forced: false,
      reason: optionalText(reason, 500, 'reason'),
    })
    if (room.status === ROOM_STATUS.PAIRING && room.members.dsh?.id) {
      room.status = ROOM_STATUS.ACTIVE
      room.activatedAt ??= nowIso(this.clock)
    }
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      rebound: true,
      already: false,
      previous,
      room: this.roomView(room, member),
      brief: this.handoffBrief(room, member),
    }
  }

  /** Structured continuity brief for a new session taking over a room. */
  handoffBrief(room, viewer) {
    const tasks = this.tasksFor(room, viewer).filter((task) => !['done', 'cancelled'].includes(task.status))
    const decisions = this.decisionsFor(room).filter((decision) => decision.status === 'confirmed')
    const messages = Object.values(this.state.messages)
      .filter((message) => message.roomId === room.id)
      .sort((a, b) => a.seq - b.seq)
      .slice(-8)
      .map((message) => ({
        id: message.id,
        seq: message.seq,
        kind: message.kind,
        from: message.from,
        to: message.to,
        replyTo: message.replyTo ?? null,
        body: message.body.length > 240 ? `${message.body.slice(0, 240)}…` : message.body,
      }))
    return {
      room: this.roomView(room, viewer),
      openTasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        owner: task.owner,
        blocked: task.blocked,
        acceptance: task.acceptance,
      })),
      confirmedDecisions: decisions.map((decision) => ({
        id: decision.id,
        question: decision.question,
        choice: decision.choice,
        confirmedBy: decision.confirmedBy,
      })),
      recentMessages: messages,
      pendingBudgetRequests: this.budgetRequestsFor(room),
      lastHandoff: room.handoffs?.at(-1) ?? null,
      next: 'Call action=status (and read tasks/decisions) before acting; do not assume hidden context carried over.',
    }
  }

  #recordHandoff(room, entry) {
    room.handoffs ??= []
    room.handoffs.push({ id: newId('handoff'), at: nowIso(this.clock), ...entry })
    if (room.handoffs.length > 20) room.handoffs.splice(0, room.handoffs.length - 20)
  }

  async pauseRoom({ member, identity, roomId, reason }) {
    const room = this.#roomForAction(member, identity, roomId)
    assertRoomStatus(room, [ROOM_STATUS.ACTIVE, ROOM_STATUS.PAIRING])
    room.status = ROOM_STATUS.PAUSED
    room.pauseReason = optionalText(reason, 500, 'reason') ?? `paused_by_${member}`
    room.pausedBy = member
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), paused: true }
  }

  async resumeRoom({ member, identity, roomId, resetBudget }) {
    const room = this.#roomForAction(member, identity, roomId)
    assertRoomStatus(room, [ROOM_STATUS.PAUSED])
    if (!room.members.dsh?.id || !room.members.codex?.id) {
      fail('room_incomplete', 'both members must be bound before resuming')
    }
    if (BUDGET_REASONS.includes(room.pauseReason)) {
      fail('budget_approval_required', 'budget pauses can only be lifted by an approved budget request', {
        roomId: room.id,
        pauseReason: room.pauseReason,
        hint: 'use budget_request, then budget_approve with user_confirmed=true',
      })
    }
    if (resetBudget === true) {
      room.wakes = 0
      room.activatedAt = nowIso(this.clock)
      room.budgetResetAt = nowIso(this.clock)
      for (const request of Object.values(room.budgetRequests ?? {})) {
        if (request.status === 'pending') {
          request.status = 'superseded'
          request.decidedAt = nowIso(this.clock)
          request.decidedBy = member
        }
      }
    }
    room.status = ROOM_STATUS.ACTIVE
    room.pauseReason = null
    room.pausedBy = null
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), resumed: true }
  }

  /**
   * File a request for more budget. The room stays paused; nothing is granted
   * until the DSH member approves with explicit user confirmation.
   */
  async requestBudget({ member, identity, roomId, addWakes, addMinutes, addHops, reason }) {
    const room = this.#roomForAction(member, identity, roomId)
    if (room.status !== ROOM_STATUS.PAUSED || !BUDGET_REASONS.includes(room.pauseReason)) {
      fail(
        'budget_not_exhausted',
        `room ${room.id} is ${room.status}${room.pauseReason ? ` (${room.pauseReason})` : ''}; not paused for a budget reason`,
        { roomId: room.id, pauseReason: room.pauseReason ?? null, status: room.status },
      )
    }
    const wakes = integerInRange(addWakes, 0, 500, 'add_wakes')
    const minutes = integerInRange(addMinutes, 0, 1440, 'add_minutes')
    const hops = integerInRange(addHops, 0, 50, 'add_hops')
    if (wakes + minutes + hops === 0) {
      fail('bad_argument', 'request at least one of add_wakes, add_minutes or add_hops')
    }
    const why = optionalText(reason, 500, 'reason')
    if (!why) fail('bad_argument', 'budget_request requires a short reason')

    const pending = Object.values(room.budgetRequests ?? {}).find((request) => request.status === 'pending')
    if (pending) {
      return {
        request: this.#budgetRequestView(pending),
        existing: true,
        room: this.roomView(room, member),
      }
    }

    const request = {
      id: newId('breq'),
      roomId: room.id,
      requestedBy: member,
      addWakes: wakes,
      addMinutes: minutes,
      addHops: hops,
      reason: why,
      status: 'pending',
      createdAt: nowIso(this.clock),
      decidedAt: null,
      decidedBy: null,
      userConfirmed: false,
    }
    room.budgetRequests ??= {}
    room.budgetRequests[request.id] = request
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      request: this.#budgetRequestView(request),
      existing: false,
      room: this.roomView(room, member),
    }
  }

  /**
   * Approve or reject a pending budget request. Only the DSH member may decide,
   * and approval requires `userConfirmed === true` so the model cannot raise its
   * own budget silently. Codex may only file requests.
   */
  async decideBudget({ member, identity, roomId, requestId, approve, userConfirmed, note }) {
    const room = this.#roomForAction(member, identity, roomId)
    const request = room.budgetRequests?.[requestId]
    if (!request) fail('budget_request_not_found', `no budget request ${requestId} in room ${room.id}`)
    if (request.status !== 'pending') {
      fail('budget_request_state', `budget request ${requestId} is ${request.status}`)
    }
    if (approve !== true) {
      request.status = 'rejected'
      request.decidedAt = nowIso(this.clock)
      request.decidedBy = member
      request.decisionNote = optionalText(note, 500, 'note')
      room.updatedAt = nowIso(this.clock)
      await this.save()
      return { request: this.#budgetRequestView(request), approved: false, room: this.roomView(room, member) }
    }

    if (member !== 'dsh') {
      fail('forbidden', 'only the DSH member can approve a budget request; Codex may only request', {
        requestId: request.id,
        requestedBy: request.requestedBy,
      })
    }
    if (userConfirmed !== true) {
      fail('user_confirmation_required', 'budget approval needs user_confirmed=true after an explicit user instruction', {
        requestId: request.id,
      })
    }
    assertRoomStatus(room, [ROOM_STATUS.PAUSED])

    const wasTimeBudget = room.pauseReason === 'time_budget'
    room.budgets.maxWakes += request.addWakes
    room.budgets.maxMinutes += request.addMinutes
    room.budgets.maxHops += request.addHops
    room.status = ROOM_STATUS.ACTIVE
    room.pauseReason = null
    room.pausedBy = null
    // Time is a window, not an additive counter: once elapsed time already
    // exceeds the cap, adding minutes can never catch up. An explicit user
    // approval therefore starts a fresh window of the (now larger) budget.
    if (wasTimeBudget) {
      room.activatedAt = nowIso(this.clock)
      room.timeWindowResetAt = room.activatedAt
    }
    room.budgetGrantedAt = nowIso(this.clock)
    request.status = 'approved'
    request.decidedAt = nowIso(this.clock)
    request.decidedBy = member
    request.userConfirmed = true
    request.decisionNote = optionalText(note, 500, 'note')
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      request: this.#budgetRequestView(request),
      approved: true,
      granted: {
        addWakes: request.addWakes,
        addMinutes: request.addMinutes,
        addHops: request.addHops,
      },
      room: this.roomView(room, member),
    }
  }

  #budgetRequestView(request) {
    return {
      id: request.id,
      requestedBy: request.requestedBy,
      addWakes: request.addWakes,
      addMinutes: request.addMinutes,
      addHops: request.addHops,
      reason: request.reason,
      status: request.status,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt ?? null,
      decidedBy: request.decidedBy ?? null,
      userConfirmed: request.userConfirmed === true,
    }
  }

  async endRoom({ member, identity, roomId, summary }) {
    const room = this.#roomForAction(member, identity, roomId)
    room.status = ROOM_STATUS.ENDED
    room.endedAt = nowIso(this.clock)
    room.endedBy = member
    room.endSummary = optionalText(summary, 2000, 'summary')
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), ended: true }
  }

  async leaveRoom({ member, identity, roomId }) {
    const room = this.#roomForAction(member, identity, roomId)
    room.status = ROOM_STATUS.ENDED
    room.endedAt = nowIso(this.clock)
    room.endedBy = member
    room.pauseReason = `left_by_${member}`
    room.members[member] = null
    if (member === 'dsh') room.dshSessionId = null
    if (member === 'codex') room.codexThreadId = null
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), left: true }
  }

  /**
   * Hard-delete an ended room and its messages/tasks/decisions. Manual path:
   * DSH-only and requires explicit user confirmation. A compact tombstone stays
   * for auditability.
   */
  async deleteRoom({ member, identity, roomId, userConfirmed, reason }) {
    const room = this.#roomForAction(member, identity, roomId)
    if (member !== 'dsh') {
      fail('forbidden', 'only the DSH member can delete a room; Codex may only leave/end it')
    }
    if (userConfirmed !== true) {
      fail('user_confirmation_required', 'room deletion needs user_confirmed=true after an explicit user instruction')
    }
    if (room.status !== ROOM_STATUS.ENDED) {
      fail('room_not_ended', `room ${room.id} is ${room.status}; end or leave it before deleting`, {
        roomId: room.id,
        status: room.status,
      })
    }
    const tombstone = this.#purgeRoom(room, {
      reason: optionalText(reason, 500, 'reason') ?? 'manual_delete',
      by: member,
    })
    await this.save()
    return { deleted: true, roomId: tombstone.id, tombstone }
  }

  /**
   * Automatic retention. Defaults are in DEFAULT_RETENTION: ended rooms older
   * than `endedRoomDays`, the oldest ended rooms beyond `maxRooms`, and messages
   * beyond `maxMessagesPerRoom` inside ended rooms. Active/paused rooms are never
   * deleted or trimmed, so a running collaboration cannot lose context.
   */
  async retentionSweep(options = {}) {
    const config = { ...DEFAULT_RETENTION, ...(this.config.retention ?? {}), ...options }
    if (config.enabled !== true) {
      return { enabled: false, removed: 0, trimmed: {}, rooms: Object.keys(this.state.rooms).length }
    }
    const now = this.now()
    const day = 24 * 60 * 60 * 1000
    const removed = []
    const trimmed = {}

    for (const room of Object.values(this.state.rooms)) {
      if (room.status !== ROOM_STATUS.ENDED || !room.endedAt) continue
      const endedAt = Date.parse(room.endedAt)
      if (Number.isFinite(endedAt) && now - endedAt > config.endedRoomDays * day) {
        removed.push(this.#purgeRoom(room, { reason: `retention_ended_${config.endedRoomDays}d`, by: 'system' }))
      }
    }

    const endedRooms = () =>
      Object.values(this.state.rooms)
        .filter((room) => room.status === ROOM_STATUS.ENDED)
        .sort((left, right) => Date.parse(left.endedAt ?? 0) - Date.parse(right.endedAt ?? 0))
    while (Object.keys(this.state.rooms).length > config.maxRooms) {
      const oldest = endedRooms()[0]
      if (!oldest) break
      removed.push(this.#purgeRoom(oldest, { reason: `retention_max_rooms_${config.maxRooms}`, by: 'system' }))
    }

    for (const room of Object.values(this.state.rooms)) {
      if (room.status !== ROOM_STATUS.ENDED) continue
      const messages = Object.values(this.state.messages)
        .filter((message) => message.roomId === room.id)
        .sort((left, right) => left.seq - right.seq)
      if (messages.length <= config.maxMessagesPerRoom) continue
      const excess = messages.slice(0, messages.length - config.maxMessagesPerRoom)
      for (const message of excess) delete this.state.messages[message.id]
      room.trimmedMessages = (room.trimmedMessages ?? 0) + excess.length
      room.trimmedThroughSeq = Math.max(room.trimmedThroughSeq ?? 0, excess.at(-1).seq)
      trimmed[room.id] = excess.length
    }

    // Dedupe keys must not outlive the message they point at.
    for (const [key, messageId] of Object.entries(this.state.dedupe ?? {})) {
      if (!this.state.messages[messageId]) delete this.state.dedupe[key]
    }

    if (removed.length > 0 || Object.keys(trimmed).length > 0) await this.save()
    return {
      enabled: true,
      removed: removed.length,
      tombstones: removed.map((entry) => entry?.id).filter(Boolean),
      trimmed,
      rooms: Object.keys(this.state.rooms).length,
    }
  }

  #purgeRoom(room, { reason, by }) {
    const messages = Object.values(this.state.messages).filter((message) => message.roomId === room.id)
    const tasks = Object.values(this.state.tasks ?? {}).filter((task) => task.roomId === room.id)
    const decisions = Object.values(this.state.decisions ?? {}).filter((decision) => decision.roomId === room.id)
    for (const message of messages) delete this.state.messages[message.id]
    for (const task of tasks) delete this.state.tasks[task.id]
    for (const decision of decisions) delete this.state.decisions[decision.id]
    delete this.state.rooms[room.id]
    const tombstone = {
      id: room.id,
      title: room.title ?? null,
      goal: optionalText(room.goal, 500, 'goal') ?? null,
      status: room.status,
      endedAt: room.endedAt ?? null,
      deletedAt: nowIso(this.clock),
      deletedBy: by,
      reason,
      counts: { messages: messages.length, tasks: tasks.length, decisions: decisions.length },
    }
    this.state.tombstones ??= {}
    this.state.tombstones[room.id] = tombstone
    const limit = this.config.retention?.maxTombstones ?? DEFAULT_RETENTION.maxTombstones
    const ids = Object.keys(this.state.tombstones)
    for (const id of ids.slice(0, Math.max(0, ids.length - limit))) delete this.state.tombstones[id]
    return tombstone
  }

  #roomForAction(member, identity, roomId) {
    assertMember(member)
    if (roomId) {
      const room = this.getRoom(roomId)
      if (room.members?.[member]?.id !== identity) fail('not_a_member', `not a member of room ${roomId}`)
      return room
    }
    return this.requireRoomFor(member, identity)
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /** One durable recipient credit. Replies and elapsed time never return it. */
  deliveryHeld(room, member) {
    const flow = room.deliveryFlow[member]
    return flow.status !== 'idle' || (flow.hostPhase && flow.hostPhase !== 'idle') || Boolean(flow.batch) || Boolean(this.wakeFor(member, room.members[member]?.id)?.pending)
  }

  wakeKey(member, identity) { return `${member}:${identity}` }

  wakeFor(member, identity) { return this.state.wakeLedger[this.wakeKey(member, identity)] }

  wakeView(member, identity) {
    const pending = identity && this.wakeFor(member, identity)?.pending
    // wake_id is intentionally only in the actual client envelope. Reading
    // status/room state through the tool must not masquerade as UI consumption.
    return pending ? { pending: true, state: pending.state, legacy: pending.legacy === true, roomId: pending.roomId, createdAt: pending.createdAt, reconciliationId: pending.reconciliationId } : { pending: false }
  }

  reserveWake({ member, identity, roomId, messageIds = [], controlId }) {
    const key = this.wakeKey(member, identity)
    if (this.state.wakeLedger[key]?.pending) fail('wake_pending', 'this recipient already has an unconsumed client wake')
    const id = newId('wake')
    this.state.wakeLedger[key] = {
      ...this.state.wakeLedger[key],
      pending: { id, roomId, messageIds: [...messageIds], controlId, createdAt: nowIso(this.clock), state: 'reserved' },
    }
    return id
  }

  async takeControlNotices(room, member) {
    const notices = (room.controlNotices ?? []).filter((notice) => notice.to === member && !notice.readAt)
    const result = notices.map((notice) => ({ ...notice }))
    for (const notice of notices) notice.readAt = nowIso(this.clock)
    if (notices.length) await this.save()
    return result
  }

  async beginDelivery({ roomId, member, messageIds, channel = 'transport' }) {
    assertMember(member)
    const room = this.getRoom(roomId)
    assertRoomStatus(room, [ROOM_STATUS.ACTIVE])
    if (channel === 'tool' ? room.deliveryFlow[member].batch : this.deliveryHeld(room, member)) {
      fail('recipient_busy', 'the recipient has unfinished work or an unconsumed client wake')
    }
    for (const id of messageIds) {
      const message = this.getRoomMessage(room, id)
      if (message.to !== member || message.delivery.state !== 'saved') fail('bad_batch', 'only saved recipient messages can enter a batch')
    }
    const batch = {
      id: newId('batch'), messageIds: [...messageIds],
      bindingId: room.members[member]?.id, createdAt: nowIso(this.clock), channel,
    }
    // Persist intent before calling an external transport. An uncertain outcome
    // must survive restart without authorizing a duplicate wake.
    room.deliveryFlow[member] = { ...room.deliveryFlow[member], status: 'busy', batch }
    let wakeId
    if (channel === 'transport') {
      wakeId = this.reserveWake({ member, identity: batch.bindingId, roomId, messageIds })
    }
    await this.save()
    return { ...batch, wakeId }
  }

  async observeWake({ member, identity, wakeId, outcome }) {
    const ledger = this.wakeFor(member, identity)
    if (ledger?.pending?.id !== wakeId) return
    if (outcome.state === 'failed') ledger.pending = null
    else {
      ledger.pending.state = ['queued', 'queued_unresumed'].includes(outcome.state) ? 'queued' : 'unknown'
      ledger.pending.queueId = outcome.evidence?.queuedId ?? outcome.evidence?.inputId ?? null
      if (ledger.pending.state === 'unknown') ledger.pending.reconciliationId ??= newId('reconcile')
    }
    await this.save()
  }

  async ackWake({ member, identity, wakeId, reconciliationId, userConfirmed }) {
    assertMember(member)
    const ledger = this.wakeFor(member, identity)
    if (wakeId && ledger?.lastAcknowledgedId === wakeId) return { duplicate: true, pending: Boolean(ledger.pending) }
    if (reconciliationId && ledger?.lastReconciliationId === reconciliationId) return { duplicate: true, pending: Boolean(ledger.pending) }
    const pending = ledger?.pending
    if (!pending) fail('wake_not_found', 'no matching client wake is pending')
    if (pending.legacy || reconciliationId) {
      if (userConfirmed !== true || wakeId || !pending.reconciliationId || reconciliationId !== pending.reconciliationId) {
        fail('legacy_wake_confirmation_required', 'after direct user confirmation that old/uncertain client notifications were consumed or removed: ack_wake with user_confirmed=true and the current reconcile_id from pendingWake')
      }
    } else if (!wakeId || pending.id !== wakeId) {
      fail('wake_mismatch', 'copy wake_id from the actual client input envelope, not from bridge status')
    }
    ledger.lastAcknowledgedId = pending.id
    ledger.acknowledgedAt = nowIso(this.clock)
    const reconciled = pending.legacy === true || !wakeId
    if (reconciled) ledger.lastReconciliationId = reconciliationId
    ledger.legacyReconciled = reconciled
    ledger.pending = null
    for (const id of pending.messageIds) {
      const message = this.state.messages[id]
      if (message) message.wakeConsumedAt = nowIso(this.clock)
    }
    const notice = this.state.rooms[pending.roomId]?.controlNotices?.find((entry) => entry.id === pending.controlId)
    if (notice) notice.readAt = nowIso(this.clock)
    await this.save()
    return { duplicate: false, consumed: !reconciled, reconciled, pending: false }
  }

  async deliveryFailed({ roomId, member, batchId }) {
    const room = this.getRoom(roomId)
    const flow = room.deliveryFlow[member]
    if (flow.batch?.id !== batchId) return
    flow.status = 'busy'
    flow.batch = null
    await this.save()
  }

  async setAvailability({ member, identity, roomId, status, batchId }) {
    const room = this.#roomForAction(member, identity, roomId)
    assertRoomStatus(room, [ROOM_STATUS.ACTIVE, ROOM_STATUS.PAUSED])
    if (!['busy', 'ready', 'idle'].includes(status)) fail('bad_availability', 'availability status must be busy, ready (checkpoint), or idle')
    const flow = room.deliveryFlow[member]
    if (status === 'ready' || status === 'idle') {
      // Replaying the release of A must never release a later batch B.
      if (batchId && flow.lastReleasedBatchId === batchId) {
        return { room: this.roomView(room, member), duplicate: true }
      }
      if (flow.batch ? flow.batch.id !== batchId : Boolean(batchId)) {
        fail('batch_mismatch', 'ready must name the current batch_id from bridge status', { batchId: flow.batch?.id ?? null })
      }
      if (flow.batch) {
        for (const id of flow.batch.messageIds) {
          const message = this.state.messages[id]
          if (message) message.handledAt = nowIso(this.clock)
        }
        flow.lastReleasedBatchId = flow.batch.id
      }
      flow.batch = null
    }
    flow.status = status === 'idle' ? 'idle' : 'busy'
    flow.updatedAt = nowIso(this.clock)
    flow.reason = status === 'idle' ? null : 'recipient remains in the current work turn'
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), duplicate: false }
  }

  /** Native host boundary: a turn ending is not proof that its business tasks finished. */
  async hostBoundary(room, member, { idle = false, turnId, blocked = false, provisional = false } = {}) {
    const flow = room.deliveryFlow[member]
    if (turnId) flow.hostTurnId = turnId
    flow.hostBlocked = blocked
    flow.hostPhase = blocked ? 'blocked' : provisional ? 'stopping' : idle ? 'idle' : 'running'
    flow.status = idle && !blocked && !provisional ? 'idle' : 'busy'
    flow.reason = blocked ? 'host interrupted or awaiting user input' : idle ? null : 'host work turn active'
    flow.updatedAt = nowIso(this.clock)
    if (idle && flow.batch) {
      for (const id of flow.batch.messageIds) {
        const message = this.state.messages[id]
        if (message) message.turnEndedAt = nowIso(this.clock)
      }
      flow.lastReleasedBatchId = flow.batch.id
      flow.batch = null
    }
    await this.save()
  }

  /** Add mail to the running turn without completing its earlier work or waking a client. */
  async takeHostMail(room, member, limit) {
    const messages = this.savedFor(room, member, limit)
    if (!messages.length) return null
    const flow = room.deliveryFlow[member]
    flow.batch ??= {
      id: newId('batch'), messageIds: [], bindingId: room.members[member]?.id,
      createdAt: nowIso(this.clock), channel: 'host',
    }
    for (const message of messages) {
      flow.batch.messageIds.push(message.id)
      message.receivedAt = nowIso(this.clock)
      message.delivery = { ...message.delivery, state: 'processing', updatedAt: nowIso(this.clock),
        detail: 'native host boundary supplied mail to the current turn; no client wake',
        evidence: { channel: 'host', batchId: flow.batch.id } }
    }
    flow.status = 'busy'
    await this.save()
    return { messages, batchId: flow.batch.id }
  }

  async sendMessage({
    member,
    identity,
    roomId,
    kind,
    body,
    to,
    replyTo,
    taskId,
    decisionId,
    clientMessageId,
  }) {
    assertMember(member)
    const room = this.#roomForAction(member, identity, roomId)
    assertRoomStatus(room, [ROOM_STATUS.ACTIVE])
    assertKind(kind)
    const target = to ?? otherMember(member)
    assertMember(target)
    if (target === member) fail('self_send', 'a member cannot send a collaboration message to itself')

    const dedupeKey = clientMessageId ? `${member}:${clientMessageId}` : undefined
    if (dedupeKey && this.state.dedupe[dedupeKey]) {
      const existing = this.state.messages[this.state.dedupe[dedupeKey]]
      if (existing) {
        return { message: existing, duplicate: true, room: this.roomView(room, member) }
      }
    }

    const text = clampText(body, this.config.maxBodyChars ?? DEFAULT_BUDGETS.maxBodyChars, 'body')
    const parent = replyTo ? this.getRoomMessage(room, replyTo) : undefined
    if (parent && parent.from === member) fail('bad_reply', 'reply_to must reference a message from the peer')
    if (taskId) this.getRoomTask(room, taskId)
    if (decisionId) this.getRoomDecision(room, decisionId)

    const hop = parent ? (parent.hop ?? 0) + 1 : 0
    const tooDeep = hop >= room.budgets.maxHops
    const overWakes = (room.wakes ?? 0) >= room.budgets.maxWakes
    const startedAt = room.activatedAt ? Date.parse(room.activatedAt) : this.now()
    const overTime = this.now() - startedAt > room.budgets.maxMinutes * 60_000
    const budgetReason = tooDeep ? 'hop_budget' : overWakes ? 'wake_budget' : overTime ? 'time_budget' : null
    if (budgetReason) {
      room.status = ROOM_STATUS.PAUSED
      room.pauseReason = budgetReason
      room.pausedBy = 'system'
    }

    const message = {
      id: newId('msg'),
      roomId: room.id,
      seq: ++room.seq,
      from: member,
      to: target,
      kind,
      body: text,
      hop,
      replyTo: parent?.id,
      taskId,
      decisionId,
      clientMessageId,
      createdAt: nowIso(this.clock),
      delivery: {
        state: budgetReason ? 'skipped' : 'saved',
        attempts: 0,
        updatedAt: nowIso(this.clock),
        detail: budgetReason ? `room paused: ${budgetReason}` : undefined,
      },
    }
    this.state.messages[message.id] = message
    if (dedupeKey) this.state.dedupe[dedupeKey] = message.id
    if (parent) {
      // A peer reply is independent evidence the message reached the peer, even
      // when an earlier delivery observation was uncertain or missing. Only move
      // the state when the machine permits it; otherwise keep the evidence ref.
      const allowed = DELIVERY_TRANSITIONS[parent.delivery.state] ?? []
      if (parent.delivery.state !== 'replied' && allowed.includes('replied')) {
        parent.delivery.state = 'replied'
        parent.delivery.updatedAt = nowIso(this.clock)
      }
      parent.repliedBy = message.id
    }
    if (!budgetReason) room.wakes = (room.wakes ?? 0) + 1
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      message,
      room: this.roomView(room, member),
      paused: Boolean(budgetReason),
      pauseReason: budgetReason ?? undefined,
    }
  }

  getRoomMessage(room, messageId) {
    const message = this.state.messages[messageId]
    if (!message || message.roomId !== room.id) fail('message_not_found', `message "${messageId}" is not in room ${room.id}`)
    return message
  }

  async markDelivery({ roomId, messageId, state, detail, evidence }) {
    const room = this.getRoom(roomId)
    const message = this.getRoomMessage(room, messageId)
    const previous = message.delivery.state
    assertTransition(previous, state)
    message.delivery = {
      ...message.delivery,
      state,
      detail,
      attempts: (message.delivery.attempts ?? 0) + (state === 'queued' && previous !== 'queued' ? 1 : 0),
      updatedAt: nowIso(this.clock),
      ...(evidence === undefined ? {} : { evidence }),
    }
    message.updatedAt = nowIso(this.clock)
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return message
  }

  /** Undelivered messages in a room for one target, oldest first. */
  savedFor(room, to, limit = 20) {
    if (!room || !to) return []
    const result = []
    for (const message of Object.values(this.state.messages)) {
      if (message.roomId !== room.id) continue
      if (message.to !== to) continue
      if (message.delivery?.state !== 'saved') continue
      result.push(message)
    }
    result.sort((a, b) => a.seq - b.seq)
    return result.slice(0, limit)
  }

  /**
   * Move every message of one transport unit to the same delivery state. Used
   * when several saved messages are delivered as one digest envelope.
   */
  async markBundleDelivery({ roomId, messageIds, state, detail, evidence }) {
    const room = this.getRoom(roomId)
    const updated = []
    for (const messageId of messageIds) {
      const message = this.getRoomMessage(room, messageId)
      // A fast peer can reply before the sender's transport call returns.
      // Preserve that stronger evidence instead of downgrading it to queued.
      if (message.delivery.state === 'replied') continue
      assertTransition(message.delivery.state, state)
      message.delivery = {
        ...message.delivery,
        state,
        detail,
        attempts: (message.delivery.attempts ?? 0) + (state === 'queued' ? 1 : 0),
        updatedAt: nowIso(this.clock),
        ...(evidence === undefined ? {} : { evidence }),
      }
      message.updatedAt = nowIso(this.clock)
      updated.push(message)
    }
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return updated
  }

  /** Messages in a room addressed to `member`, oldest first. */
  messagesFor(room, member, { since = 0, limit = 50 } = {}) {    const result = []
    for (const message of Object.values(this.state.messages)) {
      if (message.roomId !== room.id) continue
      if (message.seq <= since) continue
      if (message.from === member) continue
      if (message.to !== member) continue
      result.push(message)
    }
    result.sort((a, b) => a.seq - b.seq)
    return result.slice(0, limit)
  }

  roomHistory(room, { since = 0, limit = 50 } = {}) {
    const result = Object.values(this.state.messages)
      .filter((message) => message.roomId === room.id && message.seq > since)
      .sort((a, b) => a.seq - b.seq)
    return result.slice(0, limit)
  }

  async status({ member, identity, roomId, sinceSeq }) {
    const room = this.#roomForAction(member, identity, roomId)
    const since = Number.isFinite(sinceSeq) ? sinceSeq : room.lastSeen?.[member] ?? 0
    const messages = this.messagesFor(room, member, { since, limit: 100 })
    room.lastSeen[member] = room.seq
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return {
      room: this.roomView(room, member),
      messages,
      tasks: this.tasksFor(room, member),
      decisions: this.decisionsFor(room),
      sinceSeq: since,
      nextSeq: room.seq,
    }
  }

  async whoami({ member, identity }) {
    assertMember(member)
    const rooms = Object.values(this.state.rooms)
      .filter((room) => room.members?.[member]?.id === identity)
      .map((room) => this.roomView(room, member))
    return { member, identity, rooms }
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  tasksFor(room, member) {
    return Object.values(this.state.tasks)
      .filter((task) => task.roomId === room.id)
      .filter((task) => task.owner === null || task.owner === member || task.createdBy === member)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getRoomTask(room, taskId) {
    const task = this.state.tasks[taskId]
    if (!task || task.roomId !== room.id) fail('task_not_found', `task "${taskId}" is not in room ${room.id}`)
    return task
  }

  async taskAction({ member, identity, roomId, taskAction, ...input }) {
    assertMember(member)
    const room = this.#roomForAction(member, identity, roomId)
    if (!TASK_ACTIONS.includes(taskAction)) {
      fail('bad_task_action', `unknown task action "${taskAction}"`, { allowed: TASK_ACTIONS })
    }
    if (taskAction === 'list') {
      return { room: this.roomView(room, member), tasks: this.tasksFor(room, member) }
    }

    if (taskAction === 'create') {
      assertRoomStatus(room, [ROOM_STATUS.ACTIVE, ROOM_STATUS.PAUSED])
      const owner = input.owner === undefined || input.owner === null ? null : assertMember(input.owner)
      const title = clampText(input.title, 300, 'task title')
      const details = optionalText(input.details, 4000, 'task details')
      const acceptance = optionalText(input.acceptance, 2000, 'acceptance')
      const writeScopes = this.#validateWriteScopes(room, input.writeScopes)
      const task = {
        id: newId('task'),
        roomId: room.id,
        title,
        details,
        acceptance,
        owner,
        createdBy: member,
        status: owner === null ? 'open' : owner === member ? 'claimed' : 'proposed',
        writeScopes,
        blocked: false,
        blockedReason: null,
        revision: 1,
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
        completedAt: null,
        completionNote: null,
      }
      this.state.tasks[task.id] = task
      room.updatedAt = nowIso(this.clock)
      await this.save()
      return { room: this.roomView(room, member), task }
    }

    const task = this.getRoomTask(room, input.taskId)
    const isOwner = task.owner === member
    const isCreator = task.createdBy === member
    if (!isOwner && !isCreator && task.owner !== null) {
      fail('task_forbidden', `task ${task.id} belongs to ${MEMBER_LABELS[task.owner] ?? 'another member'}`)
    }

    switch (taskAction) {
      case 'claim': {
        if (task.status !== 'open' || task.owner !== null) fail('task_state', `task ${task.id} is not open for claiming`)
        task.owner = member
        task.status = 'claimed'
        break
      }
      case 'accept': {
        if (task.status !== 'proposed') fail('task_state', `task ${task.id} is not a proposal`)
        if (task.owner !== member) fail('task_forbidden', 'only the assignee can accept a proposed task')
        task.status = 'claimed'
        break
      }
      case 'start': {
        if (task.owner !== member) fail('task_forbidden', 'only the owner can start a task')
        if (!['claimed', 'proposed'].includes(task.status)) fail('task_state', `task ${task.id} cannot start from ${task.status}`)
        task.status = 'in_progress'
        break
      }
      case 'complete': {
        if (task.owner !== member && task.createdBy !== member) fail('task_forbidden', 'only the owner or creator can complete a task')
        if (!['claimed', 'in_progress', 'proposed'].includes(task.status)) fail('task_state', `task ${task.id} cannot complete from ${task.status}`)
        task.status = 'done'
        task.completedAt = nowIso(this.clock)
        task.completionNote = optionalText(input.note, 2000, 'note') ?? null
        break
      }
      case 'cancel': {
        if (!isOwner && !isCreator) fail('task_forbidden', 'only the owner or creator can cancel a task')
        if (task.status === 'done') fail('task_state', 'a completed task cannot be cancelled')
        task.status = 'cancelled'
        break
      }
      case 'update': {
        if (!isOwner && !isCreator) fail('task_forbidden', 'only the owner or creator can update a task')
        const revision = Number(input.revision)
        if (!Number.isFinite(revision) || revision !== task.revision) {
          fail('task_conflict', `task ${task.id} revision is ${task.revision}, got ${input.revision}`, {
            currentRevision: task.revision,
            task,
          })
        }
        if (input.title !== undefined) task.title = clampText(input.title, 300, 'task title')
        if (input.details !== undefined) task.details = optionalText(input.details, 4000, 'task details')
        if (input.acceptance !== undefined) task.acceptance = optionalText(input.acceptance, 2000, 'acceptance')
        if (input.blocked !== undefined) task.blocked = Boolean(input.blocked)
        if (input.blockedReason !== undefined) task.blockedReason = optionalText(input.blockedReason, 1000, 'blockedReason')
        if (input.writeScopes !== undefined) task.writeScopes = this.#validateWriteScopes(room, input.writeScopes)
        if (input.owner !== undefined) {
          const owner = input.owner === null ? null : assertMember(input.owner)
          task.owner = owner
          if (owner === null) task.status = 'open'
          else if (owner === member) task.status = task.status === 'in_progress' ? 'in_progress' : 'claimed'
          else task.status = 'proposed'
        }
        if (input.status !== undefined) {
          if (!['proposed', 'open', 'claimed', 'in_progress', 'done', 'cancelled'].includes(input.status)) {
            fail('bad_argument', `unknown task status "${input.status}"`)
          }
          task.status = input.status
        }
        task.revision += 1
        break
      }
      default:
        fail('bad_task_action', `task action "${taskAction}" is not implemented`)
    }
    task.updatedAt = nowIso(this.clock)
    room.updatedAt = nowIso(this.clock)
    await this.save()
    return { room: this.roomView(room, member), task }
  }

  #validateWriteScopes(room, input) {
    if (input === undefined || input === null) return []
    if (!Array.isArray(input)) fail('bad_argument', 'writeScopes must be an array of absolute paths')
    const declared = room.scope?.writeScopes ?? []
    return input.map((value) => {
      const scope = assertString(String(value), 'write scope', { max: 1000 })
      if (declared.length > 0) {
        const allowed = declared.some((prefix) => isWithin(scope, prefix))
        if (!allowed) fail('scope_violation', `write scope "${scope}" is outside the room's declared scope`, { declared })
      }
      return scope
    })
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  decisionsFor(room) {
    return Object.values(this.state.decisions)
      .filter((decision) => decision.roomId === room.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  getRoomDecision(room, decisionId) {
    const decision = this.state.decisions[decisionId]
    if (!decision || decision.roomId !== room.id) {
      fail('decision_not_found', `decision "${decisionId}" is not in room ${room.id}`)
    }
    return decision
  }

  async decisionAction({ member, identity, roomId, decisionAction, ...input }) {
    assertMember(member)
    const room = this.#roomForAction(member, identity, roomId)
    if (!DECISION_ACTIONS.includes(decisionAction)) {
      fail('bad_decision_action', `unknown decision action "${decisionAction}"`, { allowed: DECISION_ACTIONS })
    }
    if (decisionAction === 'list') {
      return { room: this.roomView(room, member), decisions: this.decisionsFor(room) }
    }
    if (decisionAction === 'propose') {
      assertRoomStatus(room, [ROOM_STATUS.ACTIVE, ROOM_STATUS.PAUSED])
      const question = clampText(input.question, 1000, 'question')
      if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 6) {
        fail('bad_argument', 'options must contain 2 to 6 choices')
      }
      const options = input.options.map((option, index) => {
        if (typeof option !== 'string') {
          fail('bad_argument', `option ${index + 1} must be a string`, { received: typeof option })
        }
        return clampText(option, 300, `option ${index + 1}`)
      })
      if (new Set(options).size !== options.length) {
        fail('bad_argument', 'options must be distinct choices')
      }
      const decision = {
        id: newId('dec'),
        roomId: room.id,
        question,
        options,
        proposedBy: member,
        status: 'proposed',
        confirmations: {},
        outcome: null,
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
      }
      this.state.decisions[decision.id] = decision
      room.updatedAt = nowIso(this.clock)
      await this.save()
      return { room: this.roomView(room, member), decision }
    }

    const decision = this.getRoomDecision(room, input.decisionId)
    if (decision.status !== 'proposed') fail('decision_state', `decision ${decision.id} is already ${decision.status}`)
    if (decisionAction === 'reject') {
      decision.status = 'rejected'
      decision.rejectedBy = member
      decision.note = optionalText(input.note, 1000, 'note') ?? null
      decision.updatedAt = nowIso(this.clock)
      await this.save()
      return { room: this.roomView(room, member), decision }
    }
    if (decisionAction === 'confirm') {
      const choice = assertString(input.choice, 'choice', { max: 300 })
      if (!decision.options.includes(choice)) {
        fail('bad_argument', `choice must be one of: ${decision.options.join(' | ')}`)
      }
      decision.confirmations[member] = { choice, at: nowIso(this.clock) }
      const dsh = decision.confirmations.dsh
      const codex = decision.confirmations.codex
      if (dsh && codex) {
        if (dsh.choice === codex.choice) {
          decision.status = 'confirmed'
          decision.outcome = dsh.choice
        } else {
          decision.status = 'conflict'
          decision.conflict = { dsh: dsh.choice, codex: codex.choice }
        }
      }
      decision.updatedAt = nowIso(this.clock)
      await this.save()
      return { room: this.roomView(room, member), decision }
    }
    fail('bad_decision_action', `decision action "${decisionAction}" is not implemented`)
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * After a host restart, in-flight deliveries are not provably delivered.
   * Mark them `unknown` instead of silently retrying a message that may have
   * already produced a turn.
   */
  async recover() {
    let changed = 0
    const now = nowIso(this.clock)
    for (const ledger of Object.values(this.state.wakeLedger)) {
      if (ledger.pending?.state !== 'reserved') continue
      ledger.pending.state = 'unknown'
      ledger.pending.reconciliationId ??= newId('reconcile')
      changed += 1
    }
    for (const message of Object.values(this.state.messages)) {
      const state = message.delivery?.state
      if (state === 'queued' || state === 'processing') {
        message.delivery.state = 'unknown'
        message.delivery.detail = 'host restarted before delivery could be confirmed; verify the peer session before resending'
        message.delivery.updatedAt = now
        changed += 1
      }
    }
    for (const room of Object.values(this.state.rooms)) {
      if (room.status === ROOM_STATUS.PAIRING && room.codeExpiresAt && room.codeExpiresAt < this.now()) {
        room.status = ROOM_STATUS.PAUSED
        room.pauseReason = 'pairing_expired'
        room.pausedBy = 'system'
        room.updatedAt = now
        changed += 1
      }
    }
    this.recoveredAt = now
    if (changed > 0) await this.save()
    return { changed, recoveredAt: now }
  }
}

function normalizeWriteScopes(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail('bad_argument', 'scope.writeScopes must be an array')
  return value.map((entry) => assertString(String(entry), 'write scope', { max: 1000 }))
}

function integerInRange(value, min, max, name) {
  if (value === undefined || value === null || value === '') return 0
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('bad_argument', `${name} must be an integer in [${min}, ${max}]`, { received: value })
  }
  return number
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function isWithin(candidate, prefix) {
  const left = normalizePath(candidate)
  const right = normalizePath(prefix)
  return left === right || left.startsWith(`${right}/`)
}

export { MESSAGE_KINDS }
