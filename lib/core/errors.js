/** Typed errors that cross the tool, HTTP, and MCP boundaries. */
export class BridgeError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {string} message human-readable message
   * @param {unknown} [details] optional structured details
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function fail(code, message, details) {
  throw new BridgeError(code, message, details)
}

export function asBridgeError(error) {
  if (error instanceof BridgeError) return error
  return new BridgeError('internal', error instanceof Error ? error.message : String(error))
}

/** Serialize an error for JSON / tool output without leaking stack traces. */
export function errorPayload(error) {
  const err = asBridgeError(error)
  return {
    code: err.code,
    message: err.message,
    ...(err.details === undefined ? {} : { details: err.details }),
  }
}
