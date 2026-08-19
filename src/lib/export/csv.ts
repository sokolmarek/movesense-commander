import type { SampleSeries, TimeAnchor } from '@/lib/sbem/samples'
import { toUtcMillis } from '@/lib/sbem/samples'

/**
 * CSV export, one file per series.
 *
 * A series is already one channel with one row per sample, so IMU9 comes out as
 * three files (Acc, Gyro, Magn) rather than one wide file - matching what the
 * upstream `ms_json2csv.py` produces, and what analysis tools expect.
 */

export interface CsvOptions {
  /** Add a UTC column, when the log carried a `/Time/Detailed` anchor. */
  readonly includeUtc?: boolean
  readonly anchor?: TimeAnchor | null
}

export function seriesToCsv(series: SampleSeries, options: CsvOptions = {}): string {
  const anchor = options.anchor ?? null
  const withUtc = options.includeUtc !== false && anchor !== null

  const header = ['Timestamp_ms', ...series.columns]
  if (withUtc) header.push('UTC_ISO')

  const lines: string[] = [header.join(',')]

  for (let i = 0; i < series.timestamps.length; i++) {
    const timestamp = series.timestamps[i]!
    const row: string[] = [formatNumber(timestamp)]
    for (const column of series.values) row.push(formatNumber(column[i]))
    if (withUtc) {
      const utc = toUtcMillis(anchor, timestamp)
      row.push(utc === null ? '' : new Date(utc).toISOString())
    }
    lines.push(row.join(','))
  }

  return lines.join('\n') + '\n'
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return ''
  return Number.isInteger(value) ? String(value) : value.toFixed(6)
}

/** A filename that is safe on every platform and says what it holds. */
export function csvFileName(
  series: SampleSeries,
  context: { serial: string; logId: number },
): string {
  const channel = series.channel ? `_${series.channel}` : ''
  return `Movesense_log_${context.logId}_${context.serial}_${series.stream}${channel}.csv`
    .replace(/[^\w.-]+/g, '_')
}
