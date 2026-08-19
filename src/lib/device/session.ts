import {
  GspClient,
  type FetchLogProgress,
  type Subscription,
} from '@/lib/gsp/client'
import { DATA_LOGGER_STATE_LABELS, DataLoggerState } from '@/lib/gsp/constants'
import type { DeviceInfo, LogbookEntry } from '@/lib/gsp/decoders'
import { TraceRecorder } from '@/lib/gsp/trace'
import type { GspTransport } from '@/lib/gsp/transport'
import { createStore, type Store } from '@/lib/store'
import { logKey, type StoredLog } from '@/lib/storage/db'
import { logStore } from '@/lib/storage/log-store'

/** How often the logger state is re-read while recording. */
const STATE_POLL_INTERVAL_MS = 5000

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

export interface DeviceSnapshot {
  readonly id: string
  readonly name: string | null
  readonly status: ConnectionStatus
  readonly error: string | null
  readonly info: DeviceInfo | null
  readonly battery: number | null
  readonly dataLoggerState: number | null
  readonly dataLoggerStateLabel: string | null
  /** When the sensor clock was last set from this browser. */
  readonly timeSyncedAt: number | null
  /** True while a command is in flight, so the UI can disable actions. */
  readonly busy: boolean
  /** Paths of the configuration this app last wrote, if any. */
  readonly configuredPaths: readonly string[] | null
  /**
   * When recording started, as observed from this app. Null while not recording,
   * and also null when we connected to a sensor that was already logging - we
   * cannot know when that began.
   */
  readonly recordingStartedAt: number | null
}

export interface DeviceSessionOptions {
  /** Set the sensor clock on connect. Recordings need it to have a UTC anchor. */
  syncTimeOnConnect?: boolean
}

/**
 * One sensor: its transport, its client, its observable state and its trace.
 *
 * The session owns the lifecycle so the UI never touches the client directly
 * for connection concerns - it reads a snapshot and calls intents.
 */
export class DeviceSession {
  readonly trace = new TraceRecorder()
  readonly client: GspClient

  private readonly store: Store<DeviceSnapshot>
  private readonly syncTimeOnConnect: boolean
  private offDisconnect: (() => void) | null = null
  private statePoll: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly transport: GspTransport,
    options: DeviceSessionOptions = {},
  ) {
    this.syncTimeOnConnect = options.syncTimeOnConnect ?? true
    this.client = new GspClient(transport, { trace: this.trace })
    this.store = createStore<DeviceSnapshot>({
      id: transport.id,
      name: transport.name,
      status: 'idle',
      error: null,
      info: null,
      battery: null,
      dataLoggerState: null,
      dataLoggerStateLabel: null,
      timeSyncedAt: null,
      busy: false,
      configuredPaths: null,
      recordingStartedAt: null,
    })
  }

  get id(): string {
    return this.transport.id
  }

  getSnapshot(): DeviceSnapshot {
    return this.store.get()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  async connect(): Promise<void> {
    this.patch({ status: 'connecting', error: null })
    this.trace.note(`Connecting to ${this.transport.name ?? this.transport.id}`)

    try {
      await this.transport.connect()
      this.client.start()

      this.offDisconnect = this.transport.onDisconnect(() => {
        this.stopStatePolling()
        this.patch({
          status: 'disconnected',
          busy: false,
          battery: null,
          dataLoggerState: null,
          dataLoggerStateLabel: null,
        })
      })

      // Identify first: a read-only command confirms the protocol works before
      // we write anything to the sensor.
      const info = await this.client.hello()
      this.patch({ status: 'connected', info, name: this.transport.name })
      this.trace.note(
        `Identified ${info.productName} ${info.serialNumber}, app ${info.appName} ${info.appVersion}`,
      )

      if (this.syncTimeOnConnect) {
        await this.syncTime()
      }
      await this.refresh()
    } catch (error) {
      this.patch({ status: 'error', error: describeError(error) })
      this.trace.note(`Connect failed: ${describeError(error)}`)
      // Leave no half-open link behind.
      try {
        await this.transport.disconnect()
      } catch {
        // Nothing useful to do if teardown also fails.
      }
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.trace.note('Disconnecting')
    this.stopStatePolling()
    this.offDisconnect?.()
    this.offDisconnect = null
    this.client.stop()
    await this.transport.disconnect()
    this.patch({
      status: 'disconnected',
      busy: false,
      battery: null,
      dataLoggerState: null,
      dataLoggerStateLabel: null,
    })
  }

  /** Re-read the values that change on their own: battery and logger state. */
  async refresh(): Promise<void> {
    await this.run(() => this.readVolatileState())
  }

  private async readVolatileState(): Promise<void> {
    const battery = await this.client.getBatteryLevel()
    const dataLoggerState = await this.client.getDataLoggerState()
    this.patch({
      battery,
      dataLoggerState,
      dataLoggerStateLabel:
        DATA_LOGGER_STATE_LABELS[dataLoggerState] ?? `Unknown (${dataLoggerState})`,
    })
    this.syncStatePolling()
  }

  /**
   * Poll the logger state while recording, so the UI notices a sensor that
   * stopped on its own (memory full, for instance).
   *
   * Deliberately does not set `busy`: a background poll must not disable the
   * buttons under the user's cursor.
   */
  private syncStatePolling(): void {
    const { status, dataLoggerState } = this.store.get()
    const shouldPoll =
      status === 'connected' && dataLoggerState === DataLoggerState.Logging

    if (shouldPoll && this.statePoll === null) {
      this.statePoll = setInterval(() => {
        void this.readVolatileState().catch(() => {
          // A failed poll is not worth surfacing; the disconnect handler covers
          // the case that actually matters.
        })
      }, STATE_POLL_INTERVAL_MS)
    } else if (!shouldPoll && this.statePoll !== null) {
      clearInterval(this.statePoll)
      this.statePoll = null
    }
  }

  private stopStatePolling(): void {
    if (this.statePoll !== null) {
      clearInterval(this.statePoll)
      this.statePoll = null
    }
  }

  /** Set the sensor clock to this machine's time. */
  async syncTime(): Promise<void> {
    await this.run(async () => {
      await this.client.putUtcTime()
      this.patch({ timeSyncedAt: Date.now() })
      this.trace.note('Sensor clock set from this machine')
    })
  }

  /** Reboot into the application. Drops the link, by design. */
  async reboot(): Promise<void> {
    await this.run(async () => {
      await this.client.reboot()
      this.trace.note('Reboot accepted; the sensor will drop the connection')
    })
  }

  /** Write the DataLogger configuration. Replaces whatever was there. */
  async configure(paths: readonly string[]): Promise<void> {
    await this.run(async () => {
      await this.client.putDataLoggerConfig(paths)
      // Record what we sent, not what we selected: the client appends
      // /Time/Detailed, so these can differ.
      this.patch({ configuredPaths: [...paths] })
      this.trace.note(`DataLogger configured: ${paths.join(', ')}`)
    })
  }

  async startRecording(): Promise<void> {
    await this.run(async () => {
      await this.client.startLogging()
      this.patch({ recordingStartedAt: Date.now() })
    })
    await this.refresh()
  }

  /**
   * Stop recording.
   *
   * Stopping alone flushes the log. The reboot afterwards is what rolls the
   * sensor over to a fresh log id, which is what the upstream tool does and what
   * makes a subsequent recording land in its own log. It drops the BLE link by
   * design.
   */
  async stopRecording({ rollOver = true }: { rollOver?: boolean } = {}): Promise<void> {
    await this.run(async () => {
      await this.client.stopLogging()
      this.patch({ recordingStartedAt: null })
    })

    if (rollOver) {
      await this.reboot()
    } else {
      await this.refresh()
    }
  }

  // -------------------------------------------------------------------------
  // Logbook
  // -------------------------------------------------------------------------

  /**
   * The logbook listing.
   *
   * `truncated` means the sensor reported more logs than fit in one
   * notification, so ids beyond this list exist and can only be found by
   * `downloadLog`-ing them until one 404s.
   */
  async listLogs(): Promise<{
    entries: LogbookEntry[]
    declaredCount: number
    truncated: boolean
  }> {
    let result: {
      entries: LogbookEntry[]
      declaredCount: number
      truncated: boolean
    } = { entries: [], declaredCount: 0, truncated: false }

    await this.run(async () => {
      result = await this.client.listLogbookEntries()
    })

    return result
  }

  /**
   * Download one log and keep it.
   *
   * GSP has no way to cancel a fetch once the sensor starts sending, so probing
   * whether a log id exists costs a full download. That is why we store what we
   * fetch instead of discarding it the way the upstream tool does when probing.
   */
  async downloadLog(
    logId: number,
    options: {
      expectedSize?: number
      lastModified?: number | null
      onProgress?: (progress: FetchLogProgress) => void
      signal?: AbortSignal
    } = {},
  ): Promise<StoredLog> {
    const serial = this.store.get().info?.serialNumber ?? this.transport.id
    let stored: StoredLog | null = null

    await this.run(async () => {
      const result = await this.client.fetchLog(logId, {
        ...(options.expectedSize === undefined
          ? {}
          : { expectedSize: options.expectedSize }),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })

      if (result.deliveredBytes > result.data.length) {
        // The sensor resent some ranges. Harmless for the file, but worth saying,
        // because it is why delivered bytes can exceed the log size.
        this.trace.note(
          `Log ${logId}: ${result.deliveredBytes} bytes delivered for a ${result.data.length}-byte file, so some ranges arrived more than once.`,
        )
      }

      if (result.gaps.length > 0) {
        const missing = result.gaps.reduce(
          (sum, [start, end]) => sum + (end - start),
          0,
        )
        this.trace.note(
          `Log ${logId} has ${result.gaps.length} gap(s), ${missing} bytes missing. Notifications were lost; re-download to fill them.`,
        )
      }

      const record: StoredLog = {
        key: logKey(serial, logId),
        deviceId: this.transport.id,
        serial,
        logId,
        // Copy into a standalone buffer: the fetch result may be a view.
        bytes: result.data.slice().buffer,
        size: result.data.length,
        downloadedAt: Date.now(),
        gaps: result.gaps,
        lastModified: options.lastModified ?? null,
      }

      await logStore.save(record)
      stored = record
    })

    if (!stored) throw new Error(`Download of log ${logId} produced nothing`)
    return stored
  }

  /**
   * Subscribe to a resource.
   *
   * Deliberately not wrapped in `run()`: a subscription lives until closed, and
   * marking the device busy for its whole lifetime would disable every button.
   */
  async subscribeResource(
    path: string,
    onData: (payload: Uint8Array) => void,
  ): Promise<Subscription> {
    const subscription = await this.client.subscribe(path, onData)
    this.trace.note(`Subscribed to ${path} on reference ${subscription.reference}`)
    return subscription
  }

  /**
   * Download a log straight into a writable file stream.
   *
   * Nothing is buffered and nothing is stored in the browser, which is the right
   * shape for a log too large to want in the heap. The caller supplies the
   * destination, so the File System Access picker stays in the UI layer.
   */
  async downloadLogToSink(
    logId: number,
    sink: { write(chunk: Uint8Array, offset: number): Promise<void> | void },
    options: {
      expectedSize?: number
      onProgress?: (progress: FetchLogProgress) => void
      signal?: AbortSignal
    } = {},
  ): Promise<{ bytes: number; gaps: Array<[number, number]> }> {
    let written = 0
    let covered = 0
    const gaps: Array<[number, number]> = []
    const pending: Array<Promise<void> | void> = []

    await this.run(async () => {
      const result = await this.client.fetchLog(logId, {
        ...(options.expectedSize === undefined
          ? {}
          : { expectedSize: options.expectedSize }),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onChunk: (offset, bytes) => {
          // Sequential offsets are the normal case, so a hole is worth recording
          // rather than silently writing past it.
          if (offset > covered) gaps.push([covered, offset])
          covered = Math.max(covered, offset + bytes.length)
          written += bytes.length
          pending.push(sink.write(bytes, offset))
        },
      })
      await Promise.all(pending)
      this.trace.note(
        `Log ${logId} streamed to disk: ${written} bytes, ${result.gaps.length + gaps.length} gap(s)`,
      )
    })

    return { bytes: written, gaps }
  }

  /** Erase every recording on the sensor. Irreversible. */
  async eraseMemory(): Promise<void> {
    await this.run(async () => {
      await this.client.clearLogbook()
      this.trace.note('Logbook erased')
    })
  }

  /**
   * Run an intent, tracking `busy` and surfacing failures in the snapshot
   * instead of leaving them as unhandled rejections.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    this.patch({ busy: true, error: null })
    try {
      await action()
    } catch (error) {
      this.patch({ error: describeError(error) })
      throw error
    } finally {
      this.patch({ busy: false })
    }
  }

  private patch(changes: Partial<DeviceSnapshot>): void {
    this.store.set((previous) => ({ ...previous, ...changes }))
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
