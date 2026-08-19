/**
 * Declarative layouts for GSP binary payloads, with the honesty machinery.
 *
 * GSP encodes a resource's fields in the order its API YAML declares them,
 * little-endian. The published docs do not list those field orders, so a layout
 * here is a hypothesis - and a wrong hypothesis produces plausible, silently
 * wrong numbers.
 *
 * **Arrays come in two flavours, and the difference is documented nowhere:**
 *
 *  - *Info and config* resources prefix each array with a uint8 count.
 *  - *Measurement subscriptions* do not. Their element count is fixed by the
 *    resource's `ArraySize` (readable from `GET /Meas/ECG/Info`) and the arrays
 *    simply fill the packet. `kind: 'fill'` models this.
 *
 * Two things keep a wrong layout from being shown as fact:
 *
 *  1. **Length has to match exactly.** A layout is only accepted if it consumes
 *     the whole payload. A wrong field order almost always changes the size, so
 *     most mistakes are caught rather than displayed.
 *  2. **Every layout carries where it came from.** `verified` was confirmed
 *     byte-for-byte against a real sensor; `derived` was read off real SBEM
 *     descriptors; `documented` comes from the API reference; `guess` is a guess,
 *     and the UI says so.
 *
 * When nothing matches, callers show raw hex. Hex is not a failure; it is the
 * correct output for a shape we do not know.
 */

export type ScalarType =
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'float32'
  | 'float64'
  | 'bool'

const SIZES: Record<ScalarType, number> = {
  int8: 1,
  uint8: 1,
  bool: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  int64: 8,
  uint64: 8,
  float64: 8,
}

export interface ScalarField {
  readonly kind: 'scalar'
  readonly name: string
  readonly type: ScalarType
}

/** A uint8 count, then that many repeats of `of`. */
export interface ArrayField {
  readonly kind: 'array'
  readonly name: string
  readonly of: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
}

/** NUL-terminated UTF-8. */
export interface StringField {
  readonly kind: 'string'
  readonly name: string
}

/**
 * Parallel arrays with no count prefix that consume the rest of the payload.
 *
 * Measurement subscriptions work this way: the element count is fixed by the
 * resource's `ArraySize` (see `GET /Meas/ECG/Info`) rather than sent per packet,
 * and where a packet carries several arrays they are equal-length and stored
 * array-major - all accelerometer samples, then all gyroscope, then all
 * magnetometer. Confirmed against hardware; see docs/gsp-protocol.md.
 */
export interface FillArrayField {
  readonly kind: 'fill'
  readonly arrays: ReadonlyArray<{
    readonly name: string
    readonly of: ReadonlyArray<{ readonly name: string; readonly type: ScalarType }>
  }>
}

export type LayoutField = ScalarField | ArrayField | StringField | FillArrayField

export type Provenance = 'verified' | 'derived' | 'documented' | 'guess'

export interface Layout {
  readonly name: string
  readonly fields: readonly LayoutField[]
  readonly provenance: Provenance
  /** Why we believe this, in one line, for the UI to show. */
  readonly note: string
}

export type DecodedValue =
  | number
  | boolean
  | string
  | Record<string, number | boolean>[]
  | (number | boolean)[]

export interface DecodeAttempt {
  readonly layout: Layout
  readonly value: Record<string, DecodedValue>
  readonly consumed: number
  /** True only when the layout consumed the payload exactly. */
  readonly exact: boolean
}

const scalar = (name: string, type: ScalarType): ScalarField => ({
  kind: 'scalar',
  name,
  type,
})

const xyz = [
  { name: 'x', type: 'float32' as const },
  { name: 'y', type: 'float32' as const },
  { name: 'z', type: 'float32' as const },
]

const VERIFIED_NOTE =
  'Confirmed byte-for-byte against a Movesense Flash sensor.'

const DERIVED_FROM_SBEM =
  'Field order read from SBEM descriptors in a real Movesense log; the log format and the GSP encoding come from the same definitions.'

/**
 * Layouts by path pattern. Several candidates per pattern are fine - the one
 * that fits the payload exactly wins.
 */
const REGISTRY: ReadonlyArray<{ pattern: RegExp; layouts: readonly Layout[] }> = [
  {
    pattern: /^\/System\/Energy\/Level$/i,
    layouts: [
      {
        name: 'Battery level',
        fields: [scalar('percent', 'uint8')],
        provenance: 'derived',
        note: 'Confirmed by the working Python tool, which reads a single byte.',
      },
    ],
  },
  {
    pattern: /^\/Mem\/DataLogger\/State$/i,
    layouts: [
      {
        name: 'DataLogger state',
        fields: [scalar('state', 'uint8')],
        provenance: 'derived',
        note: 'Confirmed by the working Python tool.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/ECG\/\d+\/mV$/i,
    layouts: [
      {
        name: 'ECG in microvolts (int16)',
        fields: [
          scalar('Timestamp', 'uint32'),
          {
            kind: 'fill',
            arrays: [{ name: 'Samples', of: [{ name: 'value', type: 'int16' }] }],
          },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 36-byte packets: 16 int16 samples, matching ArraySize from /Meas/ECG/Info. Despite the path name the unit is MICROvolts, not millivolts. Subscribing to both ECG paths at once and comparing samples that share a timestamp gives a ratio of 0.38146975, against the known 0.381469726563 uV per count. Divide by 1000 for mV.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/ECG\/\d+$/i,
    layouts: [
      {
        name: 'ECG raw counts (int32)',
        fields: [
          scalar('Timestamp', 'uint32'),
          {
            kind: 'fill',
            arrays: [{ name: 'Samples', of: [{ name: 'value', type: 'int32' }] }],
          },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 68-byte packets: 16 int32 samples. Multiply by 0.000381469726563 for millivolts. The /mV path carries the same samples with the same timestamps, pre-scaled to microvolts and narrowed to int16.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/(Acc|Gyro|Magn)\/\d+$/i,
    layouts: [
      {
        name: 'Single 3-axis sensor',
        fields: [
          scalar('Timestamp', 'uint32'),
          { kind: 'fill', arrays: [{ name: 'samples', of: xyz }] },
        ],
        provenance: 'derived',
        note:
          DERIVED_FROM_SBEM +
          ' The multi-sensor form of this shape is hardware-confirmed.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/IMU6\/\d+$/i,
    layouts: [
      {
        name: 'IMU6: acc + gyro',
        fields: [
          scalar('Timestamp', 'uint32'),
          {
            kind: 'fill',
            arrays: [
              { name: 'ArrayAcc', of: xyz },
              { name: 'ArrayGyro', of: xyz },
            ],
          },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 100-byte packets at 52 Hz: four accelerometer samples then four gyroscope samples. Gravity lands on the accelerometer block at about -9.85 m/s2.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/IMU6m\/\d+$/i,
    layouts: [
      {
        name: 'IMU6m: acc + magn',
        fields: [
          scalar('Timestamp', 'uint32'),
          {
            kind: 'fill',
            arrays: [
              { name: 'ArrayAcc', of: xyz },
              { name: 'ArrayMagn', of: xyz },
            ],
          },
        ],
        provenance: 'derived',
        note: DERIVED_FROM_SBEM + ' The IMU9 form of this layout is hardware-confirmed.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/IMU9\/\d+$/i,
    layouts: [
      {
        name: 'IMU9: acc + gyro + magn',
        fields: [
          scalar('Timestamp', 'uint32'),
          {
            kind: 'fill',
            arrays: [
              { name: 'ArrayAcc', of: xyz },
              { name: 'ArrayGyro', of: xyz },
              { name: 'ArrayMagn', of: xyz },
            ],
          },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' Four samples per packet at 52 Hz, stored array-major: every accelerometer sample, then gyroscope, then magnetometer. Units are m/s2, dps and uT.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/HR$/i,
    layouts: [
      {
        name: 'Heart rate',
        fields: [
          scalar('average', 'float32'),
          {
            kind: 'fill',
            arrays: [{ name: 'rrData', of: [{ name: 'rr', type: 'uint16' }] }],
          },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' RR intervals fill the packet with no count prefix, like the other measurement streams. Note this resource is subscribe-only: a GET returns 401 with an empty body.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/Temp$/i,
    layouts: [
      {
        name: 'Temperature',
        fields: [scalar('Timestamp', 'uint32'), scalar('Measurement', 'float32')],
        provenance: 'verified',
        note: VERIFIED_NOTE + ' Kelvin; subtract 273.15 for Celsius.',
      },
      {
        name: 'Temperature, value only',
        fields: [scalar('Measurement', 'float32')],
        provenance: 'guess',
        note: 'Alternative in case the reading carries no timestamp.',
      },
    ],
  },
  {
    // Not IMU: /Meas/IMU/Info carries all three range lists and has its own
    // layout below. Registry order decides, and the first match wins.
    pattern: /^\/Meas\/(Acc|Gyro|Magn)\/Info$/i,
    layouts: [
      {
        name: 'Sensor capabilities, byte ranges',
        fields: [
          { kind: 'array', name: 'SampleRates', of: [{ name: 'hz', type: 'uint16' }] },
          { kind: 'array', name: 'Ranges', of: [{ name: 'range', type: 'uint8' }] },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' For /Meas/Acc/Info: eight rates from 13 to 1666 Hz and four G ranges (2, 4, 8, 16), every value matching the API reference.',
      },
      {
        name: 'Sensor capabilities, uint16 ranges',
        fields: [
          { kind: 'array', name: 'SampleRates', of: [{ name: 'hz', type: 'uint16' }] },
          { kind: 'array', name: 'Ranges', of: [{ name: 'range', type: 'uint16' }] },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' The range element width differs by sensor: the accelerometer uses uint8, the gyroscope and magnetometer uint16. Gyroscope reports five ranges (125, 245, 500, 1000, 2000 dps) - the API reference omits 125. The magnetometer reports one fixed range, 5000 uT, which is the +/-50 gauss full scale of its chip.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/IMU\/Info$/i,
    layouts: [
      {
        name: 'Combined IMU capabilities',
        fields: [
          { kind: 'array', name: 'SampleRates', of: [{ name: 'hz', type: 'uint16' }] },
          { kind: 'array', name: 'AccRanges', of: [{ name: 'g', type: 'uint8' }] },
          { kind: 'array', name: 'GyroRanges', of: [{ name: 'dps', type: 'uint16' }] },
          { kind: 'array', name: 'MagnRanges', of: [{ name: 'uT', type: 'uint16' }] },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 36 bytes: the shared rate list, then each sensor range list in its own width - accelerometer uint8, gyroscope and magnetometer uint16.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/ECG\/Config$/i,
    layouts: [
      {
        name: 'ECG filter configuration',
        fields: [
          scalar('LowPassHz', 'uint16'),
          scalar('HighPassHz', 'float32'),
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 6 bytes: low-pass 40 Hz and high-pass 0.5 Hz, both within the options /Meas/ECG/Info advertises. Read-only over GSP, which has no generic PUT.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/Temp\/Info$/i,
    layouts: [
      {
        name: 'Temperature range',
        fields: [
          scalar('MinKelvin', 'uint32'),
          scalar('MaxKelvin', 'uint32'),
          scalar('Accuracy', 'float32'),
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 12 bytes reading 233 K, 398 K and 1.0 - that is -40 to +125 C, the classic silicon sensor range, which is what makes the field identification safe.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/HR\/Info$/i,
    layouts: [
      {
        name: 'Heart-rate limits',
        fields: [
          scalar('MinRrMs', 'uint16'),
          scalar('MaxRrMs', 'uint16'),
          scalar('Accuracy', 'float32'),
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' 8 bytes reading 200, 2000 and 5.0. The structure is certain; the field NAMES are inferred - the docs say "min/max range, accuracy", and 200/2000 ms read as RR-interval bounds (300 down to 30 bpm) rather than heart rates.',
      },
    ],
  },
  {
    pattern: /^\/Meas\/ECG\/Info$/i,
    layouts: [
      {
        name: 'ECG capabilities',
        fields: [
          { kind: 'array', name: 'SampleRates', of: [{ name: 'hz', type: 'uint16' }] },
          scalar('ArraySize', 'uint16'),
          { kind: 'array', name: 'LowPassFilters', of: [{ name: 'hz', type: 'uint16' }] },
          { kind: 'array', name: 'HighPassFilters', of: [{ name: 'hz', type: 'float32' }] },
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' Seven rates from 125 to 512 Hz, ArraySize 16, low-pass 40/100/150 Hz, high-pass 0.5 Hz \u2014 every value matching the API reference. ArraySize is what fixes the sample count in an ECG packet.',
      },
    ],
  },
  {
    pattern: /^\/Time$/i,
    layouts: [
      {
        name: 'UTC time',
        fields: [scalar('utcMicroseconds', 'uint64')],
        provenance: 'documented',
        note: 'Documented as microseconds since 1970-01-01.',
      },
    ],
  },
  {
    pattern: /^\/Time\/Detailed$/i,
    layouts: [
      {
        name: 'Detailed time',
        fields: [
          scalar('utcTime', 'uint64'),
          scalar('relativeTime', 'uint32'),
          scalar('tickRate', 'uint32'),
          scalar('accuracy', 'uint32'),
        ],
        provenance: 'verified',
        note:
          VERIFIED_NOTE +
          ' All four documented fields, 20 bytes exactly. utcTime is microseconds since the epoch and decoded to a correct wall-clock date, which is strong corroboration - a wrong field offset would give a nonsense year. tickRate reads 1024, but relativeTime is in MILLISECONDS: measured over 21.4 s of utcTime it advanced at exactly 1000 per second. Do not divide it by tickRate.',
      },
    ],
  },
]

export function layoutsFor(path: string): readonly Layout[] {
  const normalised = path.trim()
  for (const entry of REGISTRY) {
    if (entry.pattern.test(normalised)) return entry.layouts
  }
  return []
}

/** Fixed size of a layout, or null when it contains a variable-length field. */
export function fixedSize(fields: readonly LayoutField[]): number | null {
  let total = 0
  for (const field of fields) {
    if (field.kind === 'scalar') total += SIZES[field.type]
    else return null // arrays are variable-length
  }
  return total
}

class Reader {
  offset = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  scalar(type: ScalarType): number | boolean {
    const size = SIZES[type]
    if (this.remaining < size) throw new RangeError('payload too short')
    const at = this.offset
    this.offset += size

    switch (type) {
      case 'int8':
        return this.view.getInt8(at)
      case 'uint8':
        return this.view.getUint8(at)
      case 'bool':
        return this.view.getUint8(at) !== 0
      case 'int16':
        return this.view.getInt16(at, true)
      case 'uint16':
        return this.view.getUint16(at, true)
      case 'int32':
        return this.view.getInt32(at, true)
      case 'uint32':
        return this.view.getUint32(at, true)
      case 'float32':
        return this.view.getFloat32(at, true)
      case 'float64':
        return this.view.getFloat64(at, true)
      case 'int64':
        return Number(this.view.getBigInt64(at, true))
      case 'uint64':
        return Number(this.view.getBigUint64(at, true))
    }
  }

  string(): string {
    const start = this.offset
    while (this.offset < this.bytes.length && this.bytes[this.offset] !== 0) {
      this.offset++
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(
      this.bytes.subarray(start, this.offset),
    )
    if (this.offset < this.bytes.length) this.offset++ // skip the NUL
    return text
  }
}

/** Decode with one specific layout. Returns null if the payload is too short. */
export function decodeWithLayout(
  payload: Uint8Array,
  layout: Layout,
): DecodeAttempt | null {
  const reader = new Reader(payload)
  const value: Record<string, DecodedValue> = {}

  try {
    for (const field of layout.fields) {
      if (field.kind === 'scalar') {
        value[field.name] = reader.scalar(field.type)
      } else if (field.kind === 'string') {
        value[field.name] = reader.string()
      } else if (field.kind === 'fill') {
        const perSample = field.arrays.reduce(
          (sum, array) => sum + array.of.reduce((n, m) => n + SIZES[m.type], 0),
          0,
        )
        if (perSample === 0) return null
        // The count is implied by what is left. If it does not divide exactly,
        // the layout is wrong - refuse rather than decode a partial sample.
        if (reader.remaining % perSample !== 0) return null
        const count = reader.remaining / perSample

        for (const array of field.arrays) {
          if (array.of.length === 1) {
            const single = array.of[0]!
            const items: (number | boolean)[] = []
            for (let i = 0; i < count; i++) items.push(reader.scalar(single.type))
            value[array.name] = items
          } else {
            const items: Record<string, number | boolean>[] = []
            for (let i = 0; i < count; i++) {
              const item: Record<string, number | boolean> = {}
              for (const member of array.of) item[member.name] = reader.scalar(member.type)
              items.push(item)
            }
            value[array.name] = items
          }
        }
      } else {
        const count = reader.scalar('uint8') as number
        if (field.of.length === 1) {
          const single = field.of[0]!
          const items: (number | boolean)[] = []
          for (let i = 0; i < count; i++) items.push(reader.scalar(single.type))
          value[field.name] = items
        } else {
          const items: Record<string, number | boolean>[] = []
          for (let i = 0; i < count; i++) {
            const item: Record<string, number | boolean> = {}
            for (const member of field.of) item[member.name] = reader.scalar(member.type)
            items.push(item)
          }
          value[field.name] = items
        }
      }
    }
  } catch {
    return null
  }

  return {
    layout,
    value,
    consumed: reader.offset,
    exact: reader.offset === payload.length,
  }
}

export interface DecodeResult {
  /** The layout that consumed the payload exactly, if any. */
  readonly best: DecodeAttempt | null
  /** Every layout that parsed without running out of bytes, exact or not. */
  readonly attempts: DecodeAttempt[]
  readonly candidatesTried: number
}

/**
 * Try every layout registered for a path.
 *
 * A partial match is reported but never promoted to `best`: leftover bytes mean
 * the layout is wrong, even when the numbers look reasonable.
 */
export function decodePayload(path: string, payload: Uint8Array): DecodeResult {
  const candidates = layoutsFor(path)
  const attempts: DecodeAttempt[] = []

  for (const layout of candidates) {
    const attempt = decodeWithLayout(payload, layout)
    if (attempt) attempts.push(attempt)
  }

  return {
    best: attempts.find((attempt) => attempt.exact) ?? null,
    attempts,
    candidatesTried: candidates.length,
  }
}
