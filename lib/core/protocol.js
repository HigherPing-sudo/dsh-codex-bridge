import { BridgeError, fail } from './errors.js'

export const MEMBERS = /** @type {const} */ (['dsh', 'codex'])

export const MEMBER_LABELS = {
  dsh: 'DSH',
  codex: 'Codex',
}

export const ROOM_STATUS = /** @type {const} */ ({
  PAIRING: 'pairing',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended',
})

export const MESSAGE_KINDS = /** @type {const} */ ([
  'proposal',
  'question',
  'reply',
  'task_offer',
  'progress',
  'blocked',
  'review',
  'decision',
  'completion',
  'notice',
])

export const DELIVERY_STATES = /** @type {const} */ ([
  'saved',
  'queued',
  'queued_unresumed',
  'processing',
  'replied',
  'failed',
  'unknown',
  'skipped',
])

/**
 * Delivery state machine. `queued` means "handed to the peer transport", never
 * "the peer started". `processing` requires an independent observation.
 */
export const DELIVERY_TRANSITIONS = {
  saved: ['queued', 'queued_unresumed', 'processing', 'replied', 'skipped', 'failed', 'unknown'],
  queued: ['processing', 'replied', 'failed', 'unknown', 'skipped'],
  queued_unresumed: ['processing', 'replied', 'unknown', 'skipped'],
  processing: ['replied', 'failed', 'unknown'],
  failed: ['queued', 'unknown'],
  unknown: ['queued', 'processing', 'replied', 'failed'],
  replied: [],
  skipped: [],
}

export const TASK_STATUS = /** @type {const} */ ([
  'proposed',
  'open',
  'claimed',
  'in_progress',
  'done',
  'cancelled',
])

export const TASK_ACTIONS = /** @type {const} */ ([
  'create',
  'update',
  'claim',
  'accept',
  'start',
  'complete',
  'cancel',
  'list',
])

export const DECISION_ACTIONS = /** @type {const} */ (['propose', 'confirm', 'reject', 'list'])

export const ACTIONS = /** @type {const} */ ([
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
  'whoami',
])

/** Reasons a room enters the paused state because a hard budget was reached. */
export const BUDGET_REASONS = /** @type {const} */ ([
  'hop_budget',
  'wake_budget',
  'time_budget',
])

/** How long a one-time Codex handoff code stays valid. */
export const HANDOFF_TTL_MINUTES = 30

export const BUDGET_REQUEST_STATUS = /** @type {const} */ ([
  'pending',
  'approved',
  'rejected',
  'superseded',
])

export const DEFAULT_BUDGETS = {
  maxHops: 8,
  maxWakes: 60,
  maxMinutes: 120,
  pairingTtlMinutes: 30,
  maxBodyChars: 6000,
  maxMessagesPerRoom: 5000,
}

/**
 * Default automatic retention. Ended rooms are removed after `endedRoomDays`,
 * the oldest ended rooms beyond `maxRooms` are evicted, and an ended room keeps
 * at most `maxMessagesPerRoom` messages. Active/paused rooms are never deleted.
 */
export const DEFAULT_RETENTION = {
  enabled: true,
  endedRoomDays: 30,
  maxRooms: 100,
  maxMessagesPerRoom: 5000,
  maxTombstones: 100,
  sweepMs: 6 * 60 * 60 * 1000,
}

export function assertMember(member) {
  if (!MEMBERS.includes(member)) fail('bad_member', `unknown member "${member}"`)
  return member
}

export function otherMember(member) {
  assertMember(member)
  return member === 'dsh' ? 'codex' : 'dsh'
}

export function assertKind(kind) {
  if (!MESSAGE_KINDS.includes(kind)) {
    fail('bad_message_kind', `unknown message kind "${kind}"`, { allowed: MESSAGE_KINDS })
  }
  return kind
}

export function assertRoomStatus(room, allowed) {
  if (!allowed.includes(room.status)) {
    fail('room_state', `room ${room.id} is ${room.status}; expected ${allowed.join(' or ')}`, {
      roomId: room.id,
      status: room.status,
    })
  }
}

export function assertTransition(from, to) {
  const allowed = DELIVERY_TRANSITIONS[from]
  if (!allowed) fail('bad_delivery_state', `unknown delivery state "${from}"`)
  if (from === to) return to
  if (!allowed.includes(to)) {
    fail('bad_delivery_transition', `delivery state cannot move ${from} -> ${to}`, { from, to })
  }
  return to
}

/** Bound free text at a character budget, marking the cut explicitly. */
export function clampText(value, max, label = 'text') {
  if (typeof value !== 'string') fail('bad_argument', `${label} must be a string`)
  const text = value.trim()
  if (text.length === 0) fail('bad_argument', `${label} must not be empty`)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

export function optionalText(value, max, label) {
  if (value === undefined || value === null || value === '') return undefined
  return clampText(value, max, label)
}

export function assertString(value, label, { max = 200, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('bad_argument', `${label} must be a string`)
  const text = value.trim()
  if (!allowEmpty && text.length === 0) fail('bad_argument', `${label} must not be empty`)
  if (text.length > max) fail('bad_argument', `${label} exceeds ${max} characters`)
  return text
}

export function normalizeBudgets(input = {}) {
  const budgets = { ...DEFAULT_BUDGETS }
  for (const key of ['maxHops', 'maxWakes', 'maxMinutes', 'pairingTtlMinutes']) {
    if (input[key] === undefined) continue
    const value = Number(input[key])
    if (!Number.isFinite(value) || value <= 0) fail('bad_argument', `${key} must be a positive number`)
    budgets[key] = Math.floor(value)
  }
  return budgets
}

export function assertRoomId(roomId) {
  return assertString(roomId, 'room_id', { max: 80 })
}

export function nowIso(clock) {
  return new Date(clock()).toISOString()
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asBridgeErrorWithCode(error) {
  if (error instanceof BridgeError) return error
  return new BridgeError('internal', error instanceof Error ? error.message : String(error))
}
