import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

/** Stable, URL-safe identifier. */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`
}

/** Six-digit pairing code. Not a secret after it is shown; still hashed at rest. */
export function newPairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashCode(code, salt) {
  return createHash('sha256').update(`${salt}\u0000${code}`).digest('hex')
}

export function newSalt() {
  return randomBytes(16).toString('hex')
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Fresh ids for user-visible message input injected into a DSH session. */
export function newMessageId() {
  return randomUUID()
}
