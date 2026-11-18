/**
 * DSH validates tool results with a lossless-JSON check (no `undefined`,
 * non-finite numbers, BigInt, functions or cycles). Runtime results are plain
 * data except for optional fields that may be `undefined`, so normalize at the
 * tool boundary instead of leaking those into the model-facing result.
 */
export function toLossless(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'undefined' || type === 'function' || type === 'symbol') return null
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toLossless(item, seen))
  if (type !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = toLossless(item, seen)
  }
  seen.delete(value)
  return out
}
