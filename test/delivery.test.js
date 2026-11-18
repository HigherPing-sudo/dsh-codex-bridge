import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCli, classifyQueueResult } from '../lib/host/codex-cli.js'
import { DshDelivery } from '../lib/host/dsh-delivery.js'
import { THREAD, WORKDIR } from '../support/helpers.js'

const ACK = (id = '00000000-0000-4000-8000-000000000100') =>
  `Queued message ${id} for thread ${THREAD}.\n`

test('queue classification never treats exit 0 alone as delivery', () => {
  assert.equal(classifyQueueResult({ code: 0, stdout: ACK() }).state, 'queued')
  assert.equal(classifyQueueResult({ code: 0, stdout: ACK() }).evidence.queuedId, '00000000-0000-4000-8000-000000000100')

  const warned = classifyQueueResult({
    code: 0,
    stdout: ACK(),
    stderr: `Warning: message was queued, but could not resume thread ${THREAD}: start a local daemon\n`,
  })
  assert.equal(warned.state, 'queued_unresumed')
  assert.equal(warned.evidence.warning, true)

  assert.equal(classifyQueueResult({ code: 0, stdout: 'nothing here' }).state, 'unknown')
  assert.equal(classifyQueueResult({ code: 0, stdout: ACK(), timedOut: true }).state, 'unknown')
  assert.equal(
    classifyQueueResult({ code: 1, stdout: '', stderr: 'failed to initialize state database' }).state,
    'failed',
  )
})

test('CodexCli.queue passes the real thread id and --resume, and classifies failures', async () => {
  const calls = []
  const cli = new CodexCli({
    codexPath: process.execPath,
    execFileImpl: async (file, args) => {
      calls.push([file, args])
      if (args[0] === '--version') return { stdout: 'codex-cli 0.168.0', stderr: '' }
      return { stdout: ACK(), stderr: '' }
    },
  })

  const resolved = await cli.resolve()
  assert.equal(resolved.version, '0.168.0')
  assert.equal(resolved.source, 'config')

  const result = await cli.queue({ threadId: THREAD, message: 'hello' })
  assert.equal(result.state, 'queued')
  assert.deepEqual(calls.at(-1)[1], ['queue', '--thread', THREAD, '--message', 'hello', '--resume'])

  const failing = new CodexCli({
    codexPath: process.execPath,
    execFileImpl: async (file, args) => {
      if (args[0] === '--version') return { stdout: 'codex-cli 0.168.0', stderr: '' }
      const error = new Error('command failed')
      error.code = 1
      error.stderr = 'failed to initialize state database'
      throw error
    },
  })
  const failed = await failing.queue({ threadId: THREAD, message: 'hello' })
  assert.equal(failed.state, 'failed')
  assert.match(failed.detail, /state database/)
})

test('CodexCli reports a missing executable instead of throwing', async () => {
  const cli = new CodexCli({ codexPath: 'Z:/does/not/exist/codex.exe' })
  cli.resolve = async () => ({ file: null, source: 'missing', version: null })
  const result = await cli.queue({ threadId: THREAD, message: 'x' })
  assert.equal(result.state, 'failed')
  assert.equal(result.evidence.code, 'codex_not_found')
})

function fakeAgents({ attached, resume } = {}) {
  const steered = []
  const registered = new Map()
  if (attached) registered.set(attached.id, attached)
  return {
    steered,
    get: (id) => registered.get(id),
    list: () => [...registered.values()],
    resume: resume ?? (async () => null),
    register(agent) {
      registered.set(agent.id, agent)
    },
  }
}

const room = { dshSessionId: 'session-test-0001', codexThreadId: THREAD, id: 'room_x' }

test('DshDelivery steers into the exact bound session with a member source', async () => {
  const agent = {
    id: room.dshSessionId,
    status: 'idle',
    steer(input) {
      this.input = input
    },
  }
  const agents = fakeAgents({ attached: agent })
  const delivery = new DshDelivery({ agents, timeoutMs: 100 })
  const result = await delivery.deliver({
    room,
    message: { to: 'dsh' },
    text: 'hello from codex',
  })
  assert.equal(result.state, 'queued')
  assert.equal(result.evidence.resumed, false)
  assert.equal(agent.input.source.kind, 'agent-message')
  assert.equal(agent.input.source.form, 'relay')
  assert.equal(agent.input.source.senderSessionId, `codex:${THREAD}`)
  assert.equal(agent.input.content[0].text, 'hello from codex')
  assert.deepEqual(result.evidence.inputId, agent.input.id)
})

test('DshDelivery resumes a cold session through AgentRegistry and verifies identity', async () => {
  const agent = { id: room.dshSessionId, status: 'idle', steer() {} }
  const resumed = []
  const agents = fakeAgents({
    resume: async (options) => {
      resumed.push(options)
      return agent
    },
  })
  const delivery = new DshDelivery({ agents, timeoutMs: 100 })
  const result = await delivery.deliver({ room, message: { to: 'dsh' }, text: 'wake up' })
  assert.equal(result.evidence.resumed, true)
  assert.deepEqual(resumed[0], { resumeSessionId: room.dshSessionId, agentOptions: {} })
})

test('DshDelivery refuses a mismatched or unavailable session', async () => {
  const agents = fakeAgents({ resume: async () => ({ id: 'session-other', status: 'idle', steer() {} }) })
  const delivery = new DshDelivery({ agents, timeoutMs: 100 })
  await assert.rejects(
    () => delivery.deliver({ room, message: { to: 'dsh' }, text: 'x' }),
    /does not match room session/,
  )

  const slow = fakeAgents({ resume: () => new Promise(() => {}) })
  const timingOut = new DshDelivery({ agents: slow, timeoutMs: 20 })
  await assert.rejects(
    () => timingOut.deliver({ room, message: { to: 'dsh' }, text: 'x' }),
    /timed out resuming/,
  )
})

test('DshDelivery will not deliver a message addressed to Codex', async () => {
  const delivery = new DshDelivery({ agents: fakeAgents(), timeoutMs: 100 })
  await assert.rejects(
    () => delivery.deliver({ room, message: { to: 'codex' }, text: 'x' }),
    /not addressed to the DSH member/,
  )
  assert.equal(delivery.statusOf(room.dshSessionId), 'detached')
  assert.equal(room.codexThreadId, THREAD)
  assert.equal(room.dshSessionId, 'session-test-0001')
  assert.ok(WORKDIR)
})
