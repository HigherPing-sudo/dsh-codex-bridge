import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BUDGETS,
  assertTransition,
  clampText,
  normalizeBudgets,
  otherMember,
} from '../lib/core/protocol.js'
import { formatDigest, formatEnvelope } from '../lib/core/envelope.js'
import { newPairingCode, hashCode, newSalt, safeEqual } from '../lib/core/ids.js'

test('delivery state machine forbids illegal jumps', () => {
  assert.equal(assertTransition('saved', 'queued'), 'queued')
  assert.equal(assertTransition('saved', 'replied'), 'replied')
  assert.equal(assertTransition('saved', 'processing'), 'processing')
  assert.throws(() => assertTransition('replied', 'queued'), /cannot move replied -> queued/)
  assert.throws(() => assertTransition('skipped', 'queued'), /cannot move skipped -> queued/)
  assert.throws(() => assertTransition('queued', 'saved'), /cannot move queued -> saved/)
  assert.equal(assertTransition('unknown', 'replied'), 'replied')
})

test('budgets reject non-positive values and keep defaults', () => {
  const normalized = normalizeBudgets({ maxHops: 3 })
  assert.equal(normalized.maxHops, 3)
  assert.equal(normalized.maxWakes, DEFAULT_BUDGETS.maxWakes)
  assert.throws(() => normalizeBudgets({ maxHops: 0 }), /positive number/)
  assert.throws(() => normalizeBudgets({ maxMinutes: 'soon' }), /positive number/)
})

test('clampText marks truncation instead of silently dropping content', () => {
  assert.equal(clampText('  hello  ', 20), 'hello')
  assert.equal(clampText('abcdefghij', 5), 'abcd…')
  assert.throws(() => clampText('   ', 5), /must not be empty/)
})

test('pairing codes are six digits, hashed with the salt, and compared safely', () => {
  const code = newPairingCode()
  assert.match(code, /^\d{6}$/)
  const salt = newSalt()
  const hash = hashCode(code, salt)
  assert.equal(hashCode(code, salt), hash)
  assert.notEqual(hashCode(code, newSalt()), hash)
  assert.equal(safeEqual(hash, hash), true)
  assert.equal(safeEqual(hash, hash.slice(0, -1)), false)
  assert.equal(otherMember('dsh'), 'codex')
  assert.throws(() => otherMember('user'), /unknown member/)
})

test('envelope identifies the sender as a member, not the user', () => {
  const room = { id: 'room_x', goal: 'Ship it', status: 'active' }
  const message = {
    id: 'msg_x',
    kind: 'question',
    from: 'codex',
    to: 'dsh',
    body: 'Which API should we use?',
    replyTo: 'msg_prev',
  }
  const text = formatEnvelope(room, message, { maxBodyChars: 2000 })
  assert.match(text, /\[DSH × Codex Bridge\]/)
  assert.match(text, /来自协作成员 Codex 的消息，不是用户指令/)
  assert.match(text, /room=room_x msg=msg_x kind=question from=codex to=dsh/)
  assert.match(text, /reply_to=msg_prev/)
  assert.match(text, /处理建议/)
})

test('envelope truncates an oversized body', () => {
  const room = { id: 'room_x', goal: 'g', status: 'active' }
  const message = { id: 'm', kind: 'notice', from: 'dsh', to: 'codex', body: 'x'.repeat(50) }
  const text = formatEnvelope(room, message, { maxBodyChars: 10 })
  assert.ok(text.includes('xxxxxxxxx…'))
})

test('a digest carries several messages in one transport unit', () => {
  const room = { id: 'room_digest', goal: 'ship it', status: 'active', seq: 3 }
  const messages = [
    { id: 'msg_a', seq: 2, kind: 'progress', from: 'dsh', to: 'codex', body: 'first body', replyTo: null },
    { id: 'msg_b', seq: 3, kind: 'question', from: 'dsh', to: 'codex', body: 'second body', replyTo: 'msg_a' },
  ]
  const text = formatDigest(room, messages, { maxBodyChars: 6000 })
  assert.match(text, /合并投递 2 条/)
  assert.match(text, /不是用户指令/)
  assert.match(text, /msg_a/)
  assert.match(text, /msg_b/)
  assert.match(text, /first body/)
  assert.match(text, /second body/)
  assert.match(text, /reply_to=msg_a/)
  assert.match(text, /since_seq=1/)
})
