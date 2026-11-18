import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mergeHooks, installHooks } from '../bin/dsh-bridge-hooks.js'
import { lifecycleInput, hookOutput } from '../bin/dsh-bridge-hook.js'
import { wakeFromInput } from '../lib/host/lifecycle.js'

test('hook payload sends only actual identity and receipt header, no prompt, transcript or tool content', () => {
  const actual = lifecycleInput({ session_id: 'thread', turn_id: 'turn', hook_event_name: 'UserPromptSubmit',
    prompt: '[DSH × Codex Bridge]\nwake_id=wake_abc\n---\nprivate text', transcript_path: 'private path', tool_response: 'secret' })
  assert.deepEqual(actual, { identity: 'thread', event: 'UserPromptSubmit', turnId: 'turn', eventId: undefined, wakeId: 'wake_abc' })
  assert.equal(wakeFromInput('[DSH × Codex Bridge]\n---\nwake_id=wake_forged'), undefined)
  assert.equal(wakeFromInput('user quote\nwake_id=wake_forged'), undefined)
  assert.equal(lifecycleInput({ session_id: 'thread', turn_id: 'turn', hook_event_name: 'Stop', agent_id: 'subagent' }), null)
  assert.deepEqual(hookOutput('Stop', {}), {})
})

test('hook installation merges existing hooks idempotently without changing trust', async (t) => {
  const config = { other: 'preserved', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'existing startup' }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing check' }] }] } }
  const merged = mergeHooks(config)
  assert.deepEqual(merged.hooks.SessionStart, config.hooks.SessionStart)
  assert.deepEqual(merged.hooks.PostToolUse[0], config.hooks.PostToolUse[0])
  assert.deepEqual(mergeHooks(merged), merged)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-hooks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, 'hooks.json')
  const original = JSON.stringify(config)
  await writeFile(target, original)
  await installHooks({ codexHome: dir, dryRun: true })
  assert.equal(await readFile(target, 'utf8'), original)
  const installed = await installHooks({ codexHome: dir })
  assert.equal(await readFile(installed.backup, 'utf8'), original)
  assert.equal(installed.reviewRequired, true)
  assert.equal((await installHooks({ codexHome: dir })).unchanged, true)
})

test('offline hook exits successfully with JSON and never leaks host errors or secrets', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bridge-offline-hook-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = fileURLToPath(new URL('../bin/dsh-bridge-hook.js', import.meta.url))
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true,
      env: { ...process.env, DSH_BRIDGE_HOST_FILE: path.join(dir, 'missing.json') }, timeout: 5000 })
    let stdout = '', stderr = ''
    child.stdout.on('data', (s) => { stdout += s })
    child.stderr.on('data', (s) => { stderr += s })
    child.on('error', reject)
    child.on('close', (code) => {
      try { assert.equal(code, 0); assert.deepEqual(JSON.parse(stdout), {}); assert.equal(stderr, ''); resolve() }
      catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ session_id: 'thread', turn_id: 'turn', hook_event_name: 'Stop' }))
  })
})
