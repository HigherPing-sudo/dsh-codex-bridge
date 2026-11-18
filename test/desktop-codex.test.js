import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { DesktopCodex, DesktopPipe } from '../lib/host/desktop-codex.js'
import { THREAD } from '../support/helpers.js'

const PIPE = '\\\\.\\pipe\\codex-app-tools-test'
function fakeDesktop({ read, send = async () => ({ accepted: true }), discover = async () => [PIPE] }) {
  const calls = []
  const adapter = new DesktopCodex({ pipePath: PIPE, discover, clientFactory: () => ({ close() {}, async request(method, params) {
    calls.push({ method, params })
    if (method === 'tools/list') return { tools: ['read_thread', 'send_message_to_thread'].map((name) => ({ name, namespace: 'codex_app' })) }
    const result = params.tool === 'read_thread' ? await read(params.arguments) : await send(params.arguments)
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
  } }) })
  return { adapter, calls }
}
function view(status = { type: 'idle' }, turnStatus = 'completed') {
  return { thread: { id: THREAD, hostId: 'local', status }, turns: [{ id: 'turn-1', startedAt: 1, status: turnStatus, items: [] }] }
}

test('desktop reads the exact loaded original thread and sends only when idle without overriding settings', async () => {
  const env = fakeDesktop({ read: async () => view() })
  const out = await env.adapter.send(THREAD, '[DSH × Codex Bridge]\npeer context')
  assert.equal(out.state, 'queued')
  const sent = env.calls.find((c) => c.params?.tool === 'send_message_to_thread').params.arguments
  assert.deepEqual(sent, { threadId: THREAD, hostId: 'local', prompt: '[DSH × Codex Bridge]\npeer context' })
  assert.equal(env.calls.some((c) => /resume|start|fork/.test(c.method)), false)
  env.adapter.close()
})

test('desktop rereads before sending and refuses busy, approval, interruption, failed and unloaded threads', async () => {
  for (const [status, turnStatus] of [[{ type: 'active', activeFlags: [] }, 'inProgress'],
    [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'inProgress'],
    [{ type: 'idle' }, 'interrupted'], [{ type: 'idle' }, 'failed'], [{ type: 'notLoaded' }, 'completed']]) {
    const env = fakeDesktop({ read: async () => view(status, turnStatus) })
    const out = await env.adapter.send(THREAD, 'must remain saved')
    assert.equal(out.evidence.notSubmitted, true)
    assert.equal(env.calls.some((c) => c.params?.tool === 'send_message_to_thread'), false)
    env.adapter.close()
  }
})

test('ambiguous owners and wrong identities never select an arbitrary desktop instance', async () => {
  const both = fakeDesktop({ read: async () => view(), discover: async () => [PIPE+'1', PIPE+'2'] })
  assert.equal((await both.adapter.snapshot(THREAD)).unavailable, 'ambiguous_desktop_owner')
  both.adapter.close()
  const wrong = fakeDesktop({ read: async () => ({ ...view(), thread: { id: 'wrong', status: { type: 'idle' } } }) })
  assert.equal((await wrong.adapter.snapshot(THREAD)).unavailable, 'desktop_owner_unavailable')
  wrong.adapter.close()
})

test('receipt detection uses actual user envelope headers and selects the latest turn regardless of array order', async () => {
  const data = view()
  data.turns.unshift({ id: 'turn-2', startedAt: 2, status: 'interrupted', items: [
    { type: 'agentMessage', content: [{ type: 'text', text: '[DSH × Codex Bridge]\nwake_id=wake_fake' }] },
    { type: 'userMessage', content: [{ type: 'text', text: '[DSH × Codex Bridge]\nwake_id=wake_actual\n---\nwake_id=wake_body' }] },
  ] })
  const env = fakeDesktop({ read: async () => data })
  const s = await env.adapter.snapshot(THREAD, { receiptWakeId: 'wake_actual' })
  assert.equal(s.turn.id, 'turn-2')
  assert.equal(s.turn.status, 'interrupted')
  assert.deepEqual(s.wakeIds, ['wake_actual'])
  env.adapter.close()
})

test('uncertain desktop sends do not retry or switch to another transport', async () => {
  let sends = 0
  const env = fakeDesktop({ read: async () => view(), send: async () => { sends++; throw new Error('connection lost after send') } })
  assert.equal((await env.adapter.send(THREAD, 'one delivery')).state, 'unknown')
  assert.equal(sends, 1)
  env.adapter.close()
})

test('native pipe handles fragmented frames and rejects pending calls on close', async (t) => {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const n = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, n+4)); buffer = buffer.subarray(n+4)
        if (request.method === 'pending') continue
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }))
        const head = Buffer.alloc(4); head.writeUInt32LE(body.length)
        socket.write(head.subarray(0, 2)); socket.write(Buffer.concat([head.subarray(2), body.subarray(0, 3)])); socket.write(body.subarray(3))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const client = new DesktopPipe(PIPE, { connect: () => net.createConnection(server.address().port, '127.0.0.1') })
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)) })
  assert.deepEqual(await client.request('read', {}), { ok: true })
  const pending = client.request('pending', {})
  const assertion = assert.rejects(pending, /closed/)
  await new Promise((resolve) => setImmediate(resolve))
  client.close()
  await assertion
})
