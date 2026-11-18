#!/usr/bin/env node
/**
 * Operator CLI. It never edits DSH session databases or logs: state lives in
 * its own JSON file, and Codex configuration is changed only through
 * `codex mcp add/remove` with a timestamped backup.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Bridge } from '../lib/core/bridge.js'
import { MemoryStore } from '../lib/core/store.js'
import { formatMessageLine, formatRoomLine } from '../lib/core/envelope.js'
import { CodexCli } from '../lib/host/codex-cli.js'
import { installHooks } from './dsh-bridge-hooks.js'
import { DesktopCodex } from '../lib/host/desktop-codex.js'
import { VERSION } from '../lib/version.js'

const execFile = promisify(execFileCallback)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ADAPTER = path.join(HERE, 'dsh-bridge-mcp.js')
const MCP_NAME = 'dsh-codex-bridge'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profile = process.env.DSH_PROFILE || 'desktop'
const bridgeDir = path.join(home, 'bridge', safeSegment(profile))
const stateFile = path.join(bridgeDir, 'bridge.json')
const hostFile = path.join(bridgeDir, 'host.json')

const [, , command = 'help', ...rest] = process.argv

async function main() {
  switch (command) {
    case 'doctor':
      return doctor()
    case 'status':
      return status(rest[0])
    case 'paths':
      return paths()
    case 'daemon-start':
      return daemonStart()
    case 'desktop-probe':
      return desktopProbe(rest[0])
    case 'install-mcp':
      return installMcp()
    case 'uninstall-mcp':
      return uninstallMcp(rest.includes('--restore'))
    case 'install-skill':
      return installSkill(rest)
    case 'install-hooks':
      console.log(JSON.stringify(await installHooks({ dryRun: rest.includes('--dry-run'), output: rest.find((arg) => arg.startsWith('--output='))?.slice(9) }), null, 2))
      return
    case 'help':
    case '--help':
    case '-h':
      return help()
    default:
      console.error(`unknown command "${command}"`)
      help()
      process.exitCode = 1
  }
}

function help() {
  console.log(`dsh-codex-bridge ${VERSION}

Usage: node bin/dsh-bridge.js <command>

  doctor                 Check DSH host, Codex CLI, adapter, MCP registration and room state
  status [room_id]       Read-only room summary (works even when the DSH host is stopped)
  paths                  Print state, host and adapter paths
  daemon-start           Start the local Codex app-server daemon (needed by queue --resume)
  desktop-probe [thread_id]
                         Read-only check of the exact paired desktop thread; no model turn started
  install-mcp            Back up Codex config.toml, then register this adapter with codex mcp add
  uninstall-mcp [--restore]
                         Remove the MCP entry; --restore also restores the recorded backup
  install-skill          Install the collaboration skill for Codex and DSH
  install-hooks [--dry-run] [--output=<preview.json>]
                         Legacy 0.1.15 hook option; not required by desktop-native mode

Environment: DSH_HOME (default ${home}), DSH_PROFILE (default ${profile})
Nothing here rewrites DSH sessions, logs or the official program files.`)
}

function paths() {
  console.log(`repo       ${ROOT}`)
  console.log(`adapter    ${ADAPTER}`)
  console.log(`state      ${stateFile}`)
  console.log(`host       ${hostFile}`)
  console.log(`profile    ${profile}`)
  console.log(`codex home ${codexHome()}`)
}

async function doctor() {
  const checks = []
  const check = (level, name, detail) => checks.push({ level, name, detail })
  check('ok', 'node', `${process.version} (${process.platform}/${process.arch})`)
  check('ok', 'profile', `${profile} at ${path.join(home, 'profiles', profile)}`)
  try {
    await access(path.join(home, 'profiles', profile, 'package.json'))
    check('ok', 'profile package.json', 'present')
  } catch {
    check('warn', 'profile package.json', `not found under ${home}`)
  }
  try {
    await access(ADAPTER)
    check('ok', 'codex adapter', ADAPTER)
  } catch {
    check('fail', 'codex adapter', `missing at ${ADAPTER}`)
  }

  const codex = new CodexCli({})
  const resolved = await codex.resolve()
  if (resolved.file) check('ok', 'codex', `${resolved.version ?? 'unknown version'} (${resolved.source}) ${resolved.file}`)
  else check('fail', 'codex', 'executable not found; set DSH_CODEX_PATH or bridge codexPath')

  check('ok', 'codex delivery', 'desktop-native by default; separate CLI daemon and hooks are not required')

  const mcp = await listMcp(codex)
  const entry = mcp.find((line) => line.includes(MCP_NAME))
  check(entry ? 'ok' : 'warn', 'codex mcp', entry ?? `"${MCP_NAME}" is not registered (run install-mcp)`)

  const host = await readJson(hostFile)
  if (host) {
    check('ok', 'host.json', `${host.url} pid=${host.pid} started=${host.startedAt}`)
    try {
      const response = await fetch(`${host.url}/v1/health`, {
        headers: { authorization: `Bearer ${host.token}` },
        signal: AbortSignal.timeout(4000),
      })
      const payload = await response.json()
      if (payload.ok) check('ok', 'host health', `uptime pid ${payload.pid}, ${payload.rooms} room(s)`)
      else check('warn', 'host health', JSON.stringify(payload))
    } catch (error) {
      check('warn', 'host health', `host.json exists but the API is unreachable: ${error.message}`)
    }
  } else {
    check('warn', 'host.json', 'absent; the DSH host has not started with the bundle enabled')
  }

  const state = await readJson(stateFile)
  const rooms = Object.values(state?.rooms ?? {})
  const active = rooms.filter((room) => room.status === 'active').length
  check('ok', 'rooms', rooms.length === 0 ? 'no rooms yet' : `${rooms.length} total, ${active} active, ${rooms.filter((r) => r.status === 'paused').length} paused`)

  for (const item of checks) {
    const tag = item.level === 'ok' ? 'OK  ' : item.level === 'warn' ? 'WARN' : 'FAIL'
    console.log(`[${tag}] ${item.name}: ${item.detail}`)
  }
  if (checks.some((item) => item.level === 'fail')) process.exitCode = 1
}

async function desktopProbe(explicitThread) {
  const state = await readJson(stateFile)
  const ids = explicitThread ? [explicitThread] : [...new Set(Object.values(state?.rooms ?? {})
    .filter((room) => ['active', 'paused'].includes(room.status)).map((room) => room.codexThreadId).filter(Boolean))]
  if (!ids.length) { console.log('No paired Codex thread; pass an exact thread UUID to inspect.'); return }
  const desktop = new DesktopCodex()
  try {
    for (const threadId of ids) {
      if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('an exact thread UUID is required')
      const snapshot = await desktop.snapshot(threadId)
      console.log(JSON.stringify(snapshot, null, 2))
      if (snapshot.unavailable) process.exitCode = 1
    }
  } finally { desktop.close() }
}

async function status(roomId) {
  const state = await readJson(stateFile)
  if (!state) {
    console.log(`No bridge state at ${stateFile}. Create a room from the DSH session first.`)
    return
  }
  // Offline status is a snapshot inspection, never a writer competing with
  // the live Host (including when normalization migrates an older schema).
  const bridge = await new Bridge({ store: new MemoryStore(state), config: {} }).init()
  const rooms = Object.values(bridge.state.rooms)
  if (rooms.length === 0) {
    console.log('No rooms.')
    return
  }
  if (!roomId) {
    console.log('room\tstatus\tdsh_session\tcodex_thread\tgoal')
    for (const room of rooms) console.log(formatRoomLine(room))
    return
  }
  const room = bridge.getRoom(roomId)
  const view = bridge.roomView(room, 'dsh')
  console.log(JSON.stringify(view, null, 2))
  console.log('\nmessages:')
  for (const message of bridge.roomHistory(room, { limit: 200 })) console.log(formatMessageLine(message))
  console.log('\ntasks:')
  for (const task of bridge.tasksFor(room, 'dsh')) console.log(`${task.id}\t${task.status}\towner=${task.owner}\t${task.title}`)
  console.log('\ndecisions:')
  for (const decision of bridge.decisionsFor(room)) console.log(`${decision.id}\t${decision.status}\t${decision.question}`)
}

async function daemonStart() {
  const codex = new CodexCli({})
  const result = await codex.startDaemon()
  console.log(JSON.stringify(result, null, 2))
  if (!result.started) process.exitCode = 1
}

async function installMcp() {
  const codex = new CodexCli({})
  const resolved = await codex.resolve()
  if (!resolved.file) {
    console.error('Codex executable not found. Set DSH_CODEX_PATH or install the Codex CLI.')
    process.exitCode = 1
    return
  }
  await mkdir(bridgeDir, { recursive: true })
  const backup = await backupCodexConfig()
  if (backup) console.log(`backup: ${backup}`)

  try {
    await runCodex(resolved.file, ['mcp', 'remove', MCP_NAME])
    console.log(`removed existing ${MCP_NAME} entry (if any)`)
  } catch {
    // no existing entry
  }

  const args = [
    'mcp',
    'add',
    MCP_NAME,
    '--env',
    `DSH_HOME=${home}`,
    '--env',
    `DSH_PROFILE=${profile}`,
    '--',
    process.execPath,
    ADAPTER,
  ]
  const result = await runCodex(resolved.file, args)
  console.log(result.stdout.trim() || `registered ${MCP_NAME}`)
  if (result.stderr.trim()) console.log(result.stderr.trim())

  const installRecord = {
    version: 1,
    installedAt: new Date().toISOString(),
    codex: resolved.file,
    codexHome: codexHome(),
    adapter: ADAPTER,
    command: [process.execPath, ADAPTER],
    env: { DSH_HOME: home, DSH_PROFILE: profile },
    configBackup: backup,
  }
  await writeFile(path.join(bridgeDir, 'mcp-install.json'), JSON.stringify(installRecord, null, 2))
  console.log(`record: ${path.join(bridgeDir, 'mcp-install.json')}`)
  console.log('Restart Codex (or start a new Codex session) so it launches the updated MCP server.')
}

async function uninstallMcp(restore) {
  const codex = new CodexCli({})
  const resolved = await codex.resolve()
  if (!resolved.file) {
    console.error('Codex executable not found.')
    process.exitCode = 1
    return
  }
  try {
    const result = await runCodex(resolved.file, ['mcp', 'remove', MCP_NAME])
    console.log(result.stdout.trim() || `removed ${MCP_NAME}`)
  } catch (error) {
    console.log(`no ${MCP_NAME} entry to remove (${error.stderr?.trim() || error.message})`)
  }
  if (restore) {
    const record = await readJson(path.join(bridgeDir, 'mcp-install.json'))
    if (!record?.configBackup) {
      console.error('No recorded backup; cannot restore automatically.')
      process.exitCode = 1
      return
    }
    await copyFile(record.configBackup, path.join(codexHome(), 'config.toml'))
    console.log(`restored ${record.configBackup} -> ${path.join(codexHome(), 'config.toml')}`)
    console.log('This also reverts any Codex config changes made after that backup.')
  }
}

async function installSkill(rest) {
  const only = rest.find((item) => item === '--codex-only' || item === '--dsh-only')
  const targets = []
  if (only !== '--dsh-only') {
    targets.push({ root: path.join(codexHome(), 'skills'), source: path.join(ROOT, 'skills', 'codex') })
  }
  if (only !== '--codex-only') {
    targets.push({ root: path.join(home, 'skills'), source: path.join(ROOT, 'skills', 'dsh') })
  }
  for (const target of targets) {
    const dir = path.join(target.root, 'dsh-codex-bridge')
    await mkdir(dir, { recursive: true })
    await copyFile(path.join(target.source, 'SKILL.md'), path.join(dir, 'SKILL.md'))
    console.log(`installed ${path.join(dir, 'SKILL.md')}`)
  }
  console.log('Restart the relevant client to pick up a newly installed skill.')
}

async function backupCodexConfig() {
  const config = path.join(codexHome(), 'config.toml')
  try {
    await access(config)
  } catch {
    return null
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const backup = path.join(bridgeDir, 'backups', `config.toml.${stamp}`)
  await mkdir(path.dirname(backup), { recursive: true })
  await copyFile(config, backup)
  return backup
}

async function listMcp(codex) {
  try {
    const resolved = await codex.resolve()
    const { stdout } = await execFile(resolved.file, ['mcp', 'list'], { timeout: 20_000, windowsHide: true })
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_') || 'desktop'
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function runCodex(file, args) {
  return execFile(file, args, { timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
