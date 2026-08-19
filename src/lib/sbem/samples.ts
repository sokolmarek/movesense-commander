import type { SbemDocument, SbemObject, SbemRecord, SbemRecordValue } from './decode'

/**
 * Turn decoded records into per-channel sample series with a time per sample.
 *
 * Every exporter and chart builds on this. The work it does that decoding does
 * not: SBEM timestamps are **per chunk, not per sample**, so a chunk of four
 * IMU9 samples carries one timestamp and the rest have to be interpolated from
 * the gap to the next chunk. That is also how the upstream `ms_json2csv.py`
 * does it.
 */

export interface SampleSeries {
  /** Unique key, e.g. `MeasIMU9.Acc` or `MeasECG`. */
  readonly key: string
  readonly stream: string
  /** Sub-channel within the stream, e.g. `Acc` for IMU9. Null when there is one. */
  readonly channel: string | null
  /** Column names: `['x','y','z']`, `['value']`, `['average','rrInterval']`. */
  readonly columns: readonly string[]
  /** Sensor time per sample, in milliseconds. */
  readonly timestamps: number[]
  /** One array per column, all the same length as `timestamps`. */
  readonly values: number[][]
  readonly estimatedRateHz: number | null
  /** Samples inserted to bridge a gap, rather than measured. */
  readonly filledSamples: number
  /**
   * Factor already applied to `values`, from the descriptor's `<MOD>`, or null
   * when the stored numbers are physical as they stand.
   *
   * For a logged ECG stream this is 0.001: the sensor stores microvolts and says
   * so in its own descriptor, so the values here are millivolts.
   */
  readonly scale: number | null
}

/**
 * The `/Time/Detailed` record that ties sensor time to wall clock.
 *
 * **`relativeTime` is in milliseconds** - the same unit as measurement
 * timestamps, so the two can be subtracted directly.
 *
 * The record also carries a `tickRate`, which reads 1024 on hardware. That
 * invites the conclusion that `relativeTime` counts RTC ticks. It does not: over
 * 21.4 seconds of `utcTime`, `relativeTime` advanced by 21432, which is exactly
 * 1000 per second. `tickRate` describes the underlying clock, not the unit of
 * this field, and dividing by it would introduce a 2.4% error.
 */
export interface TimeAnchor {
  /** UTC microseconds since the epoch. */
  readonly utcMicros: number
  /** Sensor-relative time in milliseconds. */
  readonly relativeMs: number
  /** The record's `tickRate`, kept for reference. Never used for conversion. */
  readonly tickRate: number | null
}

export interface SampleSet {
  readonly series: SampleSeries[]
  readonly anchor: TimeAnchor | null
}

export interface ExtractOptions {
  /**
   * Bridge gaps in a stream with filler samples so the output keeps a constant
   * rate. The upstream tool does this for ECG with -1.5 mV, because EDF and most
   * analysis tools assume a fixed sample rate.
   */
  readonly fillGaps?: boolean
  /** Value written into filled samples. */
  readonly fillValue?: number
  /** A gap larger than this multiple of the sample interval counts as missing. */
  readonly gapTolerance?: number
}

const DEFAULT_FILL_VALUE = -1.5
const DEFAULT_GAP_TOLERANCE = 1.5

/** Streams that are metadata rather than measurements. */
const TIME_STREAMS = new Set(['TimeDetailed', 'Time'])

export function extractSamples(
  document: SbemDocument,
  options: ExtractOptions = {},
): SampleSet {
  const anchor = findTimeAnchor(document.records)
  const byStream = new Map<string, SbemRecord[]>()

  for (const record of document.records) {
    if (TIME_STREAMS.has(record.stream)) continue
    const list = byStream.get(record.stream)
    if (list) list.push(record)
    else byStream.set(record.stream, [record])
  }

  const series: SampleSeries[] = []
  for (const [stream, records] of byStream) {
    if (stream === 'MeasHR') {
      const hr = extractHeartRate(records)
      if (hr) series.push(hr)
      continue
    }
    series.push(...extractTimestamped(stream, records, options, document.scales))
  }

  return { series, anchor }
}

/** `/Time/Detailed` is what ties sensor time to wall clock. */
function findTimeAnchor(records: readonly SbemRecord[]): TimeAnchor | null {
  for (const record of records) {
    if (!TIME_STREAMS.has(record.stream)) continue
    const body = record.value[record.stream]
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue

    const utc = numberAt(body, ['utcTime', 'UtcTime', 'utc'])
    const relative = numberAt(body, ['relativeTime', 'RelativeTime', 'Timestamp'])
    const tickRate = numberAt(body, ['tickRate', 'TickRate'])
    if (utc !== null && relative !== null) {
      return {
        utcMicros: utc,
        relativeMs: relative,
        tickRate: tickRate !== null && tickRate > 0 ? tickRate : null,
      }
    }
  }
  return null
}

function numberAt(object: SbemObject, keys: string[]): number | null {
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'number') return value
  }
  return null
}

/**
 * Convert a sensor timestamp to UTC milliseconds, if the log has an anchor.
 *
 * Both are already milliseconds. See the note on `TimeAnchor` for why `tickRate`
 * must not be applied here.
 */
export function toUtcMillis(anchor: TimeAnchor | null, sensorMs: number): number | null {
  if (!anchor) return null
  return anchor.utcMicros / 1000 + (sensorMs - anchor.relativeMs)
}

interface ChannelShape {
  readonly channel: string | null
  /** Field name as stored, before the `Array` prefix is dropped. */
  readonly field: string
  readonly columns: string[]
  /** Samples in this record, in column order. */
  readonly rows: number[][]
}

/**
 * Pull the sample-bearing fields out of one record.
 *
 * Three shapes occur: an array of objects (`ArrayAcc: [{x,y,z}, ...]`), an array
 * of scalars (`Samples: [1, 2, 3]`), and a lone scalar (`Measurement: 296.5`).
 */
function shapesOf(record: SbemRecord): ChannelShape[] {
  const body = record.value[record.stream]
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return typeof body === 'number'
      ? [{ channel: null, field: 'value', columns: ['value'], rows: [[body]] }]
      : []
  }

  const shapes: ChannelShape[] = []

  for (const [name, field] of Object.entries(body as SbemObject)) {
    if (name === 'Timestamp' || name === 'timestamp') continue

    // `ArrayAcc` -> channel `Acc`; anything else keeps its own name.
    const channel = name.startsWith('Array') ? name.slice(5) : name

    if (Array.isArray(field)) {
      const first = field[0]
      if (typeof first === 'object' && first !== null) {
        const columns = Object.keys(first as SbemObject)
        const rows = (field as SbemObject[]).map((entry) =>
          columns.map((column) => asNumber(entry[column])),
        )
        shapes.push({ channel, field: name, columns, rows })
      } else {
        const rows = (field as SbemRecordValue[]).map((value) => [asNumber(value)])
        shapes.push({ channel, field: name, columns: ['value'], rows })
      }
      continue
    }

    if (typeof field === 'number' || typeof field === 'boolean') {
      shapes.push({ channel, field: name, columns: ['value'], rows: [[asNumber(field)]] })
    }
  }

  return shapes
}

function asNumber(value: SbemRecordValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return Number.NaN
}

function timestampOf(record: SbemRecord): number | null {
  const body = record.value[record.stream]
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  return numberAt(body as SbemObject, ['Timestamp', 'timestamp'])
}

/**
 * Establish one sample interval for the whole stream, from the median of the
 * per-chunk estimates.
 *
 * Estimating the interval chunk by chunk - dividing the distance to the next
 * chunk by this chunk's sample count - breaks precisely when a chunk is missing:
 * the inflated gap becomes an inflated interval, and the gap then looks normal.
 * The median is immune to that, and to a gap at the very start, which is where
 * the upstream tool's "take the first two chunks" approach would go wrong.
 *
 * A DataLogger configuration fixes the rate for the whole recording, so one
 * interval for the stream is the right model.
 */
function estimateIntervalMs(records: readonly SbemRecord[]): number | null {
  const candidates: number[] = []

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    const timestamp = timestampOf(record)
    if (timestamp === null) continue

    const next = nextTimestampAfter(records, index)
    if (next === null || next <= timestamp) continue

    const shapes = shapesOf(record)
    const sampleCount = Math.max(...shapes.map((shape) => shape.rows.length), 1)
    candidates.push((next - timestamp) / sampleCount)
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a - b)
  const middle = Math.floor(candidates.length / 2)
  return candidates.length % 2 === 0
    ? (candidates[middle - 1]! + candidates[middle]!) / 2
    : candidates[middle]!
}

function extractTimestamped(
  stream: string,
  records: readonly SbemRecord[],
  options: ExtractOptions,
  scales: Record<string, number> = {},
): SampleSeries[] {
  const intervalMs = estimateIntervalMs(records)

  // Group records' channels together; a chunk may carry Acc, Gyro and Magn at
  // once, and each becomes its own series.
  const builders = new Map<
    string,
    {
      channel: string | null
      columns: string[]
      timestamps: number[]
      values: number[][]
      filled: number
      scale: number | null
    }
  >()

  for (const record of records) {
    const timestamp = timestampOf(record)
    if (timestamp === null) continue

    const shapes = shapesOf(record)
    if (shapes.length === 0) continue

    for (const shape of shapes) {
      const key = shape.channel ?? 'value'
      let builder = builders.get(key)
      if (!builder) {
        builder = {
          channel: shape.channel,
          columns: shape.columns,
          timestamps: [],
          values: shape.columns.map(() => []),
          filled: 0,
          // The descriptor's own decode factor, keyed by the stored field name.
          scale: scales[`${stream}.${shape.field}`] ?? null,
        }
        builders.set(key, builder)
      }

      const step = intervalMs ?? 0

      // Bridge a gap before this chunk, so the series keeps a constant rate.
      if (options.fillGaps && builder.timestamps.length > 0 && step > 0) {
        builder.filled += fillGap(builder, timestamp, step, options)
      }

      const factor = builder.scale
      shape.rows.forEach((row, sampleIndex) => {
        builder!.timestamps.push(timestamp + sampleIndex * step)
        row.forEach((value, column) =>
          builder!.values[column]!.push(factor === null ? value : value * factor),
        )
      })
    }
  }

  return [...builders.values()].map((builder) => ({
    key: builder.channel ? `${stream}.${builder.channel}` : stream,
    stream,
    channel: builder.channel,
    columns: builder.columns,
    timestamps: builder.timestamps,
    values: builder.values,
    estimatedRateHz: intervalMs && intervalMs > 0 ? 1000 / intervalMs : null,
    filledSamples: builder.filled,
    scale: builder.scale,
  }))
}

function nextTimestampAfter(
  records: readonly SbemRecord[],
  index: number,
): number | null {
  for (let i = index + 1; i < records.length; i++) {
    const timestamp = timestampOf(records[i]!)
    if (timestamp !== null) return timestamp
  }
  return null
}

function fillGap(
  builder: {
    columns: string[]
    timestamps: number[]
    values: number[][]
  },
  nextTimestamp: number,
  step: number,
  options: ExtractOptions,
): number {
  const tolerance = options.gapTolerance ?? DEFAULT_GAP_TOLERANCE
  const fillValue = options.fillValue ?? DEFAULT_FILL_VALUE
  const lastTimestamp = builder.timestamps[builder.timestamps.length - 1]!
  const gap = nextTimestamp - (lastTimestamp + step)

  if (gap <= step * (tolerance - 1)) return 0

  const missing = Math.round(gap / step)
  for (let i = 1; i <= missing; i++) {
    builder.timestamps.push(lastTimestamp + step * i)
    for (const column of builder.values) column.push(fillValue)
  }
  return missing
}

/**
 * Heart rate has no sample rate: each record is an average plus a list of RR
 * intervals, and the time base is the running sum of those intervals. Same
 * treatment as the upstream tool.
 */
function extractHeartRate(records: readonly SbemRecord[]): SampleSeries | null {
  const timestamps: number[] = []
  const averages: number[] = []
  const intervals: number[] = []
  let clock = 0

  for (const record of records) {
    const body = record.value.MeasHR
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue

    const average = numberAt(body as SbemObject, ['average', 'Average']) ?? Number.NaN
    const rrField = (body as SbemObject).rrData ?? (body as SbemObject).RrData
    const rrList =
      rrField === undefined
        ? []
        : Array.isArray(rrField)
          ? (rrField as SbemRecordValue[]).map(asNumber)
          : [asNumber(rrField)]

    for (const rr of rrList) {
      timestamps.push(clock)
      averages.push(average)
      intervals.push(rr)
      clock += rr
    }
  }

  if (timestamps.length === 0) return null

  return {
    key: 'MeasHR',
    stream: 'MeasHR',
    channel: null,
    columns: ['average', 'rrInterval'],
    timestamps,
    values: [averages, intervals],
    estimatedRateHz: null,
    filledSamples: 0,
    scale: null,
  }
}
