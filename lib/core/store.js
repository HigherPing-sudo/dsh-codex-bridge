import { mkdir, readFile, rename, writeFile, copyFile, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { newId } from './ids.js'

export function emptyState() {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    rooms: {},
    messages: {},
    tasks: {},
    decisions: {},
    dedupe: {},
    tombstones: {},
  }
}

export class MemoryStore {
  constructor(initial = emptyState()) {
    this.state = structuredClone(initial)
    this.saves = 0
  }

  async load() {
    return this.state
  }

  async save(state) {
    this.state = structuredClone(state)
    this.saves += 1
  }

  async backup() {
    return null
  }
}

/**
 * One JSON document, written with temp-file + rename so a crash cannot leave a
 * half-written state file. A corrupt file is preserved as `.corrupt-<ts>` and
 * the bridge starts from an empty state rather than deleting evidence.
 */
export class JsonFileStore {
  /**
   * @param {string} filePath
   * @param {{backupDir?: string}} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath
    this.backupDir = options.backupDir ?? path.join(path.dirname(filePath), 'backups')
    this.state = null
    this.pending = Promise.resolve()
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || !parsed.rooms || !parsed.messages) {
        throw new Error('state document has an unexpected shape')
      }
      this.state = parsed
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.state = emptyState()
      } else {
        const broken = `${this.filePath}.corrupt-${Date.now()}`
        try {
          await rename(this.filePath, broken)
        } catch {
          // Best effort: the original read error is the useful one.
        }
        this.state = emptyState()
        this.lastLoadError = { message: error instanceof Error ? error.message : String(error), broken }
      }
    }
    return this.state
  }

  /** Copy the current file into a timestamped backup before a destructive migration. */
  async backup(label = 'manual') {
    try {
      await access(this.filePath, fsConstants.F_OK)
    } catch {
      return null
    }
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 })
    const target = path.join(this.backupDir, `bridge-${label}-${Date.now()}.json`)
    await copyFile(this.filePath, target)
    return target
  }

  async save(state) {
    const run = async () => {
      const tmp = `${this.filePath}.tmp-${process.pid}-${newId('w')}`
      const body = `${JSON.stringify(state, null, 2)}\n`
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
    }
    const next = this.pending.then(run, run)
    this.pending = next.catch(() => undefined)
    return next
  }
}
