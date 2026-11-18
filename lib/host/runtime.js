import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Bridge } from '../core/bridge.js'
import { formatDigest, formatEnvelope, formatRoomContext, wakeInstruction } from '../core/envelope.js'
import { newId } from '../core/ids.js'
import { errorPayload, fail } from '../core/errors.js'
import { JsonFileStore } from '../core/store.js'
import { DEFAULT_BUDGETS, DEFAULT_RETENTION, ROOM_STATUS } from '../core/protocol.js'
import { CodexCli } from './codex-cli.js'
import { DshDelivery } from './dsh-delivery.js'
import { HttpServer } from './http-server.js'
import { VERSION } from '../version.js'
import { DesktopCodex } from './desktop-codex.js'

const HOST_FILE_VERSION = 1

const DEFAULTS = {
  port: 0,
  sendWaitMs: 8_000,
  codexTimeoutMs: 90_000,
  dshResumeTimeoutMs: 45_000,
  probeDelaysMs: [1_500, 5_000, 15_000],
  sweepMs: 60_000,
  desktopPollMs: 2000,
  maxBodyChars: 6_000,
  digestMaxMessages: 20,
  retention: DEFAULT_RETENTION,
  ...DEFAULT_BUDGETS,
}

/**
 * Host-side orchestration: one Bridge per DSH profile, one authenticated
 * loopback API, and per-room serialized delivery. This is the only layer that
 * knows both DSH and Codex; the core protocol stays transport-free.
 */
export class BridgeRuntime {
  constructor({ ctx, config = {}, logger } = {}) {
    if (!ctx?.agents) throw new Error('BridgeRuntime requires ctx.agents')
    this.ctx = ctx
    this.logger = logger ?? ctx.logger
    this.config = {
      ...DEFAULTS,
      ...config,
      retention: { ...DEFAULT_RETENTION, ...(config.retention ?? {}) },
    }
    this.dshHome = config.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
    this.profile = config.profile ?? process.env.DSH_PROFILE ?? 'desktop'
    this.dir = path.join(this.dshHome, 'bridge', safeSegment(this.profile))
    this.stateFile = path.join(this.dir, 'bridge.json')
    this.hostFile = path.join(this.dir, 'host.json')

    this.store = new JsonFileStore(this.stateFile)
    this.bridge = new Bridge({ store: this.store, config: this.config })
    this.codex = config.codexCli ?? new CodexCli({ codexPath: this.config.codexPath, timeoutMs: this.config.codexTimeoutMs })
    this.desktop = config.desktopCodex === false ? null : config.desktopCodex ?? new DesktopCodex({ pipePath: config.codexDesktopPipe })
    this.desktopTimer = null
    this.desktopPoll = null
    this.delivery =
      config.dshDelivery ??
      new DshDelivery({
        agents: ctx.agents,
        timeoutMs: this.config.dshResumeTimeoutMs,
        logger: this.logger,
      })
    this.http = null
    this.port = null
    this.token = null
    this.startedAt = null
    this.queues = new Map()
    this.probeTimers = new Set()
    this.sweepTimer = null
    this.retentionTimer = null
    this.codexInfo = null
    this.stopping = false
    this.lifecycleQueues = new Map()
  }

  async start() {
    this.stopping = false
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await this.bridge.init()
    const recovery = await this.bridge.recover()
    const retained = await this.bridge.retentionSweep().catch((error) => {
      this.logger?.warn?.('[dsh-codex-bridge] retention sweep failed', error)
      return null
    })
    if (retained && (retained.removed > 0 || Object.keys(retained.trimmed).length > 0)) {
      this.logger?.info?.(
        `[dsh-codex-bridge] retention removed ${retained.removed} room(s), trimmed ${Object.values(retained.trimmed).reduce((sum, n) => sum + n, 0)} message(s)`,
      )
    }
    this.codexInfo = await this.codex.resolve().catch(() => ({ file: null, version: null, source: 'probe_failed' }))

    this.token = this.config.token ?? randomBytes(32).toString('hex')
    this.http = new HttpServer({ runtime: this, token: this.token, host: '127.0.0.1' })
    this.port = await this.http.listen(this.config.port)
    this.startedAt = new Date().toISOString()
    await this.#writeHostFile()

    this.sweepTimer = setInterval(() => {
      this.sweepBudgets().catch((error) => this.logger?.warn?.('bridge sweep failed', error))
    }, this.config.sweepMs)
    this.sweepTimer.unref?.()

    this.retentionTimer = setInterval(() => {
      this.bridge.retentionSweep().catch((error) => this.logger?.warn?.('bridge retention failed', error))
    }, this.config.retention.sweepMs)
    this.retentionTimer.unref?.()
    if (this.desktop) {
      this.desktopTimer = setInterval(() => {
        this.pollDesktop().catch((error) => this.logger?.warn?.('bridge desktop observation failed', error))
      }, Math.max(500, Number(this.config.desktopPollMs) || 2000))
      this.desktopTimer.unref?.()
    }

    const info = this.health()
    this.logger?.info?.(
      `[dsh-codex-bridge] listening on ${info.url} (profile ${this.profile}), recovered ${recovery.changed} in-flight state(s)`,
    )
    return info
  }

  async stop() {
    this.stopping = true
    if (this.desktopTimer) clearInterval(this.desktopTimer)
    this.desktopTimer = null
    this.desktop?.close()
    await this.desktopPoll?.catch(() => {})
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    this.retentionTimer = null
    for (const timer of this.probeTimers) clearTimeout(timer)
    this.probeTimers.clear()
    await this.http?.close()
    await Promise.allSettled([...this.lifecycleQueues.values()])
    await this.store.pending.catch(() => {})
    await this.#removeHostFile()
  }

  health() {
    return {
      name: 'dsh-codex-bridge',
      version: VERSION,
      pid: process.pid,
      profile: this.profile,
      dshHome: this.dshHome,
      stateFile: this.stateFile,
      startedAt: this.startedAt,
      url: `http://127.0.0.1:${this.port}`,
      codex: this.codexInfo,
      codexTransport: this.desktop ? 'desktop-native' : 'legacy-cli',
      rooms: Object.keys(this.bridge.state?.rooms ?? {}).length,
      tombstones: Object.keys(this.bridge.state?.tombstones ?? {}).length,
      retention: this.config.retention,
    }
  }

  async #writeHostFile() {
    const payload = {
      version: HOST_FILE_VERSION,
      name: 'dsh-codex-bridge',
      pid: process.pid,
      profile: this.profile,
      startedAt: this.startedAt,
      host: '127.0.0.1',
      port: this.port,
      url: `http://127.0.0.1:${this.port}`,
      token: this.token,
    }
    const temp = `${this.hostFile}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    await renameWithRetry(temp, this.hostFile)
  }

  async #removeHostFile() {
    try {
      const current = JSON.parse(await readFile(this.hostFile, 'utf8'))
      if (current.pid !== process.pid || current.startedAt !== this.startedAt) return
      await rm(this.hostFile, { force: true })
    } catch {
      // Already absent or unreadable; nothing to undo.
    }
  }

  // ---------------------------------------------------------------------------
  // Tool surface (shared by the DSH tool and the Codex MCP adapter)
  // ---------------------------------------------------------------------------

  /**
   * @param {{member:'dsh'|'codex', identity:string, meta?:object, args?:object}} request
   */
  async toolCall(request = {}) {
    const result = await this.#toolCall(request)
    const { member, identity, meta = {}, args = {} } = request
    if (this.desktop && member === 'codex' && !this.stopping) {
      const room = this.bridge.findRoomFor(member, identity)
      if (room && ['active', 'paused'].includes(room.status) && !result.incoming && !['availability', 'checkpoint'].includes(args.action)) {
        await this.#observeDesktop(room)
        const incoming = await this.lifecycle({ member, identity, event: 'PostToolUse',
          turnId: meta.turnId || room.deliveryFlow.codex.hostTurnId || 'bridge-current-turn', eventId: meta.callId || newId('call') })
        if (incoming.incoming || incoming.controlNotices?.length) return { ...result, incoming: incoming.incoming,
          controlNotices: [...(result.controlNotices ?? []), ...(incoming.controlNotices ?? [])] }
      }
    }
    return result
  }

  async #toolCall({ member, identity, meta = {}, args = {} } = {}) {
    if (member !== 'dsh' && member !== 'codex') fail('bad_member', `unknown member "${member}"`)
    const self = String(identity ?? '').trim()
    if (!self) fail('identity_unavailable', 'the current session identity is unavailable', {
      hint: 'Codex 0.168 supplies _meta.threadId; DSH supplies exec.agent.id. Pass thread_id/session_id explicitly only as a manual fallback.',
    })
    this.#assertIdentityShape(member, self)

    const action = String(args.action ?? '').trim()
    switch (action) {
      case 'whoami':
        return this.#whoami(member, self)
      case 'create':
        return this.#create(member, self, meta, args)
      case 'join':
        return this.#join(member, self, meta, args)
      case 'status':
        return this.#status(member, self, args)
      case 'send':
        return this.#send(member, self, meta, args)
      case 'availability':
        return this.#availability(member, self, args)
      case 'checkpoint':
        return this.#availability(member, self, { ...args, status: 'ready' })
      case 'ack_wake': {
        const acknowledged = await this.bridge.ackWake({ member, identity: self, wakeId: args.wake_id, reconciliationId: args.reconcile_id, userConfirmed: args.user_confirmed === true })
        const room = this.bridge.findRoomFor(member, self)
        if (room && ['active', 'paused'].includes(room.status) && !acknowledged.duplicate) await this.bridge.setAvailability({ member, identity: self, roomId: room.id, status: 'busy' })
        return { action: 'ack_wake', ...acknowledged }
      }
      case 'task':
        return this.#task(member, self, args)
      case 'decide':
        return this.#decide(member, self, args)
      case 'pause':
        return this.#control('pause', member, self, args)
      case 'resume':
        return this.#control('resume', member, self, args)
      case 'end':
        return this.#control('end', member, self, args)
      case 'leave':
        return this.#control('leave', member, self, args)
      case 'budget_request':
        return this.#budgetRequest(member, self, args)
      case 'budget_approve':
      case 'budget_reject':
        return this.#budgetDecision(action, member, self, args)
      case 'delete':
        return this.#delete(member, self, args)
      case 'adopt':
        return this.#adopt(member, self, args)
      case 'handoff_code':
        return this.#handoffCode(member, self, args)
      case 'rebind':
        return this.#rebind(member, self, args)
      default:
        fail('bad_action', `unknown bridge action "${action}"`, {
          allowed: [
            'whoami',
            'create',
            'join',
            'status',
            'send',
            'availability',
            'checkpoint',
            'ack_wake',
            'task',
            'decide',
            'pause',
            'resume',
            'end',
            'leave',
            'budget_request',
            'budget_approve',
            'budget_reject',
            'adopt',
            'handoff_code',
            'rebind',
            'delete',
          ],
        })
    }
  }

  async #observeDesktop(room) {
    const identity = room.codexThreadId
    const receiptWakeId = this.bridge.wakeFor('codex', identity)?.pending?.id
    const snapshot = await this.desktop.snapshot(identity, { receiptWakeId }).catch(() => ({ threadId: identity, unavailable: 'desktop_connection_failed' }))
    if (this.stopping || room.codexThreadId !== identity || !['active', 'paused'].includes(room.status)) return null
    const flow = room.deliveryFlow.codex
    flow.desktopObservation = { status: snapshot.status?.type ?? 'unavailable', turnId: snapshot.turn?.id,
      turnStatus: snapshot.turn?.status, observedAt: new Date().toISOString(), reason: snapshot.unavailable }
    const pending = this.bridge.wakeFor('codex', identity)?.pending
    if (pending && !pending.legacy && snapshot.wakeIds?.includes(pending.id)) {
      await this.bridge.ackWake({ member: 'codex', identity, wakeId: pending.id })
    }
    if (this.stopping || room.codexThreadId !== identity || !['active', 'paused'].includes(room.status)) return null
    const blocked = !snapshot.status || snapshot.status.type === 'notLoaded' || snapshot.status.type === 'systemError' ||
      snapshot.status.activeFlags?.length > 0 || ['interrupted', 'failed'].includes(snapshot.turn?.status) ||
      (snapshot.status.type === 'idle' && snapshot.turn && snapshot.turn.status !== 'completed')
    await this.bridge.hostBoundary(room, 'codex', {
      turnId: snapshot.turn?.id, blocked,
      idle: snapshot.status?.type === 'idle' && !blocked,
    })
    return snapshot
  }

  /** Observe only explicitly paired threads. Polling never forces a busy client awake. */
  async pollDesktop() {
    if (!this.desktop || this.stopping) return
    if (this.desktopPoll) return this.desktopPoll
    this.desktopPoll = (async () => {
      for (const room of Object.values(this.bridge.state.rooms)) {
        if (this.stopping) break
        if (!['active', 'paused'].includes(room.status) || !room.codexThreadId) continue
        const saved = this.bridge.savedFor(room, 'codex', 1)
        const notices = (room.controlNotices ?? []).filter((n) => n.to === 'codex' && !n.readAt && n.state === 'saved')
        if (!saved.length && !notices.length && !this.bridge.wakeFor('codex', room.codexThreadId)?.pending) continue
        await this.#observeDesktop(room)
        if (this.stopping) break
        if (room.status === ROOM_STATUS.ACTIVE && saved.length) await this.#enqueueDelivery(room.id, saved[0].id)
        if (notices.length) await this.#sendControl(room, 'codex', notices[0])
      }
    })().finally(() => { this.desktopPoll = null })
    return this.desktopPoll
  }

  #assertIdentityShape(member, identity) {
    if (member === 'codex' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity)) {
      fail('bad_thread_id', `"${identity}" is not a real Codex thread id`, {
        hint: 'Use the thread UUID from the Codex call metadata; never a title or a guessed id.',
      })
    }
    if (member === 'dsh' && !/^[A-Za-z0-9._:-]{6,200}$/.test(identity)) {
      fail('bad_session_id', `"${identity}" is not a plausible DSH session id`)
    }
  }

  /** Called by native DSH events / authenticated Codex hooks, never by peer text. */
  async lifecycle(request = {}) {
    const { member, identity } = request
    if (!['dsh', 'codex'].includes(member)) fail('bad_member', 'invalid lifecycle member')
    this.#assertIdentityShape(member, identity)
    const key = `${member}:${identity}`
    const previous = this.lifecycleQueues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.#lifecycleNow(request))
    const tail = run.catch(() => {})
    this.lifecycleQueues.set(key, tail)
    tail.finally(() => { if (this.lifecycleQueues.get(key) === tail) this.lifecycleQueues.delete(key) })
    return run
  }

  async #lifecycleNow({ member, identity, event, turnId, eventId, wakeId, signal } = {}) {
    if (this.stopping || signal?.aborted) return { ignored: 'stopping_or_aborted' }
    const allowed = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'step', 'claimed', 'idle']
    if (!allowed.includes(event)) fail('bad_lifecycle_event', 'unsupported native event')
    const receipt = wakeId && this.bridge.wakeFor(member, identity)?.pending
    if (receipt && !receipt.legacy && receipt.id === wakeId) {
      await this.bridge.ackWake({ member, identity, wakeId })
    }
    // Inbox claim is receipt evidence even if a new DSH turn has not reached
    // pre-step yet. It must not change the running-turn identity.
    if (event === 'claimed') return { received: Boolean(receipt) }
    const room = this.bridge.findRoomFor(member, identity)
    if (!room || !['active', 'paused'].includes(room.status)) return { ignored: 'not_paired' }
    const flow = room.deliveryFlow[member]
    turnId = String(turnId ?? '').slice(0, 200)
    if (!turnId) return { ignored: 'missing_turn' }
    if (event === 'UserPromptSubmit' || event === 'step') {
      // A real new turn may resume work after an interruption. Old delayed
      // callbacks cannot reopen a later turn or a completed turn.
      if (flow.hostClosedTurns?.includes(turnId)) return { ignored: 'closed_turn' }
      if (flow.hostTurnId !== turnId) {
        if (flow.hostTurnId) flow.hostClosedTurns = [...(flow.hostClosedTurns ?? []), flow.hostTurnId].slice(-32)
        flow.hostBlocked = false
      }
      flow.hostTurnId = turnId
    } else {
      if (flow.hostClosedTurns?.includes(turnId)) return { ignored: 'closed_turn' }
      if (flow.hostTurnId && flow.hostTurnId !== turnId) return { ignored: 'stale_turn' }
      flow.hostTurnId = turnId
    }
    if (event === 'Interrupt' || event === 'PermissionRequest') {
      flow.hostWaitTool = event === 'PermissionRequest' ? eventId : null
      await this.bridge.hostBoundary(room, member, { turnId, blocked: true })
      return { blocked: true }
    }
    // A completed tool confirms that its approval wait has ended.
    if (event === 'PostToolUse' && eventId && flow.hostWaitTool === eventId) {
      flow.hostBlocked = false
      flow.hostWaitTool = null
    }
    if (flow.hostBlocked) return { ignored: 'awaiting_user_or_interrupted' }
    if (event === 'idle') {
      if (member !== 'dsh' || !flow.hostReadyForIdle) return { ignored: 'no_normal_stop' }
      flow.hostReadyForIdle = false
      await this.bridge.hostBoundary(room, member, { idle: true, turnId })
      const saved = this.bridge.savedFor(room, member, 1)
      if (room.status === ROOM_STATUS.ACTIVE && saved.length) await this.#enqueueDelivery(room.id, saved[0].id)
      return { idle: flow.status === 'idle' }
    }
    const key = eventId ? `${turnId}:${event}:${String(eventId).slice(0, 200)}` : null
    if (key && flow.hostEvents?.includes(key)) return { ignored: 'duplicate_event' }
    flow.hostReadyForIdle = false
    if (key) flow.hostEvents = [...(flow.hostEvents ?? []), key].slice(-64)
    await this.bridge.hostBoundary(room, member, { turnId })
    if (event === 'UserPromptSubmit' || event === 'PreToolUse') return { running: true }
    let incoming = null
    if (room.status === ROOM_STATUS.ACTIVE) {
      const taken = await this.bridge.takeHostMail(room, member, this.config.digestMaxMessages)
      if (taken) {
        const options = { maxBodyChars: this.config.maxBodyChars, batchId: taken.batchId }
        incoming = { batchId: taken.batchId, messageIds: taken.messages.map((m) => m.id), count: taken.messages.length,
          text: taken.messages.length > 1 ? formatDigest(room, taken.messages, options) : formatEnvelope(room, taken.messages[0], options) }
      }
    }
    const controlNotices = await this.bridge.takeControlNotices(room, member)
    if (event === 'Stop' && !incoming && !controlNotices.length) {
      // No timeouts, no invented business completion, and no discarded wake receipt.
      await this.bridge.hostBoundary(room, member, { idle: true, turnId, provisional: member === 'dsh' })
      if (member === 'dsh') {
        // turn-stopping is provisional: racing steering can reopen the same
        // turn. Only the subsequent native idle transition rearms a wake.
        flow.hostReadyForIdle = true
        flow.hostPhase = 'stopping'
        flow.status = 'busy'
      } else flow.hostClosedTurns = [...(flow.hostClosedTurns ?? []), turnId].slice(-32)
      await this.bridge.save()
    }
    return { incoming, controlNotices, idle: flow.status === 'idle' }
  }

  async #whoami(member, identity) {
    const result = await this.bridge.whoami({ member, identity })
    return { action: 'whoami', ...result }
  }

  async #create(member, identity, meta, args) {
    const cwd = resolveCwd(args.cwd ?? meta.cwd, this.config.defaultCwd)
    const room = await this.bridge.createRoom({
      member,
      identity,
      goal: args.goal,
      cwd,
      title: args.title,
      scope: normalizeScope(args.scope, cwd),
      budgets: budgetsFromArgs(args),
    })
    return {
      action: 'create',
      ...room,
      member,
      identity,
      next: `等待用户在 ${member === 'dsh' ? 'Codex' : 'DSH'} 会话中输入配对码 ${room.code}。配对码一次性、默认 30 分钟有效。`,
    }
  }

  async #join(member, identity, meta, args) {
    const cwd = resolveCwd(args.cwd ?? meta.cwd, this.config.defaultCwd)
    const result = await this.bridge.joinRoom({ member, identity, code: args.code, cwd })
    return {
      action: 'join',
      ...result,
      member,
      identity,
      next: result.room.status === 'active' ? '房间已激活，可直接协作。' : '已加入，等待对端绑定。',
    }
  }

  async #status(member, identity, args) {
    const result = await this.bridge.status({
      member,
      identity,
      roomId: args.room_id,
      sinceSeq: numberOrUndefined(args.since_seq),
    })
    const controlNotices = await this.bridge.takeControlNotices(this.bridge.getRoom(result.room.id), member)
    return { action: 'status', ...result, controlNotices }
  }

  async #send(member, identity, meta, args) {
    const kind = args.kind ?? (args.reply_to ? 'reply' : 'notice')
    const result = await this.bridge.sendMessage({
      member,
      identity,
      roomId: args.room_id,
      kind,
      body: args.body,
      to: args.to,
      replyTo: args.reply_to,
      taskId: args.task_id,
      decisionId: args.decision_id,
      clientMessageId: args.client_message_id ?? meta.callId,
    })
    const base = {
      action: 'send',
      message: result.message,
      room: result.room,
      duplicate: result.duplicate ?? false,
      paused: result.paused ?? false,
      pauseReason: result.pauseReason ?? null,
    }
    if (result.duplicate) return base
    if (result.message.delivery.state === 'skipped') {
      return {
        ...base,
        delivery: result.message.delivery,
        note: /_budget$/.test(result.pauseReason ?? '')
          ? `自动投递已跳过：预算 ${result.pauseReason} 已用尽，房间已暂停。请用 budget_request 向用户申请追加预算，不要自行 reset。`
          : `自动投递已跳过：${result.pauseReason ?? '房间未激活'}。房间已暂停，需用户或成员 resume。`,
      }
    }

    const delivery = await this.#enqueueDelivery(result.room.id, result.message.id)
    return {
      ...base,
      message: this.#message(result.room.id, result.message.id),
      delivery: delivery.timedOut
        ? { state: 'saved', detail: 'delivery is still running in the background' }
        : delivery,
      delivery_pending: delivery.timedOut === true,
      ...(delivery.held
        ? { note: '已存入桥发件箱。对端在工作检查点调用 checkpoint 直接取消息；只有结束本轮、准备等待时才 availability idle。已入队唤醒另需实际收到信封后的 ack_wake，不能用业务处理回执代替。' }
        : {}),
    }
  }

  async #availability(member, identity, args) {
    const result = await this.bridge.setAvailability({
      member, identity, roomId: args.room_id, status: args.status, batchId: args.batch_id,
    })
    const room = this.bridge.getRoom(result.room.id)
    let incoming = null
    if (['ready', 'idle'].includes(args.status) && room.status === ROOM_STATUS.ACTIVE) {
      incoming = await this.#pullSaved(room, member, result.duplicate)
    }
    return {
      action: 'availability', ...result,
      room: this.bridge.roomView(this.bridge.getRoom(result.room.id), member),
      incoming,
      controlNotices: await this.bridge.takeControlNotices(room, member),
    }
  }

  async #task(member, identity, args) {
    const result = await this.bridge.taskAction({
      member,
      identity,
      roomId: args.room_id,
      taskAction: args.task_action,
      taskId: args.task_id,
      title: args.title,
      details: args.details,
      acceptance: args.acceptance,
      owner: args.owner,
      writeScopes: args.write_scopes,
      status: args.status,
      blocked: args.blocked,
      blockedReason: args.blocked_reason,
      revision: args.revision,
      note: args.note,
    })
    return {
      action: 'task',
      task_action: args.task_action,
      ...result,
    }
  }

  async #decide(member, identity, args) {
    const result = await this.bridge.decisionAction({
      member,
      identity,
      roomId: args.room_id,
      decisionAction: args.decision_action,
      decisionId: args.decision_id,
      question: args.question,
      options: args.options,
      choice: args.choice,
      note: args.note,
    })
    return { action: 'decide', decision_action: args.decision_action, ...result }
  }

  async #control(which, member, identity, args) {
    const common = { member, identity, roomId: args.room_id }
    let result
    if (which === 'pause') result = await this.bridge.pauseRoom({ ...common, reason: args.reason })
    if (which === 'resume') result = await this.bridge.resumeRoom({ ...common, resetBudget: args.reset_budget === true })
    if (which === 'end') result = await this.bridge.endRoom({ ...common, summary: args.summary })
    if (which === 'leave') result = await this.bridge.leaveRoom(common)
    return { action: which, ...result }
  }

  async #delete(member, identity, args) {
    const result = await this.bridge.deleteRoom({
      member,
      identity,
      roomId: args.room_id,
      userConfirmed: args.user_confirmed === true,
      reason: args.reason,
    })
    return {
      action: 'delete',
      ...result,
      note: '房间及其消息、任务、决策已永久删除；仅保留一条 tombstone 供审计。',
    }
  }

  async #budgetRequest(member, identity, args) {
    const result = await this.bridge.requestBudget({
      member,
      identity,
      roomId: args.room_id,
      addWakes: args.add_wakes,
      addMinutes: args.add_minutes,
      addHops: args.add_hops,
      reason: args.reason,
    })
    const room = this.bridge.getRoom(result.room.id)
    let notified = null
    if (!result.existing && member === 'codex') {
      notified = await this.#notifyDshBudgetRequest(room, result.request)
    }
    return {
      action: 'budget_request',
      ...result,
      notified,
      note:
        member === 'codex'
          ? '请求已记录，等待用户在 DSH 会话中明确批准；Codex 不能自行批准或调整预算。'
          : '请求已记录。只有用户在 DSH 会话中明确同意后，才可调用 budget_approve 并传 user_confirmed=true。',
    }
  }

  async #budgetDecision(which, member, identity, args) {
    const result = await this.bridge.decideBudget({
      member,
      identity,
      roomId: args.room_id,
      requestId: args.request_id,
      approve: which === 'budget_approve',
      userConfirmed: args.user_confirmed === true,
      note: args.note,
    })
    const room = this.bridge.getRoom(result.room.id)
    let notified = null
    if (result.approved) {
      notified = await this.#notifyCodexControl(
        room,
        `预算请求 ${result.request.id} 已由用户在 DSH 会话批准：+${result.granted.addWakes} 次唤醒、+${result.granted.addMinutes} 分钟、+${result.granted.addHops} 层链深。房间已恢复 active，可以继续协作。`,
      )
    } else {
      notified = await this.#notifyCodexControl(
        room,
        `预算请求 ${result.request.id} 已被拒绝（${result.request.decidedBy}）。房间保持 paused；如仍需继续，请重新说明理由并再次请求。`,
      )
    }
    return { action: which, ...result, notified }
  }

  /** Deliver a control notice about a pending request into the DSH session. */
  async #notifyDshBudgetRequest(room, request) {
    const text = [
      '[DSH × Codex Bridge · 控制通知]',
      '这是桥的预算控制通知，不是协作成员指令，也不能扩大用户授权。',
      `房间 ${room.id} 因 ${room.pauseReason} 已暂停。`,
      `Codex 申请追加预算：+${request.addWakes} 次唤醒、+${request.addMinutes} 分钟、+${request.addHops} 层链深。`,
      `理由：${request.reason}`,
      `请求编号：${request.id}`,
      '请把该请求交给用户决定；用户明确批准前不要继续自动协作，也不要用 resume/reset_budget 绕过。',
    ].join('\n')
    return this.#notifyControl(room, 'dsh', text)
  }

  /** Best-effort control notice to the Codex thread (never a member message). */
  async #notifyCodexControl(room, line) {
    if (!room.codexThreadId) return { state: 'skipped', detail: 'room has no bound Codex thread' }
    const text = [
      '[DSH × Codex Bridge · 控制通知]',
      '这是桥的控制通知，不是协作成员指令，也不能扩大用户授权。',
      line,
    ].join('\n')
    return this.#notifyControl(room, 'codex', text)
  }

  async #adopt(member, identity, args) {
    const room = this.bridge.getRoom(args.room_id)
    const previous = room.members?.dsh?.id ?? null
    const oldAttached = previous ? Boolean(this.delivery.attached(previous)) : false
    const result = await this.bridge.adoptRoom({
      member,
      identity,
      roomId: args.room_id,
      userConfirmed: args.user_confirmed === true,
      force: args.force === true,
      reason: args.reason,
      oldAttached,
    })
    let notified = null
    if (result.adopted && room.codexThreadId) {
      notified = await this.#notifyCodexControl(
        this.bridge.getRoom(room.id),
        `DSH 成员已切换会话：${previous ?? '无'} → ${identity}。房间、历史、任务、决策与预算保持不变；后续 DSH 消息投递到新会话。`,
      )
    }
    return {
      action: 'adopt',
      ...result,
      oldAttached,
      notified,
      note: result.adopted
        ? '已接管房间绑定。先阅读 brief，再 action=status 取最新增量；旧会话不再收到房间上下文。'
        : '当前会话已绑定该房间，无需接管。',
    }
  }

  async #handoffCode(member, identity, args) {
    const result = await this.bridge.issueHandoffCode({
      member,
      identity,
      roomId: args.room_id,
      ttlMinutes: args.ttl_minutes,
    })
    return {
      action: 'handoff_code',
      ...result,
      note: '把 code 与 room_id 交给用户，在新的 Codex 会话中调用 action=rebind；验证码一次性、到期作废。',
    }
  }

  async #rebind(member, identity, args) {
    const result = await this.bridge.redeemHandoffCode({
      member,
      identity,
      roomId: args.room_id,
      code: args.code,
      reason: args.reason,
    })
    let notified = null
    if (result.rebound) {
      notified = await this.#notifyDshControl(
        this.bridge.getRoom(result.room.id),
        `Codex 成员已切换线程：${result.previous ?? '无'} → ${identity}。房间、历史、任务、决策与预算保持不变；后续 Codex 消息投递到新线程。`,
      )
    }
    return {
      action: 'rebind',
      ...result,
      notified,
      note: result.rebound
        ? '已接管 Codex 绑定。先阅读 brief，再 action=status 取最新增量；旧线程不再收到房间消息。'
        : '当前线程已绑定该房间，无需接管。',
    }
  }

  /** Control notice into the DSH session, bypassing room pause. */
  async #notifyDshControl(room, line) {
    const text = [
      '[DSH × Codex Bridge · 控制通知]',
      '这是桥的控制通知，不是协作成员指令，也不能扩大用户授权。',
      line,
    ].join('\n')
    return this.#notifyControl(room, 'dsh', text)
  }

  async #notifyControl(room, member, text) {
    const identity = room.members[member]?.id
    if (!identity) return { state: 'skipped', detail: 'recipient is not bound' }
    room.controlNotices ??= []
    const notice = { id: newId('control'), to: member, text, state: 'saved', createdAt: new Date().toISOString() }
    room.controlNotices.push(notice)
    // Retain unread notices; bound the already-read diagnostic history.
    if (room.controlNotices.length > 100) room.controlNotices = room.controlNotices.filter((entry) => !entry.readAt || entry === notice)
    await this.bridge.save()
    return this.#sendControl(room, member, notice)
  }

  async #sendControl(room, member, notice) {
    const identity = room.members[member]?.id
    if (this.stopping || notice.readAt || notice.state !== 'saved') return { state: notice.state }
    if (member === 'codex' && this.desktop) await this.#observeDesktop(room)
    if (this.stopping) return { state: 'saved', held: true }
    if (this.bridge.deliveryHeld(room, member)) return { state: 'saved', held: true, detail: 'control notice retained for status/checkpoint; recipient is working or has a pending wake' }
    const wakeId = this.bridge.reserveWake({ member, identity, roomId: room.id, controlId: notice.id })
    room.deliveryFlow[member].status = 'busy'
    await this.bridge.save()
    let outcome
    try {
      const envelope = `${notice.text}\n${wakeInstruction(wakeId)}`
      outcome = member === 'codex'
        ? this.desktop ? await this.desktop.send(identity, envelope) : await this.codex.queue({ threadId: identity, message: envelope, resume: true })
        : await this.delivery.deliver({ room, message: { id: notice.id, to: member }, text: envelope })
    } catch (error) {
      outcome = { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
    }
    if (this.stopping) return { state: 'unknown', detail: 'Host stopped before control delivery settled; keep the persisted wake reservation' }
    await this.bridge.observeWake({ member, identity, wakeId, outcome })
    if (this.stopping) return { state: 'unknown', detail: 'Host stopped while persisting control delivery' }
    notice.state = outcome.evidence?.notSubmitted ? 'saved' : outcome.state
    await this.bridge.save()
    return { state: outcome.state, detail: outcome.detail }
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  #enqueueDelivery(roomId, messageId) {
    const previous = this.queues.get(roomId) ?? Promise.resolve()
    const run = previous
      .catch(() => {})
      .then(() => this.#deliverNow(roomId, messageId))
      .catch((error) => {
        const payload = errorPayload(error)
        return { state: 'failed', detail: payload.message, evidence: payload }
      })
    const tail = run.then(() => {})
    this.queues.set(roomId, tail)
    tail.finally(() => {
      if (this.queues.get(roomId) === tail) this.queues.delete(roomId)
    })
    return withCap(run, this.config.sendWaitMs)
  }

  async #deliverNow(roomId, messageId) {
    if (this.stopping) return { state: 'unknown', detail: 'Host is stopping; no new client wake was started' }
    const room = this.bridge.getRoom(roomId)
    const message = this.bridge.state.messages[messageId]
    if (!message) return { state: 'failed', detail: 'message disappeared before delivery' }
    if (message.delivery.state !== 'saved') return message.delivery
    if (room.status !== ROOM_STATUS.ACTIVE) {
      await this.bridge.markDelivery({ roomId, messageId, state: 'skipped', detail: `room is ${room.status}` })
      return this.bridge.state.messages[messageId].delivery
    }

    const target = message.to
    if (target === 'codex' && this.desktop) await this.#observeDesktop(room)
    if (this.stopping || room.status !== ROOM_STATUS.ACTIVE || message.delivery.state !== 'saved') return message.delivery
    if (this.bridge.deliveryHeld(room, target)) {
      return {
        state: 'saved',
        detail: 'held for a recipient checkpoint; a new client wake additionally requires idle and no pending wake receipt',
        held: true,
        updatedAt: new Date().toISOString(),
      }
    }

    const saved = this.bridge.savedFor(room, target, this.config.digestMaxMessages)
    const batch = saved.length > 0 ? saved : [message]
    const reservation = await this.bridge.beginDelivery({ roomId, member: target, messageIds: batch.map((entry) => entry.id) })
    const text =
      batch.length > 1
        ? formatDigest(room, batch, { maxBodyChars: this.config.maxBodyChars, batchId: reservation.id, wakeId: reservation.wakeId })
        : formatEnvelope(room, batch[0], { maxBodyChars: this.config.maxBodyChars, batchId: reservation.id, wakeId: reservation.wakeId })
    let outcome
    try {
      if (target === 'codex') {
        if (!room.codexThreadId) throw new Error('room has no bound Codex thread')
        outcome = this.desktop ? await this.desktop.send(room.codexThreadId, text) : await this.codex.queue({ threadId: room.codexThreadId, message: text, resume: true })
        outcome.evidence = { ...outcome.evidence, codexVersion: this.codexInfo?.version ?? null, digest: batch.length }
      } else {
        outcome = await this.delivery.deliver({ room, message: batch[0], text })
        outcome.evidence = { ...(outcome.evidence ?? {}), digest: batch.length }
      }
    } catch (error) {
      outcome = { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
    }

    if (this.stopping) return { state: 'unknown', detail: 'Host stopped before delivery settled; keep the persisted wake reservation' }
    await this.bridge.observeWake({ member: target, identity: reservation.bindingId, wakeId: reservation.wakeId, outcome })
    if (this.stopping) return { state: 'unknown', detail: 'Host stopped while persisting delivery' }
    if (outcome.evidence?.notSubmitted) {
      await this.bridge.deliveryFailed({ roomId, member: target, batchId: reservation.id })
      return { state: 'saved', held: true, detail: outcome.detail }
    }
    const ids = batch.map((entry) => entry.id)
    await this.bridge.markBundleDelivery({
      roomId,
      messageIds: ids,
      state: outcome.state,
      detail: outcome.detail,
      evidence: outcome.evidence,
    })
    if (this.stopping) return this.bridge.state.messages[messageId].delivery
    if (target === 'dsh' && outcome.state === 'queued') {
      this.#scheduleProbe(roomId, ids, 0)
    }
    if (outcome.state === 'failed') {
      await this.bridge.deliveryFailed({ roomId, member: target, batchId: reservation.id })
    }
    return this.bridge.state.messages[messageId].delivery
  }

  async #pullSaved(room, member, replay) {
    // The recipient is already here at a safe checkpoint. Return the next
    // batch in this tool result instead of adding a new client queue entry.
    let reservation = room.deliveryFlow[member].batch
    let messages
    if (replay) {
      if (reservation?.channel !== 'tool') return null
      messages = reservation.messageIds.map((id) => this.bridge.state.messages[id]).filter(Boolean)
    } else {
      if (room.deliveryFlow[member].batch) return null
      messages = this.bridge.savedFor(room, member, this.config.digestMaxMessages)
      if (messages.length === 0) return null
      reservation = await this.bridge.beginDelivery({
        roomId: room.id, member, messageIds: messages.map((message) => message.id), channel: 'tool',
      })
      await this.bridge.markBundleDelivery({
        roomId: room.id, messageIds: reservation.messageIds, state: 'processing',
        detail: 'returned to the recipient at an explicit checkpoint; no client wake queued',
        evidence: { channel: 'tool', batchId: reservation.id },
      })
    }
    const options = { maxBodyChars: this.config.maxBodyChars, batchId: reservation.id }
    return {
      batchId: reservation.id, messageIds: reservation.messageIds, count: messages.length, replayed: replay,
      text: messages.length > 1 ? formatDigest(room, messages, options) : formatEnvelope(room, messages[0], options),
    }
  }

  #scheduleProbe(roomId, messageIds, index) {
    const delay = this.config.probeDelaysMs[index]
    if (delay === undefined) return
    const timer = setTimeout(async () => {
      this.probeTimers.delete(timer)
      try {
        const room = this.bridge.state.rooms[roomId]
        if (!room) return
        const messages = messageIds.map((id) => this.bridge.state.messages[id]).filter(Boolean)
        if (messages.length === 0) return
        const pending = messages.filter(
          (message) => message.delivery.state === 'queued' || message.delivery.state === 'queued_unresumed',
        )
        if (pending.length === 0) return
        if (pending[0].to === 'dsh') {
          const status = this.delivery.statusOf(room.dshSessionId)
          if (status === 'running') {
            await this.bridge.markBundleDelivery({
              roomId,
              messageIds: pending.map((message) => message.id),
              state: 'processing',
              detail: 'observed the DSH session status=running after delivery',
              evidence: { sessionId: room.dshSessionId, observedAt: new Date().toISOString() },
            })
            return
          }
        }
        this.#scheduleProbe(roomId, pending.map((message) => message.id), index + 1)
      } catch (error) {
        this.logger?.warn?.('bridge delivery probe failed', error)
      }
    }, delay)
    timer.unref?.()
    this.probeTimers.add(timer)
  }

  #message(roomId, messageId) {
    const message = this.bridge.state.messages[messageId]
    if (!message || message.roomId !== roomId) return null
    return message
  }

  async sweepBudgets() {
    let changed = false
    const now = Date.now()
    for (const room of Object.values(this.bridge.state.rooms)) {
      if (room.status !== ROOM_STATUS.ACTIVE || !room.activatedAt) continue
      const elapsed = now - Date.parse(room.activatedAt)
      if (elapsed > room.budgets.maxMinutes * 60_000) {
        room.status = ROOM_STATUS.PAUSED
        room.pauseReason = 'time_budget'
        room.pausedBy = 'system'
        room.updatedAt = new Date(now).toISOString()
        changed = true
      }
    }
    if (changed) await this.bridge.save()
    return changed
  }

  // ---------------------------------------------------------------------------
  // Read-only helpers
  // ---------------------------------------------------------------------------

  listRooms() {
    if (!this.bridge.state) return []
    return Object.values(this.bridge.state.rooms).map((room) => ({
      id: room.id,
      status: room.status,
      goal: room.goal,
      cwd: room.cwd,
      dshSessionId: room.dshSessionId,
      codexThreadId: room.codexThreadId,
      updatedAt: room.updatedAt,
    }))
  }

  roomSnapshot(roomId) {
    const room = this.bridge.getRoom(roomId)
    return {
      room: this.bridge.roomView(room, 'dsh'),
      messages: this.bridge.roomHistory(room, { since: 0, limit: 100 }),
      tasks: this.bridge.tasksFor(room, 'dsh'),
      decisions: this.bridge.decisionsFor(room),
    }
  }

  /** Prompt context for the DSH member; never mutates lastSeen. */
  promptFor(sessionId) {
    // Runs synchronously while the host runtime may still be starting (state
    // file not loaded yet). A prompt context must never fail a turn, so stay
    // silent until the bridge is ready and swallow any read error.
    try {
      if (!this.bridge.state) return ''
      const room = this.bridge.findRoomFor('dsh', sessionId)
      if (!room || room.status === ROOM_STATUS.ENDED) return ''
      const recent = this.bridge.roomHistory(room, { since: Math.max(0, room.seq - 4), limit: 4 })
      const unread = this.bridge.messagesFor(room, 'dsh', { since: room.lastSeen?.dsh ?? 0, limit: 20 })
      return ['', formatRoomContext(room, 'dsh', { messages: recent, unread }), this.#budgetPrompt(room), ''].join('\n')
    } catch (error) {
      this.logger?.warn?.('[dsh-codex-bridge] prompt context failed', error)
      return ''
    }
  }

  #budgetPrompt(room) {
    if (room.status !== ROOM_STATUS.PAUSED || !/_budget$/.test(room.pauseReason ?? '')) return ''
    const pending = this.bridge.budgetRequestsFor(room)
    const lines = [
      `[预算] 房间因 ${room.pauseReason} 暂停；继续自动协作前必须由用户在 DSH 会话中明确批准追加预算。`,
    ]
    if (pending.length > 0) {
      const request = pending[0]
      lines.push(
        `待批准请求 ${request.id}：由 ${request.requestedBy} 申请 +${request.addWakes} 次唤醒 / +${request.addMinutes} 分钟 / +${request.addHops} 层链深；理由：${request.reason}`,
      )
      lines.push(
        '只有用户明确同意后，DSH 成员才可调用 budget_approve（request_id 加上 user_confirmed=true）。不得在用户未同意时批准，也不得用 resume/reset_budget 绕过。',
      )
    } else {
      lines.push('如需继续，可用 budget_request 记录申请（附理由与追加额度），在用户批准前房间保持暂停。')
    }
    return lines.join('\n')
  }

  async startCodexDaemon() {
    const result = await this.codex.startDaemon()
    if (result.started) {
      this.codexInfo = await this.codex.resolve().catch(() => this.codexInfo)
    }
    return result
  }

  async readHostInfo() {
    try {
      return JSON.parse(await readFile(this.hostFile, 'utf8'))
    } catch {
      return null
    }
  }
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_') || 'desktop'
}

function resolveCwd(input, fallback) {
  const value = input ?? fallback ?? process.cwd()
  return path.resolve(String(value))
}

function normalizeScope(scope, cwd) {
  if (scope === undefined || scope === null) {
    return { text: undefined, writeScopes: [cwd] }
  }
  if (typeof scope === 'string') return { text: scope, writeScopes: [cwd] }
  return {
    text: scope.text,
    writeScopes: Array.isArray(scope.write_scopes) ? scope.write_scopes.map((item) => path.resolve(String(item))) : [cwd],
  }
}

function budgetsFromArgs(args) {
  return {
    maxHops: numberOrUndefined(args.max_hops),
    maxWakes: numberOrUndefined(args.max_wakes),
    maxMinutes: numberOrUndefined(args.max_minutes),
  }
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const TIMED_OUT = Symbol('timedOut')

function withCap(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout])
    .then((value) => (value === TIMED_OUT ? { timedOut: true } : value))
    .finally(() => clearTimeout(timer))
}

async function renameWithRetry(from, to) {
  // Windows can transiently lock the target while another reader has it open.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { rename } = await import('node:fs/promises')
      await rename(from, to)
      return
    } catch (error) {
      if (attempt === 4 || (error?.code !== 'EPERM' && error?.code !== 'EBUSY')) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}
