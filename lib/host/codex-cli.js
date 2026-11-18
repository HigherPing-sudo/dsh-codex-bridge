import { execFile as execFileCallback } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFileCallback)

/**
 * Windows-first Codex CLI wrapper. Delivery is proven only by a queue
 * acknowledgement without the "could not resume" warning; a zero exit code
 * alone is deliberately not treated as delivery.
 */
export class CodexCli {
  constructor({ codexPath, timeoutMs = 90_000, execFileImpl, env = process.env } = {}) {
    this.explicitPath = codexPath
    this.timeoutMs = timeoutMs
    this.execFileImpl = execFileImpl ?? execFileAsync
    this.env = env
    this.resolved = null
  }

  async resolve() {
    if (this.resolved) return this.resolved
    const candidates = []
    if (this.explicitPath) candidates.push({ file: this.explicitPath, source: 'config' })
    if (this.env.DSH_CODEX_PATH) candidates.push({ file: this.env.DSH_CODEX_PATH, source: 'env' })
    const appData = this.env.APPDATA
    if (appData) {
      candidates.push({
        file: path.join(
          appData,
          'npm',
          'node_modules',
          '@openai',
          'codex',
          'node_modules',
          '@openai',
          'codex-win32-x64',
          'vendor',
          'x86_64-pc-windows-msvc',
          'bin',
          'codex.exe',
        ),
        source: 'npm',
      })
    }
    for (const candidate of await windowsStoreCandidates()) candidates.push(candidate)

    for (const candidate of candidates) {
      if (!candidate.file) continue
      try {
        await access(candidate.file)
      } catch {
        continue
      }
      const version = await this.#version(candidate.file)
      this.resolved = { file: candidate.file, source: candidate.source, version }
      return this.resolved
    }
    this.resolved = { file: null, source: 'missing', version: null }
    return this.resolved
  }

  async #version(file) {
    try {
      const { stdout } = await this.execFileImpl(file, ['--version'], {
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      const match = String(stdout).match(/codex-cli\s+([0-9][^\s]*)/i)
      return match ? match[1] : String(stdout).trim()
    } catch {
      return null
    }
  }

  /**
   * Run `codex queue`. Never throw for a transport failure; return a classified
   * result so the caller can persist the exact delivery state.
   * @param {{threadId: string, message: string, resume?: boolean}} input
   */
  async queue({ threadId, message, resume = true }) {
    const codex = await this.resolve()
    if (!codex.file) {
      return {
        state: 'failed',
        detail: 'codex executable not found; set bridge config codexPath or DSH_CODEX_PATH',
        evidence: { code: 'codex_not_found' },
      }
    }
    const args = ['queue', '--thread', threadId, '--message', message]
    if (resume) args.push('--resume')
    try {
      const { stdout, stderr } = await this.execFileImpl(codex.file, args, {
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      return classifyQueueResult({ code: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false })
    } catch (error) {
      const stderr = String(error?.stderr ?? '')
      const stdout = String(error?.stdout ?? '')
      const timedOut = Boolean(error?.killed) || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT'
      const result = classifyQueueResult({
        code: typeof error?.code === 'number' ? error.code : 1,
        stdout,
        stderr,
        timedOut,
        error,
      })
      return result
    }
  }

  async daemonStatus() {
    const codex = await this.resolve()
    if (!codex.file) return { running: false, error: 'codex executable not found' }
    try {
      const { stdout } = await this.execFileImpl(codex.file, ['app-server', 'daemon', 'version'], {
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      return { running: true, raw: String(stdout).trim(), json: parseJson(String(stdout)) }
    } catch (error) {
      return {
        running: false,
        error: String(error?.stderr || error?.message || error).trim(),
      }
    }
  }

  async startDaemon() {
    const codex = await this.resolve()
    if (!codex.file) return { started: false, error: 'codex executable not found' }
    try {
      const { stdout, stderr } = await this.execFileImpl(codex.file, ['app-server', 'daemon', 'start'], {
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      return { started: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
    } catch (error) {
      return { started: false, error: String(error?.stderr || error?.message || error).trim() }
    }
  }
}

/**
 * Classify a queue invocation without over-claiming.
 * - exit 0 + queued id + no warning -> queued (accepted by the local queue)
 * - exit 0 + queued id + resume warning -> queued_unresumed (must not retry blindly)
 * - exit 0 without an ack -> unknown
 * - timeout / killed -> unknown (the command may have queued before dying)
 * - non-zero -> failed
 */
export function classifyQueueResult({ code, stdout = '', stderr = '', timedOut = false, error } = {}) {
  const ack = stdout.match(/Queued message\s+(\S+)\s+for thread\s+(\S+)/i)
  const queuedId = ack?.[1]
  const threadId = ack?.[2]?.replace(/[.,;:]+$/, '')
  const warning = /could not resume thread/i.test(stderr)
  if (timedOut) {
    return {
      state: 'unknown',
      detail: 'codex queue timed out; it may have queued before being killed. Verify the thread before resending.',
      evidence: { queuedId, threadId, stdout: stdout.trim(), stderr: stderr.trim() },
    }
  }
  if (code === 0) {
    if (warning) {
      return {
        state: 'queued_unresumed',
        detail: stderr.trim(),
        evidence: { queuedId, threadId, warning: true },
      }
    }
    if (queuedId) {
      return { state: 'queued', detail: 'queued by codex; peer processing not yet observed', evidence: { queuedId, threadId } }
    }
    return {
      state: 'unknown',
      detail: 'codex queue exited 0 but printed no queue acknowledgement',
      evidence: { stdout: stdout.trim(), stderr: stderr.trim() },
    }
  }
  return {
    state: 'failed',
    detail: (stderr || stdout || error?.message || `codex queue exited ${code}`).trim(),
    evidence: { code, stdout: stdout.trim(), stderr: stderr.trim() },
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function windowsStoreCandidates(env = process.env) {
  if (process.platform !== 'win32') return []
  const roots = [env['ProgramFiles'], 'C:\\Program Files'].filter(Boolean)
  const results = []
  for (const root of roots) {
    const windowsApps = path.join(root, 'WindowsApps')
    let entries
    try {
      entries = await readdir(windowsApps)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!/^OpenAI\.Codex_/i.test(entry)) continue
      results.push({
        file: path.join(windowsApps, entry, 'app', 'resources', 'codex.exe'),
        source: `desktop:${entry}`,
      })
    }
  }
  return results
}
