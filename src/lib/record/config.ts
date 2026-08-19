import {
  findMeasurement,
  measurementPath,
  type MeasurementSpec,
} from '@/lib/api/catalog'
import {
  RECOMMENDED_MAX_LOG_PATHS,
  TIME_DETAILED_PATH,
} from '@/lib/gsp/constants'

/** One chosen measurement, with its rate where the stream has one. */
export interface Selection {
  readonly measurementId: string
  readonly rate?: number
}

export interface ThroughputEstimate {
  /** Estimated bytes per second written to sensor memory. */
  readonly bytesPerSecond: number
  /** True when any selected stream has no rate in its path, so this is a guess. */
  readonly hasAssumedRates: boolean
}

export type WarningLevel = 'info' | 'warning'

export interface ConfigWarning {
  readonly level: WarningLevel
  readonly message: string
}

export interface RecordingPlan {
  /** Paths in the order they will be written, `/Time/Detailed` included. */
  readonly paths: string[]
  readonly throughput: ThroughputEstimate
  readonly warnings: ConfigWarning[]
  /** False when there is nothing to record. */
  readonly valid: boolean
}

/**
 * SBEM framing overhead: every chunk carries an id, a length and a timestamp,
 * and chunks hold a handful of samples. Ten percent is a round guess, stated as
 * such rather than presented as a measurement.
 */
const SBEM_OVERHEAD_FACTOR = 1.1

/** Resolve a selection to its spec and effective rate. */
function resolve(
  selection: Selection,
): { spec: MeasurementSpec; rate: number | undefined } | null {
  const spec = findMeasurement(selection.measurementId)
  if (!spec) return null
  if (spec.rates.length === 0) return { spec, rate: undefined }
  const rate = selection.rate ?? spec.defaultRate ?? spec.rates[0]!
  return { spec, rate }
}

export function estimateThroughput(
  selections: readonly Selection[],
): ThroughputEstimate {
  let bytesPerSecond = 0
  let hasAssumedRates = false

  for (const selection of selections) {
    const resolved = resolve(selection)
    if (!resolved) continue
    const { spec, rate } = resolved

    if (rate === undefined) {
      // No rate in the path: fall back to the catalog's nominal guess.
      hasAssumedRates = true
      bytesPerSecond += (spec.nominalRate ?? 1) * spec.bytesPerSample
    } else {
      bytesPerSecond += rate * spec.bytesPerSample
    }
  }

  return {
    bytesPerSecond: Math.round(bytesPerSecond * SBEM_OVERHEAD_FACTOR),
    hasAssumedRates,
  }
}

/**
 * Turn selections into the exact DataLogger configuration, with the warnings the
 * user should see before starting.
 */
export function buildRecordingPlan(
  selections: readonly Selection[],
): RecordingPlan {
  const paths: string[] = []
  const warnings: ConfigWarning[] = []
  const seen = new Set<string>()

  for (const selection of selections) {
    const resolved = resolve(selection)
    if (!resolved) {
      warnings.push({
        level: 'warning',
        message: `Unknown measurement "${selection.measurementId}", skipped.`,
      })
      continue
    }

    const { spec, rate } = resolved
    const path = measurementPath(spec, rate)
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)

    if (rate !== undefined && spec.warnAboveRate && rate > spec.warnAboveRate) {
      warnings.push({
        level: 'warning',
        message: `${spec.label} at ${rate} Hz is above the ${spec.warnAboveRate} Hz the upstream tool considers safe. Samples may be dropped when several streams are logged together.`,
      })
    }
  }

  // `/Time/Detailed` is what anchors sensor timestamps to wall-clock time, so it
  // is always logged. The client appends it too; doing it here keeps the preview
  // honest about what will actually be sent.
  if (paths.length > 0 && !paths.includes(TIME_DETAILED_PATH)) {
    paths.push(TIME_DETAILED_PATH)
  }

  const measurementCount = paths.filter(
    (path) => path !== TIME_DETAILED_PATH,
  ).length

  if (measurementCount > RECOMMENDED_MAX_LOG_PATHS) {
    warnings.push({
      level: 'warning',
      message: `${measurementCount} measurements selected. The upstream tool caps configurations at ${RECOMMENDED_MAX_LOG_PATHS}; whether that is a firmware limit is unverified, so this may simply fail.`,
    })
  }

  const throughput = estimateThroughput(selections)

  if (throughput.hasAssumedRates) {
    warnings.push({
      level: 'info',
      message:
        'Some streams have no sample rate in their path, so the sensor decides the cadence. The data-rate figure assumes a nominal rate for those.',
    })
  }

  return {
    paths,
    throughput,
    warnings,
    valid: measurementCount > 0,
  }
}

export function formatDataRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '0 B/s'
  if (bytesPerSecond < 1024) return `${bytesPerSecond} B/s`
  return `${(bytesPerSecond / 1024).toFixed(1)} kB/s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatDuration(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => value.toString().padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}
