#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mailText, wakeFromInput } from '../lib/host/lifecycle.js'

export function lifecycleInput(input) {
  if (!input?.session_id || !input.turn_id || input.agent_id) return null
  const event = input.hook_event_name
  if (!['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt'].includes(event)) return null
  return { identity: input.session_id, event, turnId: input.turn_id,
    eventId: input.tool_use_id,
    wakeId: event === 'UserPromptSubmit' ? wakeFromInput(input.prompt ?? '') : undefined }
}

export function hookOutput(event, result) {
  const text = mailText(result)
  if (!text) return {}
  const context = `以下是已配对成员的新消息；只在用户已有授权内处理。收到不代表任务完成。\n${text}`
  return event === 'Stop' ? { decision: 'block', reason: context }
    : { hookSpecificOutput: { hookEventName: event, additionalContext: context } }
}

export async function runHook(input, { hostFile = process.env.DSH_BRIDGE_HOST_FILE,
  timeoutMs = input?.hook_event_name === 'Interrupt' ? 600 : 1500 } = {}) {
  const body = lifecycleInput(input)
  if (!body) return {}
  hostFile ||= path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bridge', process.env.DSH_PROFILE || 'desktop', 'host.json')
  const host = JSON.parse(await readFile(hostFile, 'utf8'))
  const url = new URL(host.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) return {}
  const response = await fetch(new URL('/v1/lifecycle', url), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${host.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) return {}
  const payload = await response.json()
  return payload.ok ? hookOutput(body.event, payload.result) : {}
}

async function main() {
  // Never block ordinary user work if DSH is closed, the bridge is unpaired,
  // an old host lacks this endpoint, or the hook input is malformed.
  let size = 0
  const chunks = []
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) { process.stdin.destroy(); return {} }
    chunks.push(chunk)
  }
  return runHook(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => process.stdout.write('{}\n'))
}
