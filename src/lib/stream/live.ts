import { decodePayload, type DecodedValue } from '@/lib/gsp/layouts'
import { createStore, type Store } from '@/lib/store'
import { channelUnit, requestedRateHz, type ChannelUnit } from './units'

/**
 * Rolling buffers for a live subscription.
 *
 * Two things this has to get right that a static decode does not:
 *
 *  - **Bounded memory.** ECG at 512 Hz is half a million samples in a quarter of
 *    an hour, so buffers are ring-trimmed to a fixed sample budget.
 *  - **Honest loss reporting.** GSP notifications are unacknowledged, so packets
 *    go missing. Because the requested rate is in the path and every packet is
 *    timestamped, the number of missing samples is computable rather than
 *    guessable: compare the timestamp gap against the interval the rate implies.
 */

export interface LiveChannel {
  /** Decoded field name: `Samples`, `ArrayAcc`, `rrData`, … */
  readonly field: string
  /** Display name, with the `Array` prefix dropped. */
  readonly label: string
  readonly columns: readonly string[]
  readonly unit: ChannelUnit
  /** Sensor time per sample, milliseconds. */
  readonly time: number[]
  /** One array per column, scaled into `unit`. */
  readonly values: number[][]
}

export interface LiveStreamState {
  readonly path: string
  readonly channels: readonly LiveChannel[]
  readonly packets: number
  readonly samples: number
  /** Samples the sensor sent that never arrived, inferred from timestamp gaps. */
  readonly droppedSamples: number
  readonly bytes: number
  readonly requestedHz: number | null
  /** Rate measured from packet timestamps. */
  readonly measuredHz: number | null
  readonly firstTimestamp: number | null
  readonly lastTimestamp: number | null
  /** Set when a payload arrived that no layout could decode. */
  readonly undecodable: number
}

const DEFAULT_MAX_SAMPLES = 20_000

export class LiveStream {
  private readonly store: Store<LiveStreamState>
  private readonly maxSamples: number
  private readonly channels = new Map<string, LiveChannel>()
  private lastPacketTimestamp: number | null = null
  private packets = 0
  private samples = 0
  private dropped = 0
  private bytes = 0
  private undecodable = 0
  private first: number | null = null
  private last: number | null = null
  /**
   * Time of the newest *sample*, not the newest packet.
   *
   * Measuring the span between packet timestamps ignores the final packet's own
   * duration, which overstates the rate by a whole packet's worth - 205 Hz for a
   * 200 Hz ECG stream. The last sample's time is the honest end of the span.
   */
  private lastSampleTime: number | null = null

  constructor(
    readonly path: string,
    options: { maxSamples?: number } = {},
  ) {
    this.maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES
    this.store = createStore<LiveStreamState>({
      path,
      channels: [],
      packets: 0,
      samples: 0,
      droppedSamples: 0,
      bytes: 0,
      requestedHz: requestedRateHz(path),
      measuredHz: null,
      firstTimestamp: null,
      lastTimestamp: null,
      undecodable: 0,
    })
  }

  getSnapshot(): LiveStreamState {
    return this.store.get()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Feed one subscription payload. */
  push(payload: Uint8Array): void {
    this.bytes += payload.length
    const decoded = decodePayload(this.path, payload)
    if (!decoded.best) {
      this.undecodable++
      this.publish()
      return
    }

    const value = decoded.best.value
    const timestamp =
      typeof value.Timestamp === 'number' ? value.Timestamp : this.last ?? 0

    // Split the decoded object into per-field sample rows.
    const fields = Object.entries(value).filter(
      ([name]) => name !== 'Timestamp',
    )
    let sampleCount = 1
    for (const [, field] of fields) {
      if (Array.isArray(field)) sampleCount = Math.max(sampleCount, field.length)
    }

    const requested = requestedRateHz(this.path)
    const intervalMs = requested ? 1000 / requested : null

    // Loss: how many samples should have arrived between the previous packet and
    // this one, minus the ones this packet accounts for.
    if (intervalMs !== null && this.lastPacketTimestamp !== null) {
      const expected = Math.round((timestamp - this.lastPacketTimestamp) / intervalMs)
      if (expected > sampleCount) this.dropped += expected - sampleCount
    }
    this.lastPacketTimestamp = timestamp

    for (const [name, field] of fields) {
      this.appendField(name, field, timestamp, intervalMs ?? 0, sampleCount)
    }

    this.packets++
    this.samples += sampleCount
    if (this.first === null) this.first = timestamp
    this.last = timestamp
    const step = intervalMs ?? 0
    this.lastSampleTime = timestamp + Math.max(0, sampleCount - 1) * step
    this.publish()
  }

  private appendField(
    name: string,
    field: DecodedValue,
    timestamp: number,
    intervalMs: number,
    sampleCount: number,
  ): void {
    const rows: number[][] = []
    let columns: string[] = ['value']

    if (Array.isArray(field)) {
      const first = field[0]
      if (typeof first === 'object' && first !== null) {
        columns = Object.keys(first as Record<string, number>)
        for (const item of field as Array<Record<string, number>>) {
          rows.push(columns.map((column) => Number(item[column])))
        }
      } else {
        for (const item of field as number[]) rows.push([Number(item)])
      }
    } else if (typeof field === 'number' || typeof field === 'boolean') {
      rows.push([Number(field)])
    } else {
      return
    }

    let channel = this.channels.get(name)
    if (!channel) {
      channel = {
        field: name,
        label: name.startsWith('Array') ? name.slice(5) : name,
        columns,
        unit: channelUnit(this.path, name),
        time: [],
        values: columns.map(() => []),
      }
      this.channels.set(name, channel)
    }

    // Spread the packet's samples across its interval. A packet of 16 ECG samples
    // carries one timestamp; the rest are interpolated, same as for a log.
    const step = intervalMs > 0 ? intervalMs : 0
    const offset = sampleCount > 1 ? step : 0
    rows.forEach((row, index) => {
      channel!.time.push(timestamp + index * offset)
      row.forEach((raw, column) => {
        channel!.values[column]?.push(raw * channel!.unit.scale)
      })
    })

    // Trim from the front once the budget is exceeded.
    const excess = channel.time.length - this.maxSamples
    if (excess > 0) {
      channel.time.splice(0, excess)
      for (const column of channel.values) column.splice(0, excess)
    }
  }

  /** Discard everything collected so far, keeping the subscription open. */
  reset(): void {
    this.channels.clear()
    this.packets = 0
    this.samples = 0
    this.dropped = 0
    this.bytes = 0
    this.undecodable = 0
    this.first = null
    this.last = null
    this.lastSampleTime = null
    this.lastPacketTimestamp = null
    this.publish()
  }

  private publish(): void {
    const end = this.lastSampleTime ?? this.last
    const span =
      this.first !== null && end !== null && end > this.first
        ? end - this.first
        : null
    // Measured over the packet timestamps rather than wall clock, so BLE jitter
    // and render lag do not distort it.
    const measuredHz =
      span !== null && this.samples > 1 ? ((this.samples - 1) / span) * 1000 : null

    this.store.set({
      path: this.path,
      // A new array each publish, so `useSyncExternalStore` sees the change.
      channels: [...this.channels.values()],
      packets: this.packets,
      samples: this.samples,
      droppedSamples: this.dropped,
      bytes: this.bytes,
      requestedHz: requestedRateHz(this.path),
      measuredHz,
      firstTimestamp: this.first,
      lastTimestamp: this.last,
      undecodable: this.undecodable,
    })
  }
}
