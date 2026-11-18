#!/usr/bin/env node
/**
 * Thin Codex-side adapter: newline-delimited JSON-RPC (MCP) over stdio, forwarding
 * one `bridge` tool to the authenticated loopback API of the running DSH host.
 *
 * It deliberately owns no state. The host is the single source of truth, so a
 * Codex restart or an adapter restart cannot fork the room.
 */
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { PARAMETERS, DESCRIPTION } from '../lib/core/tool-schema.js'
import { VERSION } from '../lib/version.js'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'dsh-codex-bridge', title: 'DSH × Codex Bridge', version: VERSION }
const MAX_RETRIES = 1

let cachedHost = null

function hostFileCandidates() {
  const explicit = [process.env.DSH_BRIDGE_HOST_FILE, ...process.argv.slice(2).flatMap((arg) => {
    if (arg.startsWith('--host-file=')) return [arg.slice('--host-file='.length)]
    return []
  })].filter(Boolean)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'desktop'
  return [...explicit, path.join(home, 'bridge', profile, 'host.json')]
}

async function loadHost({ fresh = false } = {}) {
  if (cachedHost && !fresh) return cachedHost
  const errors = []
  for (const file of hostFileCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (!parsed.url || !parsed.token) throw new Error('host.json is missing url or token')
      cachedHost = { ...parsed, file }
      return cachedHost
    } catch (error) {
      errors.push(`${file}: ${error.code ?? error.message}`)
    }
  }
  const detail = errors.length > 0 ? ` (${errors.join('; ')})` : ''
  throw new Error(
    `DSH bridge host is not running or host.json is unreadable${detail}. Start DSH with the dsh-codex-bridge bundle enabled.`,
  )
}

async function callHost(identity, meta, args) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const host = await loadHost({ fresh: attempt > 0 })
    try {
      const response = await fetch(`${host.url}/v1/tool`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${host.token}`,
        },
        body: JSON.stringify({
          member: 'codex',
          identity,
          meta: {
            threadId: identity,
            sessionId: meta.sessionId,
            turnId: meta.turnId,
            callId: meta.callId,
            cwd: meta.cwd,
          },
          args,
        }),
        signal: AbortSignal.timeout(120_000),
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`bridge host returned non-JSON (${response.status}): ${text.slice(0, 400)}`)
      }
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload?.error?.message ?? `bridge host HTTP ${response.status}`)
        error.code = payload?.error?.code
        error.details = payload?.error?.details
        error.status = response.status
        throw error
      }
      return payload.result
    } catch (error) {
      lastError = error
      const retryable =
        attempt < MAX_RETRIES &&
        (error?.cause?.code === 'ECONNREFUSED' ||
          error?.cause?.code === 'ECONNRESET' ||
          error?.status === 401 ||
          /fetch failed/i.test(error?.message ?? ''))
      if (!retryable) break
      cachedHost = null
    }
  }
  throw lastError
}

function identityFrom(params) {
  const meta = params?._meta ?? {}
  const turn = meta['x-codex-turn-metadata'] ?? {}
  return meta.threadId ?? turn.thread_id ?? meta.thread_id ?? params?.arguments?.thread_id ?? null
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function errorResult(error) {
  const code = error?.code ? `[${error.code}] ` : ''
  const details = error?.details ? `\n${JSON.stringify(error.details, null, 2)}` : ''
  return {
    content: [{ type: 'text', text: `${code}${error?.message ?? String(error)}${details}` }],
    isError: true,
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        'Use the bridge tool to collaborate with a paired DSH session. Call bridge({action:"whoami"}) first. The room must be created or joined by explicit pairing; never guess a session or thread id.',
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    if (!isNotification) reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, {
      tools: [
        {
          name: 'bridge',
          description: DESCRIPTION,
          inputSchema: PARAMETERS,
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
      ],
    })
    return
  }
  if (method === 'tools/call') {
    if (params?.name !== 'bridge') {
      reply(id, errorResult(new Error(`unknown tool "${params?.name}"`)))
      return
    }
    const identity = identityFrom(params)
    if (!identity) {
      reply(
        id,
        errorResult(
          Object.assign(
            new Error(
              'Codex did not include a thread id in the MCP call metadata. This bridge refuses to guess a session. Pass thread_id explicitly only if you copied the real UUID from this session.',
            ),
            { code: 'identity_unavailable' },
          ),
        ),
      )
      return
    }
    try {
      const meta = params?._meta ?? {}
      const turn = meta['x-codex-turn-metadata'] ?? {}
      const result = await callHost(identity, { callId: meta.callId, turnId: meta.turnId ?? meta.turn_id ?? turn.turn_id, cwd: process.cwd() }, params?.arguments ?? {})
      reply(id, textResult(result))
    } catch (error) {
      reply(id, errorResult(error))
    }
    return
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] })
    return
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] })
    return
  }
  if (isNotification) return
  replyError(id, -32601, `method not found: ${method}`)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    replyError(null, -32700, 'parse error')
    return
  }
  if (Array.isArray(message)) {
    for (const item of message) {
      handle(item).catch((error) => {
        if (item?.id !== undefined && item?.id !== null) replyError(item.id, -32603, String(error?.message ?? error))
      })
    }
    return
  }
  handle(message).catch((error) => {
    if (message?.id !== undefined && message?.id !== null) replyError(message.id, -32603, String(error?.message ?? error))
  })
})

rl.on('close', () => {
  process.exitCode = 0
})
