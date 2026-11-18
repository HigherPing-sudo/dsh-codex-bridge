import { readFileSync } from 'node:fs'

/**
 * Single source of truth for the bridge version: the installed package.json.
 * Both the host runtime and the stdio MCP adapter report this value, so a
 * version bump cannot drift between health output, host.json and MCP serverInfo.
 */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version
