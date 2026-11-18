#!/usr/bin/env node
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./dsh-bridge-hook.js', import.meta.url)).replaceAll('\\', '/')
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt']
const OWNER = 'dsh-codex-bridge: automatic inbox'

export function mergeHooks(config, script = SCRIPT) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('hooks config must be an object')
  if (/["\r\n`$%!]/.test(script)) throw new Error('unsupported hook script path')
  const result = structuredClone(config)
  result.hooks ??= {}
  for (const event of EVENTS) {
    const entries = result.hooks[event] ?? []
    if (!Array.isArray(entries)) throw new Error(`invalid ${event} entries`)
    // Identify our exact script filename, not a broad substring in user hooks.
    const kept = entries.map((entry) => ({ ...entry, hooks: entry.hooks?.filter((hook) =>
      !(hook.type === 'command' && hook.statusMessage === OWNER && /dsh-bridge-hook\.js["']?(?:\s|$)/.test(hook.command ?? ''))) }))
      .filter((entry) => !Array.isArray(entry.hooks) || entry.hooks.length)
    kept.push({ ...(event.includes('ToolUse') || event === 'PermissionRequest' ? { matcher: '.*' } : {}),
      hooks: [{ type: 'command', command: `node "${script}"`, timeout: event === 'Interrupt' ? 1 : 3, statusMessage: OWNER }] })
    result.hooks[event] = kept
  }
  return result
}

export async function installHooks({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), dryRun = false, output } = {}) {
  const target = path.join(codexHome, 'hooks.json')
  if (output && path.resolve(output).toLowerCase() === path.resolve(target).toLowerCase()) throw new Error('preview output must differ from hooks.json')
  let original = '{}'
  let exists = false
  try { original = await readFile(target, 'utf8'); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  const merged = `${JSON.stringify(mergeHooks(JSON.parse(original)), null, 2)}\n`
  if (output) { await mkdir(path.dirname(path.resolve(output)), { recursive: true }); await writeFile(output, merged) }
  if (dryRun) return { dryRun: true, target, output, events: EVENTS, reviewRequired: true }
  if (original.trim() === merged.trim()) return { target, unchanged: true, reviewRequired: true }
  await mkdir(codexHome, { recursive: true })
  const backup = exists ? `${target}.bridge-backup-${Date.now()}` : null
  if (backup) await copyFile(target, backup)
  const temp = `${target}.bridge-${process.pid}.tmp`
  await writeFile(temp, merged)
  await rename(temp, target)
  return { target, backup, reviewRequired: true,
    next: 'Review and trust the exact hook definitions using Codex /hooks or its hook review UI, then restart/resume the paired chat. This installer never changes hook trust.' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputArg = process.argv.find((arg) => arg.startsWith('--output='))
  installHooks({ dryRun: process.argv.includes('--dry-run'), output: outputArg?.slice(9) })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1 })
}
