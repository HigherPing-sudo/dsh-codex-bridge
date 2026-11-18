import { createServer } from 'node:http'
import { safeEqual } from '../core/ids.js'
import { errorPayload } from '../core/errors.js'

const MAX_BODY = 256 * 1024

/**
 * Loopback-only JSON API. Authentication is a bearer token read from the
 * host.json file (mode 0600); there is no unauthenticated route.
 */
export class HttpServer {
  constructor({ runtime, token, host = '127.0.0.1' }) {
    this.runtime = runtime
    this.token = token
    this.host = host
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#send(res, statusFor(error), { ok: false, error: errorPayload(error) })
      })
    })
    this.port = null
  }

  async listen(port = 0) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        this.server.off('error', onError)
        this.port = this.server.address().port
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen({ host: this.host, port, exclusive: true })
    })
    return this.port
  }

  async close() {
    if (!this.server.listening) return
    await new Promise((resolve) => this.server.close(() => resolve()))
  }

  #send(res, status, payload) {
    if (res.headersSent) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  #authorized(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    return safeEqual(header.slice('Bearer '.length).trim(), this.token)
  }

  #hostAllowed(req) {
    const host = req.headers.host
    if (typeof host !== 'string') return false
    return /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host)
  }

  async #handle(req, res) {
    if (!this.#hostAllowed(req)) {
      this.#send(res, 403, { ok: false, error: { code: 'bad_host', message: 'loopback Host header required' } })
      return
    }
    if (!this.#authorized(req)) {
      this.#send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'missing or invalid bearer token' } })
      return
    }

    const url = new URL(req.url ?? '/', `http://${this.host}`)
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      this.#send(res, 200, { ok: true, ...this.runtime.health() })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/rooms') {
      this.#send(res, 200, { ok: true, rooms: this.runtime.listRooms() })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/room/')) {
      const roomId = decodeURIComponent(url.pathname.slice('/v1/room/'.length))
      this.#send(res, 200, { ok: true, ...this.runtime.roomSnapshot(roomId) })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/tool') {
      const body = await readJson(req)
      const result = await this.runtime.toolCall(body)
      this.#send(res, 200, { ok: true, result })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/lifecycle') {
      const body = await readJson(req)
      if (!['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt'].includes(body.event)) {
        this.#send(res, 400, { ok: false, error: { code: 'bad_lifecycle_event', message: 'Codex hook event required' } })
        return
      }
      const result = await this.runtime.lifecycle({ ...body, member: 'codex' })
      this.#send(res, 200, { ok: true, result })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/codex/daemon/start') {
      const result = await this.runtime.startCodexDaemon()
      this.#send(res, 200, { ok: true, result })
      return
    }
    this.#send(res, 404, { ok: false, error: { code: 'not_found', message: `no route for ${req.method} ${url.pathname}` } })
  }
}

function statusFor(error) {
  if (error?.statusCode) return error.statusCode
  const code = error?.code ?? ''
  if (
    code === 'room_not_found' ||
    code === 'message_not_found' ||
    code === 'task_not_found' ||
    code === 'decision_not_found' ||
    code === 'budget_request_not_found' ||
    code === 'handoff_code_missing'
  )
    return 404
  if (
    code === 'task_conflict' ||
    code === 'room_state' ||
    code === 'decision_state' ||
    code === 'task_state' ||
    code === 'budget_request_state' ||
    code === 'budget_approval_required' ||
    code === 'budget_not_exhausted' ||
    code === 'old_session_active' ||
    code === 'room_ended' ||
    code === 'room_not_ended'
  )
    return 409
  if (code.startsWith('bad_') || code === 'scope_violation' || code === 'pairing_code_invalid' || code === 'pairing_code_expired') return 400
  if (code === 'user_confirmation_required' || code === 'handoff_code_expired' || code === 'handoff_code_invalid') return 400
  if (code === 'identity_unavailable' || code === 'bad_thread_id' || code === 'bad_session_id') return 422
  if (code === 'not_in_room' || code === 'already_in_room' || code === 'member_already_bound' || code === 'not_a_member') return 409
  if (code === 'task_forbidden' || code === 'forbidden' || code === 'unauthorized') return 403
  return 500
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('request body too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('request body must be JSON')
    error.statusCode = 400
    throw error
  }
}
