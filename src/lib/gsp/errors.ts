/** Typed errors so the UI can react to failure kinds instead of matching strings. */

export class GspError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GspError'
  }
}

/** The browser cannot do Web Bluetooth at all, or not in this context. */
export class GspUnsupportedError extends GspError {
  constructor(message: string) {
    super(message)
    this.name = 'GspUnsupportedError'
  }
}

/** No notification arrived for a command within its timeout. */
export class GspTimeoutError extends GspError {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} timed out after ${timeoutMs} ms`)
    this.name = 'GspTimeoutError'
  }
}

/** The sensor answered, but with a non-success status. */
export class GspStatusError extends GspError {
  constructor(
    readonly command: string,
    readonly status: number,
    readonly path?: string,
  ) {
    super(
      `${command}${path ? ` ${path}` : ''} failed with status ${status}`,
    )
    this.name = 'GspStatusError'
  }
}

/** The link dropped, either unexpectedly or because we asked it to. */
export class GspDisconnectedError extends GspError {
  constructor(message = 'Sensor disconnected') {
    super(message)
    this.name = 'GspDisconnectedError'
  }
}

/** A response could not be decoded - usually a payload shorter than expected. */
export class GspDecodeError extends GspError {
  constructor(message: string) {
    super(message)
    this.name = 'GspDecodeError'
  }
}

/** Every reference code is in use. Means references are leaking somewhere. */
export class GspRefExhaustedError extends GspError {
  constructor() {
    super('No GSP reference codes available')
    this.name = 'GspRefExhaustedError'
  }
}

/**
 * The sensor answered 429: its Whiteboard request pool is exhausted.
 *
 * Observed on hardware, and worth knowing exactly how bad it is: once the pool is
 * gone the sensor answers 429 to *every* request, and **reconnecting does not
 * clear it**. Only a reboot does. A request that times out without a response
 * appears to leave its slot occupied, so a client must not fire unbounded bursts.
 */
export class GspBusyError extends GspError {
  constructor(
    readonly command: string,
    readonly path?: string,
  ) {
    super(
      `${command}${path ? ` ${path}` : ''} refused with 429: the sensor has no free request slots. ` +
        'This does not clear on reconnect - the sensor needs a reboot.',
    )
    this.name = 'GspBusyError'
  }
}

/** The caller aborted the operation. */
export class GspAbortedError extends GspError {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'GspAbortedError'
  }
}
