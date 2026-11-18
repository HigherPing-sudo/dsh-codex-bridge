import net from 'node:net'
import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { wakeFromInput } from './lifecycle.js'

const MAX_FRAME = 8 * 1024 * 1024
const PIPE_PREFIX = '\\\\.\\pipe\\codex-app-tools-'

/** The same length-prefixed local transport used by the installed App Tools MCP. */
export class DesktopPipe {
  constructor(pipePath, { timeoutMs = 5000, connect = net.createConnection } = {}) {
    if (!pipePath?.startsWith(PIPE_PREFIX)) throw new Error('a local Codex App Tools pipe is required')
    this.pipePath = pipePath
    this.timeoutMs = timeoutMs
    this.connect = connect
    this.pending = new Map()
    this.nextId = 0
    this.buffer = Buffer.alloc(0)
  }

  async open() {
    if (this.connecting) return this.connecting
    if (this.socket && !this.socket.destroyed) return
    this.connecting = new Promise((resolve, reject) => {
      const socket = this.connect(this.pipePath)
      this.socket = socket
      const timer = setTimeout(() => { socket.destroy(new Error('desktop connection timeout')) }, this.timeoutMs)
      this.connectTimer = timer
      this.rejectOpen = reject
      const fail = (error) => { clearTimeout(timer); reject(error); this.disconnect(error) }
      socket.once('error', fail)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.rejectOpen = null
        socket.off('error', fail)
        socket.on('error', (error) => this.disconnect(error))
        socket.on('close', () => this.disconnect(new Error('desktop pipe closed')))
        socket.on('data', (chunk) => this.onData(chunk))
        resolve()
      })
    }).finally(() => { this.connecting = null })
    return this.connecting
  }

  onData(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0)
        if (size === 0 || size > MAX_FRAME) throw new Error('invalid desktop frame size')
        if (this.buffer.length < size + 4) break
        const msg = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'))
        this.buffer = this.buffer.subarray(size + 4)
        const pending = this.pending.get(msg.id)
        if (!pending) continue
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) {
          const error = new Error(String(msg.error.message ?? 'desktop RPC error'))
          error.definitive = true
          pending.reject(error)
        } else pending.resolve(msg.result)
      }
    } catch (error) { this.disconnect(error) }
  }

  async request(method, params) {
    await this.open()
    const id = ++this.nextId
    const payload = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }))
    if (payload.length > MAX_FRAME) throw new Error('desktop request too large')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('desktop RPC timeout; delivery may be uncertain'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(Buffer.concat([header, payload]), (error) => { if (error) this.disconnect(error) })
    })
  }

  disconnect(error = new Error('desktop client closed')) {
    clearTimeout(this.connectTimer)
    this.rejectOpen?.(error)
    this.rejectOpen = null
    const socket = this.socket
    this.socket = null
    socket?.removeAllListeners()
    socket?.destroy()
    this.buffer = Buffer.alloc(0)
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
  }

  close() { this.disconnect() }
}

export async function desktopPipes() {
  if (process.platform !== 'win32') return []
  const names = await readdir('\\\\.\\pipe\\')
  return names.filter((name) => /^codex-app-tools-[0-9a-f-]+$/i.test(name)).map((name) => `\\\\.\\pipe\\${name}`)
}

/** Select a desktop instance only when it reports the exact paired thread loaded. */
export class DesktopCodex {
  constructor({ pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH, discover = desktopPipes, clientFactory = (p) => new DesktopPipe(p) } = {}) {
    this.pipePath = pipePath
    this.discover = discover
    this.clientFactory = clientFactory
    this.clients = new Map()
    this.owners = new Map()
  }

  async client(path) {
    if (this.closed) throw new Error('desktop adapter closed')
    let entry = this.clients.get(path)
    if (!entry) {
      const client = this.clientFactory(path)
      try {
        const result = await client.request('tools/list', { threadStartKind: 'all' })
        if (this.closed) throw new Error('desktop adapter closed')
        const read = result.tools?.find((t) => t.name === 'read_thread')
        const send = result.tools?.find((t) => t.name === 'send_message_to_thread')
        if (!read || !send) throw new Error('desktop tools unavailable')
        entry = { client, read, send }
        this.clients.set(path, entry)
      } catch (error) { client.close(); throw error }
    }
    return entry
  }

  async call(entry, tool, threadId, args) {
    const result = await entry.client.request('tools/call', {
      namespace: tool.namespace, tool: tool.name, callerSource: 'codex',
      threadId, callId: `bridge-${randomUUID()}`, turnId: 'bridge-desktop-transport', arguments: args,
    })
    if (!result?.success) {
      const error = new Error('desktop rejected the requested operation')
      error.definitive = true
      throw error
    }
    const text = result.contentItems?.filter((c) => c.type === 'inputText').map((c) => c.text).join('\n')
    try { return JSON.parse(text) } catch { return { accepted: true } }
  }

  async snapshot(threadId, { receiptWakeId } = {}) {
    if (this.closed) return { threadId, unavailable: 'desktop_adapter_closed' }
    const discovered = await Promise.resolve().then(() => this.discover()).catch(() => [])
    const candidates = [...new Set([this.owners.get(threadId), this.pipePath, ...discovered].filter(Boolean))]
    const matches = []
    for (const candidate of candidates) {
      if (this.closed) return { threadId, unavailable: 'desktop_adapter_closed' }
      try {
        const entry = await this.client(candidate)
        // Normal observations need runtime status only. Read bounded input text
        // solely while looking for our one outstanding receipt.
        const result = await this.call(entry, entry.read, threadId, { threadId, turnLimit: receiptWakeId ? 3 : 1,
          includeOutputs: false, maxOutputCharsPerItem: receiptWakeId ? 7000 : 1 })
        if (result.thread?.id !== threadId || !['active', 'idle'].includes(result.thread.status?.type)) continue
        const turns = result.turns ?? []
        const newest = turns.find((t) => t.status === 'inProgress') ?? [...turns].sort((a, b) => {
          const time = (t) => typeof t.startedAt === 'number' ? t.startedAt : Date.parse(t.startedAt) || 0
          return time(b) - time(a) || String(b.id).localeCompare(String(a.id))
        })[0]
        const wakeIds = []
        for (const turn of turns) for (const item of turn.items ?? []) {
          if (item.type !== 'userMessage') continue
          const text = (item.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          const wake = wakeFromInput(text)
          if (wake && wake === receiptWakeId) wakeIds.push(wake)
        }
        matches.push({ candidate, snapshot: { threadId, hostId: result.thread.hostId, status: result.thread.status,
          turn: newest ? { id: newest.id, status: newest.status } : null, wakeIds } })
      } catch {
        this.clients.get(candidate)?.client.close()
        this.clients.delete(candidate)
        if (this.owners.get(threadId) === candidate) this.owners.delete(threadId)
      }
    }
    if (matches.length !== 1) return { threadId, unavailable: matches.length ? 'ambiguous_desktop_owner' : 'desktop_owner_unavailable' }
    this.owners.set(threadId, matches[0].candidate)
    return matches[0].snapshot
  }

  async send(threadId, text) {
    // Re-read immediately before delivery; cached idle is never sufficient.
    const snapshot = await this.snapshot(threadId)
    if (snapshot.status?.type !== 'idle' || (snapshot.turn && snapshot.turn.status !== 'completed')) {
      return { state: 'failed', detail: 'desktop is not safely idle; no message submitted', evidence: { notSubmitted: true } }
    }
    const owner = this.owners.get(threadId)
    try {
      const entry = await this.client(owner)
      await this.call(entry, entry.send, threadId, { threadId, hostId: snapshot.hostId, prompt: text })
      return { state: 'queued', detail: 'accepted by the existing desktop; consumption awaits a matching input envelope', evidence: { channel: 'desktop', threadId } }
    } catch (error) {
      return { state: error.definitive ? 'failed' : 'unknown', detail: error.message, evidence: { channel: 'desktop', threadId } }
    }
  }

  close() { this.closed = true; for (const entry of this.clients.values()) entry.client.close(); this.clients.clear(); this.owners.clear() }
}
