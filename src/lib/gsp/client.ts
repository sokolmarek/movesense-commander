import {
  DataLoggerState,
  GspCommand,
  SystemMode,
  TIME_DETAILED_PATH,
} from './constants'
import {
  decodeHello,
  decodeLogbookEntries,
  decodeUint8,
  type DeviceInfo,
  type LogbookEntry,
} from './decoders'
import {
  GspAbortedError,
  GspBusyError,
  GspDisconnectedError,
  GspStatusError,
  GspTimeoutError,
} from './errors'
import {
  commandName,
  encodeClearLogbook,
  encodeDataLoggerConfig,
  encodeDataLoggerState,
  encodeFetchLog,
  encodeGet,
  encodeHello,
  encodeSubscribe,
  encodeSystemMode,
  encodeUnsubscribe,
  encodeUtcTime,
  parseFrame,
  readLogChunk,
  readStatus,
} from './framing'
import { ReferenceAllocator } from './refs'
import type { TraceRecorder } from './trace'
import type { GspTransport } from './transport'

const DEFAULT_TIMEOUT_MS = 10_000
/**
 * How many command/response exchanges may be in flight at once.
 *
 * The sensor has a small pool of Whiteboard request slots and answers 429 when it
 * runs out - a state that survives reconnection and needs a reboot to clear. Two
 * at a time keeps the pipeline usefully busy without ever approaching that.
 */
const DEFAULT_MAX_CONCURRENT = 2
/** Gap allowed between two log data packets before we give up on a fetch. */
const DEFAULT_DATA_TIMEOUT_MS = 30_000

interface PendingRequest {
  label: string
  resolve: (payload: Uint8Array) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface Subscription {
  readonly path: string
  readonly reference: number
  close(): Promise<void>
}

export interface FetchLogResult {
  data: Uint8Array
  /** Byte ranges that never arrived, as `[start, end)` pairs. Empty is good. */
  gaps: Array<[number, number]>
  /** Total bytes delivered, which exceeds `data.length` if the sensor resent any. */
  deliveredBytes: number
}

export interface FetchLogProgress {
  /**
   * Highest byte position reached in the file. This is what a progress bar should
   * track: it is bounded by the file size and never goes backwards.
   */
  readonly position: number
  /**
   * Every byte delivered, including anything the sensor sent twice. Summing
   * deliveries is *not* a position - that is what made the old bar overshoot the
   * stated size.
   */
  readonly deliveredBytes: number
  /** Size from the logbook listing, when known. */
  readonly total: number | null
  /** True once more has arrived than the logbook said the log holds. */
  readonly overrun: boolean
}

export interface FetchLogOptions {
  onProgress?: (progress: FetchLogProgress) => void
  signal?: AbortSignal
  /** Expected size, when known from the logbook listing, for progress reporting. */
  expectedSize?: number
  dataTimeoutMs?: number
  /**
   * Receive each chunk as it arrives instead of assembling in memory.
   *
   * When set, nothing is buffered and `data` comes back empty: the caller is
   * writing the bytes somewhere itself, which is how a large log can go straight
   * to disk rather than through the heap.
   */
  onChunk?: (offset: number, bytes: Uint8Array) => void
}

export interface GspClientOptions {
  trace?: TraceRecorder
  timeoutMs?: number
  /** In-flight command limit. See `DEFAULT_MAX_CONCURRENT`. */
  maxConcurrent?: number
}

/**
 * A GSP client over one transport.
 *
 * Responses are demultiplexed by reference code, which is the whole point:
 * commands are processed asynchronously by the sensor and their responses may
 * interleave with subscription data. The Python reference tool instead drains a
 * single shared queue before every write, which races.
 */
export class GspClient {
  private readonly refs = new ReferenceAllocator()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly dataHandlers = new Map<
    number,
    (payload: Uint8Array, continuation: boolean) => void
  >()
  private readonly timeoutMs: number
  private readonly trace: TraceRecorder | undefined
  private readonly maxConcurrent: number
  private inFlight = 0
  private readonly waiting: Array<() => void> = []
  private unlisten: Array<() => void> = []
  private closed = false

  constructor(
    private readonly transport: GspTransport,
    options: GspClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.trace = options.trace
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  }

  /** Attach to the transport. Call after `transport.connect()`. */
  start(): void {
    this.unlisten.push(
      this.transport.onNotify((bytes) => this.handleNotification(bytes)),
      this.transport.onDisconnect(() => this.handleDisconnect()),
    )
  }

  /** Detach and fail everything in flight. Does not disconnect the transport. */
  stop(): void {
    this.closed = true
    for (const off of this.unlisten) off()
    this.unlisten = []
    this.failAll(new GspDisconnectedError('Client stopped'))
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Device identity. HELLO is the one response with no status field, so the
   * payload is decoded straight from byte 2 of the frame.
   */
  async hello(): Promise<DeviceInfo> {
    const { payload } = await this.request(
      (ref) => encodeHello(ref),
      commandName(GspCommand.Hello),
    )
    return decodeHello(payload)
  }

  /**
   * Raw GET. Returns the status rather than throwing on it, so callers such as
   * the API explorer can show a 404 as a result instead of an error.
   */
  async get(path: string): Promise<{ status: number; data: Uint8Array }> {
    const { payload } = await this.request(
      (ref) => encodeGet(ref, path),
      `GET ${path}`,
    )
    return readStatus(payload)
  }

  /** GET, but a non-200 status is an error. */
  async getOrThrow(path: string): Promise<Uint8Array> {
    const { status, data } = await this.get(path)
    if (status === 429) throw new GspBusyError('GET', path)
    if (status !== 200) throw new GspStatusError('GET', status, path)
    return data
  }

  /** Battery charge, 0-100. */
  async getBatteryLevel(): Promise<number> {
    const data = await this.getOrThrow('/System/Energy/Level')
    return decodeUint8(data, 'battery level')
  }

  /** Current DataLogger state - see `DataLoggerState`. */
  async getDataLoggerState(): Promise<number> {
    const data = await this.getOrThrow('/Mem/DataLogger/State')
    return decodeUint8(data, 'DataLogger state')
  }

  /**
   * Set the sensor clock. Without this, recordings have no wall-clock anchor.
   * Defaults to now.
   */
  async putUtcTime(microseconds = Date.now() * 1000): Promise<void> {
    const { payload } = await this.request(
      (ref) => encodeUtcTime(ref, microseconds),
      'PUT /Time',
    )
    this.expect(readStatus(payload).status, [200], 'PUT /Time')
  }

  /**
   * Write the DataLogger configuration. `/Time/Detailed` is appended unless it
   * is already present - it is what maps sensor timestamps to UTC.
   */
  async putDataLoggerConfig(paths: readonly string[]): Promise<void> {
    const withTime = paths.includes(TIME_DETAILED_PATH)
      ? [...paths]
      : [...paths, TIME_DETAILED_PATH]

    const { payload } = await this.request(
      (ref) => encodeDataLoggerConfig(ref, withTime),
      'PUT /Mem/DataLogger/Config',
    )
    this.expect(
      readStatus(payload).status,
      [200],
      'PUT /Mem/DataLogger/Config',
    )
  }

  async putDataLoggerState(state: number): Promise<void> {
    const { payload } = await this.request(
      (ref) => encodeDataLoggerState(ref, state),
      'PUT /Mem/DataLogger/State',
    )
    this.expect(readStatus(payload).status, [200], 'PUT /Mem/DataLogger/State')
  }

  startLogging(): Promise<void> {
    return this.putDataLoggerState(DataLoggerState.Logging)
  }

  stopLogging(): Promise<void> {
    return this.putDataLoggerState(DataLoggerState.Ready)
  }

  /**
   * Change system mode. Accepts 202 as well as 200 - the sensor answers
   * "Accepted" and then drops the link, which is not a failure.
   */
  async putSystemMode(mode: number): Promise<void> {
    const { payload } = await this.request(
      (ref) => encodeSystemMode(ref, mode),
      'PUT /System/Mode',
    )
    this.expect(readStatus(payload).status, [200, 202], 'PUT /System/Mode')
  }

  /** Reboot into the application. Used to roll the log over and to clear a 409. */
  reboot(): Promise<void> {
    return this.putSystemMode(SystemMode.Application)
  }

  /** Erase every recording on the sensor. Irreversible. */
  async clearLogbook(): Promise<void> {
    const { payload } = await this.request(
      (ref) => encodeClearLogbook(ref),
      'DELETE /Mem/Logbook',
    )
    this.expect(readStatus(payload).status, [200], 'DELETE /Mem/Logbook')
  }

  /**
   * The logbook listing.
   *
   * `truncated` means the sensor reported more entries than fit in one
   * notification, so this list is incomplete - see docs/gsp-protocol.md.
   */
  async listLogbookEntries(): Promise<{
    entries: LogbookEntry[]
    declaredCount: number
    truncated: boolean
  }> {
    const data = await this.getOrThrow('/Mem/Logbook/entries')
    const result = decodeLogbookEntries(data)
    if (result.truncated) {
      this.trace?.note(
        `Logbook listing truncated: sensor reports ${result.declaredCount} entries, ${result.entries.length} fit in one notification`,
      )
    }
    return result
  }

  /** Subscribe to a resource. `DATA` frames on this reference go to `onData`. */
  async subscribe(
    path: string,
    onData: (payload: Uint8Array) => void,
  ): Promise<Subscription> {
    const reference = this.refs.allocate()
    this.dataHandlers.set(reference, (payload) => onData(payload))

    try {
      const { payload } = await this.sendWithRef(
        reference,
        encodeSubscribe(reference, path),
        `SUBSCRIBE ${path}`,
        this.timeoutMs,
      )
      this.expect(readStatus(payload).status, [200], `SUBSCRIBE ${path}`)
    } catch (error) {
      this.dataHandlers.delete(reference)
      this.refs.release(reference)
      throw error
    }

    let closed = false
    return {
      path,
      reference,
      close: async () => {
        if (closed) return
        closed = true
        try {
          await this.sendWithRef(
            reference,
            encodeUnsubscribe(reference),
            `UNSUBSCRIBE ${path}`,
            this.timeoutMs,
          )
        } finally {
          this.dataHandlers.delete(reference)
          this.refs.release(reference)
        }
      },
    }
  }

  /**
   * Download one log.
   *
   * Packets carry their own offset and may be lost - GSP notifications are
   * unacknowledged and there is no retransmission - so bytes are assembled into
   * a sparse buffer and any remaining holes are reported in `gaps` rather than
   * silently producing a corrupt file.
   */
  async fetchLog(
    logId: number,
    options: FetchLogOptions = {},
  ): Promise<FetchLogResult> {
    const dataTimeoutMs = options.dataTimeoutMs ?? DEFAULT_DATA_TIMEOUT_MS
    const reference = this.refs.allocate()

    const streaming = options.onChunk !== undefined
    const pieces: Array<{ offset: number; bytes: Uint8Array }> = []
    let delivered = 0
    let end = 0

    let settle: (() => void) | null = null
    let fail: ((error: Error) => void) | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const finished = new Promise<void>((resolve, reject) => {
      settle = resolve
      fail = reject
    })

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        fail?.(new GspTimeoutError(`FETCH_LOG ${logId} data`, dataTimeoutMs))
      }, dataTimeoutMs)
    }

    const onAbort = () => {
      fail?.(new GspAbortedError(`Download of log ${logId} cancelled`))
    }

    this.dataHandlers.set(reference, (payload) => {
      resetIdleTimer()
      const { offset, bytes } = readLogChunk(payload)
      if (bytes.length === 0) {
        // Empty body is the end-of-log marker.
        settle?.()
        return
      }
      if (streaming) {
        options.onChunk?.(offset, bytes)
      } else {
        pieces.push({ offset, bytes })
      }

      delivered += bytes.length
      // Math.max, not assignment: packets can arrive out of order, and a bar that
      // steps backwards is worse than one that pauses.
      end = Math.max(end, offset + bytes.length)

      const total = options.expectedSize ?? null
      options.onProgress?.({
        position: end,
        deliveredBytes: delivered,
        total,
        overrun: total !== null && end > total,
      })
    })

    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      if (options.signal?.aborted) throw new GspAbortedError()

      const { payload } = await this.sendWithRef(
        reference,
        encodeFetchLog(reference, logId),
        `FETCH_LOG ${logId}`,
        this.timeoutMs,
      )
      this.expect(readStatus(payload).status, [200], `FETCH_LOG ${logId}`)

      resetIdleTimer()
      await finished
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      options.signal?.removeEventListener('abort', onAbort)
      this.dataHandlers.delete(reference)
      this.refs.release(reference)
    }

    return streaming
      ? { data: new Uint8Array(0), gaps: [], deliveredBytes: delivered }
      : { ...assemble(pieces, end), deliveredBytes: delivered }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private async request(
    build: (reference: number) => Uint8Array,
    label: string,
    timeoutMs = this.timeoutMs,
  ): Promise<{ reference: number; payload: Uint8Array }> {
    const reference = this.refs.allocate()
    try {
      const { payload } = await this.sendWithRef(
        reference,
        build(reference),
        label,
        timeoutMs,
      )
      return { reference, payload }
    } finally {
      this.refs.release(reference)
    }
  }

  /** Wait for a free slot in the in-flight budget. */
  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.inFlight++
  }

  private release(): void {
    this.inFlight--
    this.waiting.shift()?.()
  }

  private async sendWithRef(
    reference: number,
    bytes: Uint8Array,
    label: string,
    timeoutMs: number,
  ): Promise<{ payload: Uint8Array }> {
    if (this.closed) throw new GspDisconnectedError('Client is stopped')
    await this.acquire()
    try {
      return await this.exchange(reference, bytes, label, timeoutMs)
    } finally {
      this.release()
    }
  }

  private async exchange(
    reference: number,
    bytes: Uint8Array,
    label: string,
    timeoutMs: number,
  ): Promise<{ payload: Uint8Array }> {

    const response = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reference)
        this.trace?.note(`${label} timed out after ${timeoutMs} ms`)
        reject(new GspTimeoutError(label, timeoutMs))
      }, timeoutMs)
      this.pending.set(reference, { label, resolve, reject, timer })
    })

    this.trace?.command(bytes)

    try {
      await this.transport.write(bytes)
    } catch (error) {
      const entry = this.pending.get(reference)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(reference)
      }
      throw error
    }

    return { payload: await response }
  }

  private handleNotification(bytes: Uint8Array): void {
    this.trace?.notification(bytes)

    let frame
    try {
      frame = parseFrame(bytes)
    } catch (error) {
      this.trace?.note(
        `Dropped undecodable notification: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    if (frame.kind === 'data') {
      const handler = this.dataHandlers.get(frame.reference)
      if (handler) {
        handler(frame.payload, frame.continuation)
      } else {
        this.trace?.note(
          `Data frame for unknown reference ${frame.reference}, dropped`,
        )
      }
      return
    }

    if (frame.kind === 'command-response') {
      const entry = this.pending.get(frame.reference)
      if (!entry) {
        // Most likely a response that arrived after its command timed out.
        this.trace?.note(
          `Response for unknown reference ${frame.reference}, dropped`,
        )
        return
      }
      clearTimeout(entry.timer)
      this.pending.delete(frame.reference)
      entry.resolve(frame.payload)
      return
    }

    this.trace?.note(
      `Unknown response code ${frame.responseCode} on reference ${frame.reference}, dropped`,
    )
  }

  private handleDisconnect(): void {
    this.trace?.note('Sensor disconnected')
    this.failAll(new GspDisconnectedError())
  }

  private failAll(error: Error): void {
    for (const [reference, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(reference)
      entry.reject(error)
    }
    this.dataHandlers.clear()
    this.refs.releaseAll()
  }

  private expect(status: number, allowed: number[], label: string): void {
    if (allowed.includes(status)) return
    // 429 is not an ordinary failure: it means the sensor is out of request slots
    // and will stay that way until rebooted, so it gets its own error.
    if (status === 429) throw new GspBusyError(label)
    throw new GspStatusError(label, status)
  }
}

/** Flatten offset-keyed pieces into one buffer and report any holes. */
function assemble(
  pieces: Array<{ offset: number; bytes: Uint8Array }>,
  end: number,
): Omit<FetchLogResult, 'deliveredBytes'> {
  const data = new Uint8Array(end)
  for (const piece of pieces) {
    data.set(piece.bytes, piece.offset)
  }

  const sorted = [...pieces].sort((a, b) => a.offset - b.offset)
  const gaps: Array<[number, number]> = []
  let covered = 0
  for (const piece of sorted) {
    if (piece.offset > covered) gaps.push([covered, piece.offset])
    covered = Math.max(covered, piece.offset + piece.bytes.length)
  }

  return { data, gaps }
}
