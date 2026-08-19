import type { SampleSeries } from '@/lib/sbem/samples'

/**
 * EDF+ writer (continuous, `EDF+C`).
 *
 * EDF stores samples as 16-bit integers in fixed-duration data records, with an
 * integer number of samples per signal per record. That shapes everything here:
 * a series needs a known rate, the rate is rounded to an integer, and the tail
 * that does not fill a whole record is dropped.
 *
 * Physical values are recovered by the reader as
 *   physical = (digital - digitalMin) * (physMax - physMin) / (digitalMax - digitalMin) + physMin
 * so the physical range has to bracket the real data or it clips.
 */

const DIGITAL_MIN = -32768
const DIGITAL_MAX = 32767
const HEADER_BLOCK = 256
const ANNOTATION_LABEL = 'EDF Annotations'
/** Bytes for the annotation TAL in each record; 2 bytes per "sample". */
const ANNOTATION_SAMPLES = 16

export interface EdfSignal {
  readonly label: string
  readonly dimension: string
  readonly samplesPerRecord: number
  readonly physicalMin: number
  readonly physicalMax: number
  readonly samples: number[]
}

/**
 * EDF+ constrains both identification fields to a subfield layout, and readers
 * reject the file outright if they are malformed - pyedflib fails with
 * "EDF+ Recordingfield" on a dotted date. So these are taken apart rather than
 * as free text.
 */
export interface EdfPatient {
  readonly code?: string
  readonly sex?: 'M' | 'F' | 'X'
  readonly birthdate?: Date | null
  readonly name?: string
}

export interface EdfOptions {
  readonly patient?: EdfPatient
  /** Recording-field subfields; anything omitted becomes `X`. */
  readonly adminCode?: string
  readonly technician?: string
  readonly equipment?: string
  readonly startTime?: Date
  /** Seconds per data record. One second suits every rate we produce. */
  readonly recordDuration?: number
}

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const

/** EDF+ subfields cannot contain spaces; underscores are the convention. */
function subfield(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  return trimmed.length === 0 ? 'X' : trimmed.replace(/\s+/g, '_')
}

/** `dd-MMM-yyyy`, the only date format EDF+ accepts in these fields. */
export function edfPlusDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0')
  return `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`
}

export function patientField(patient: EdfPatient = {}): string {
  return [
    subfield(patient.code),
    patient.sex ?? 'X',
    patient.birthdate ? edfPlusDate(patient.birthdate) : 'X',
    subfield(patient.name),
  ].join(' ')
}

export function recordingField(
  start: Date,
  options: Pick<EdfOptions, 'adminCode' | 'technician' | 'equipment'> = {},
): string {
  return [
    'Startdate',
    edfPlusDate(start),
    subfield(options.adminCode),
    subfield(options.technician),
    subfield(options.equipment ?? 'Movesense'),
  ].join(' ')
}

export interface EdfBuildResult {
  readonly bytes: Uint8Array
  readonly records: number
  /** Series that could not be included, and why. */
  readonly skipped: Array<{ key: string; reason: string }>
  /** Things the reader should know, such as a rate that had to be rounded. */
  readonly notes: string[]
}

/** Units we know. Anything else is written blank rather than guessed. */
const DIMENSIONS: Record<string, string> = {
  ECG: 'mV',
  Acc: 'm/s2',
  Gyro: 'dps',
  Magn: 'uT',
  Temp: 'K',
}

export function dimensionFor(series: SampleSeries): string {
  const fromChannel = series.channel ? DIMENSIONS[series.channel] : undefined
  if (fromChannel) return fromChannel
  for (const [key, dimension] of Object.entries(DIMENSIONS)) {
    if (series.stream.includes(key)) return dimension
  }
  return ''
}

/**
 * Flatten sample series into EDF signals: one signal per column, since EDF has
 * no notion of a three-axis channel.
 */
export function seriesToSignals(
  series: readonly SampleSeries[],
  recordDuration: number,
): { signals: EdfSignal[]; skipped: EdfBuildResult['skipped'] } {
  const signals: EdfSignal[] = []
  const skipped: EdfBuildResult['skipped'] = []

  for (const entry of series) {
    if (entry.estimatedRateHz === null || entry.estimatedRateHz <= 0) {
      skipped.push({
        key: entry.key,
        reason:
          'no sample rate - EDF needs a fixed rate, and this stream is paced by the sensor',
      })
      continue
    }

    const samplesPerRecord = Math.round(entry.estimatedRateHz * recordDuration)
    if (samplesPerRecord < 1) {
      skipped.push({
        key: entry.key,
        reason: `rate ${entry.estimatedRateHz.toFixed(2)} Hz is below one sample per ${recordDuration}s record`,
      })
      continue
    }

    const dimension = dimensionFor(entry)
    entry.columns.forEach((column, index) => {
      const samples = entry.values[index] ?? []
      const finite = samples.filter((value) => Number.isFinite(value))
      const min = finite.length ? Math.min(...finite) : -1
      const max = finite.length ? Math.max(...finite) : 1
      // A constant signal would give a zero-width range and divide by zero.
      const pad = max - min < 1e-9 ? 1 : 0

      signals.push({
        label: entry.channel ? `${entry.channel} ${column}` : `${entry.stream} ${column}`,
        dimension,
        samplesPerRecord,
        physicalMin: min - pad,
        physicalMax: max + pad,
        samples,
      })
    })
  }

  return { signals, skipped }
}

export function buildEdf(
  series: readonly SampleSeries[],
  options: EdfOptions = {},
): EdfBuildResult {
  const recordDuration = options.recordDuration ?? 1
  const { signals, skipped } = seriesToSignals(series, recordDuration)

  if (signals.length === 0) {
    return { bytes: new Uint8Array(0), records: 0, skipped, notes: [] }
  }

  // EDF needs an integer number of samples per record, so a rate like 50.63 Hz
  // becomes 51 Hz. Small, but it shifts sample times over a long recording, and
  // the user should hear it from us rather than discover it in their analysis.
  const notes: string[] = []
  for (const entry of series) {
    if (entry.estimatedRateHz === null) continue
    const rounded = Math.round(entry.estimatedRateHz * recordDuration) / recordDuration
    if (Math.abs(rounded - entry.estimatedRateHz) > entry.estimatedRateHz * 0.001) {
      notes.push(
        `${entry.key}: ${entry.estimatedRateHz.toFixed(2)} Hz written as ${rounded} Hz, because EDF stores a whole number of samples per record.`,
      )
    }
  }

  // Every signal must cover the same number of records, so the shortest wins.
  const records = Math.min(
    ...signals.map((signal) => Math.floor(signal.samples.length / signal.samplesPerRecord)),
  )
  if (records < 1) {
    return {
      bytes: new Uint8Array(0),
      records: 0,
      skipped: [
        ...skipped,
        { key: 'all', reason: 'not enough samples to fill a single data record' },
      ],
      notes,
    }
  }

  const start = options.startTime ?? new Date()
  const signalCount = signals.length + 1 // plus the annotations signal
  const headerBytes = HEADER_BLOCK * (1 + signalCount)

  const parts: Uint8Array[] = []
  const ascii = (text: string, width: number) =>
    parts.push(padAscii(text, width))

  // --- fixed header ---
  ascii('0', 8)
  ascii(patientField(options.patient), 80)
  ascii(recordingField(start, options), 80)
  ascii(edfDate(start), 8)
  ascii(edfTime(start), 8)
  ascii(String(headerBytes), 8)
  ascii('EDF+C', 44)
  ascii(String(records), 8)
  ascii(formatEdfNumber(recordDuration), 8)
  ascii(String(signalCount), 4)

  // --- per-signal header, each field written for every signal in turn ---
  const all = [...signals, annotationSignal()]

  // Each field is written for every signal in turn, not signal by signal.
  const forEachSignal = (write: (signal: EdfSignal) => void) => all.forEach(write)

  forEachSignal((signal) => ascii(signal.label, 16))
  forEachSignal(() => ascii('', 80)) // transducer type: unknown
  forEachSignal((signal) => ascii(signal.dimension, 8))
  forEachSignal((signal) => ascii(formatEdfNumber(signal.physicalMin), 8))
  forEachSignal((signal) => ascii(formatEdfNumber(signal.physicalMax), 8))
  forEachSignal(() => ascii(String(DIGITAL_MIN), 8))
  forEachSignal(() => ascii(String(DIGITAL_MAX), 8))
  forEachSignal(() => ascii('', 80)) // prefiltering: unknown
  forEachSignal((signal) => ascii(String(signal.samplesPerRecord), 8))
  forEachSignal(() => ascii('', 32)) // reserved

  // --- data records ---
  for (let record = 0; record < records; record++) {
    for (const signal of signals) {
      const block = new Uint8Array(signal.samplesPerRecord * 2)
      const view = new DataView(block.buffer)
      const scale =
        (DIGITAL_MAX - DIGITAL_MIN) / (signal.physicalMax - signal.physicalMin)

      for (let i = 0; i < signal.samplesPerRecord; i++) {
        const value = signal.samples[record * signal.samplesPerRecord + i]
        const physical = Number.isFinite(value) ? value! : signal.physicalMin
        const digital = Math.round(
          (physical - signal.physicalMin) * scale + DIGITAL_MIN,
        )
        view.setInt16(i * 2, clamp(digital, DIGITAL_MIN, DIGITAL_MAX), true)
      }
      parts.push(block)
    }

    // EDF+ requires an annotation channel; the onset of each record is the
    // minimum conformant content.
    parts.push(annotationBlock(record * recordDuration))
  }

  return { bytes: concat(parts), records, skipped, notes }
}

function annotationSignal(): EdfSignal {
  return {
    label: ANNOTATION_LABEL,
    dimension: '',
    samplesPerRecord: ANNOTATION_SAMPLES,
    physicalMin: -1,
    physicalMax: 1,
    samples: [],
  }
}

/**
 * A Time-stamped Annotations List.
 *
 * The 0x14 separators are mandatory: the onset text, 0x14, the (empty)
 * annotation text, 0x14, then 0x00 to end the TAL. The rest of the block stays
 * zero. Written as byte values rather than escapes in a string literal, so the
 * source file stays plain text.
 */
const TAL_SEPARATOR = 0x14
const TAL_TERMINATOR = 0x00

function annotationBlock(onsetSeconds: number): Uint8Array {
  const block = new Uint8Array(ANNOTATION_SAMPLES * 2)
  const onset = new TextEncoder().encode(`+${formatOnset(onsetSeconds)}`)
  if (onset.length + 3 > block.length) return block

  block.set(onset)
  block[onset.length] = TAL_SEPARATOR
  block[onset.length + 1] = TAL_SEPARATOR
  block[onset.length + 2] = TAL_TERMINATOR
  return block
}

function formatOnset(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3)
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** EDF header fields are fixed-width, space-padded, 8-bit ASCII. */
function padAscii(text: string, width: number): Uint8Array {
  const out = new Uint8Array(width).fill(0x20)
  for (let i = 0; i < Math.min(text.length, width); i++) {
    const code = text.charCodeAt(i)
    out[i] = code < 256 ? code : 0x20
  }
  return out
}

/**
 * EDF numbers must fit 8 ASCII characters, which is the real constraint - a
 * float like 0.000381469726563 has to be shortened to fit.
 */
export function formatEdfNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 10_000_000) return String(value)

  for (const digits of [6, 5, 4, 3, 2, 1, 0]) {
    const text = value.toFixed(digits)
    if (text.length <= 8) return text
  }
  // Last resort: exponent form, truncated.
  return value.toExponential(2).slice(0, 8)
}

function edfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)}`
}

function edfTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
