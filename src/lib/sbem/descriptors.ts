/**
 * SBEM descriptor chunks: the self-describing part of the format.
 *
 * A descriptor chunk is `uint16 dataId` followed by tagged UTF-8 lines:
 *   <PTH>  where the value belongs in the output
 *   <FRM>  its binary format, optionally `format,modifier`
 *   <MOD>  a modifier (units, scaling) whose semantics are undocumented
 *   <GRP>  a comma-separated list of child data ids
 *
 * Real example from a Movesense Flash IMU9 recording:
 *   id 13: <PTH>Samples+Array.MeasIMU9.Timestamp  <FRM>uint32
 *   id 39: <PTH>Samples.Array.MeasIMU9.ArrayAcc+x <FRM>float32
 *   id 54: <PTH>[
 *   id 94: <GRP>13,54,89,89,89,89,55,54,90,...,55
 *
 * Ids 54 and 55 are `[` and `]` markers, used inside a group to bracket repeated
 * elements: group 94 is "Timestamp, then four Acc triples, four Gyro triples,
 * four Magn triples" - which is exactly a four-sample IMU9 chunk.
 */

export const SBEM_FORMAT_SIZES = {
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
} as const

export type SbemFormat = keyof typeof SBEM_FORMAT_SIZES

export function isSbemFormat(name: string): name is SbemFormat {
  return name in SBEM_FORMAT_SIZES
}

export interface PathSegment {
  readonly name: string
  /** Marked with `+` in the path: this level repeats. */
  readonly isArray: boolean
}

export interface SbemLeafDescriptor {
  readonly kind: 'leaf'
  readonly dataId: number
  readonly path: string
  readonly segments: readonly PathSegment[]
  /** Null for `utf8`, which is variable-width and has no fixed size. */
  readonly format: SbemFormat | null
  readonly modifier?: string
  /**
   * Factor from the stored integer to the physical value, taken from `<MOD>`.
   *
   * A real ECG descriptor reads
   *   `<MOD>x*0.001,roundf(MIN(+32.767f,MAX(y,-32.767f))*1000.0f)`
   * so the stored int16 is microvolts and 0.001 converts it to millivolts. This
   * is the sensor telling us its own units, which beats a hardcoded table.
   */
  readonly scale?: number
}

/**
 * Read the decode factor out of a `<MOD>` string.
 *
 * The first clause is the decode expression (`x*0.001`); anything after the comma
 * is the encode expression, which we do not need.
 */
export function parseModifierScale(modifier: string | undefined): number | null {
  if (!modifier) return null
  const match = /^\s*x\s*\*\s*([0-9.eE+-]+)/.exec(modifier.split(',')[0] ?? '')
  if (!match) return null
  const value = Number.parseFloat(match[1]!)
  return Number.isFinite(value) && value !== 0 ? value : null
}

export interface SbemGroupDescriptor {
  readonly kind: 'group'
  readonly dataId: number
  readonly children: readonly number[]
}

/** A `[` or `]` entry, used to bracket repetitions inside a group. */
export interface SbemMarkerDescriptor {
  readonly kind: 'marker'
  readonly dataId: number
  readonly marker: '[' | ']'
}

/** A descriptor the reference tool emits only to satisfy its own converter. */
export interface SbemDummyDescriptor {
  readonly kind: 'dummy'
  readonly dataId: number
  readonly path: string
}

export type SbemDescriptor =
  | SbemLeafDescriptor
  | SbemGroupDescriptor
  | SbemMarkerDescriptor
  | SbemDummyDescriptor

const utf8 = new TextDecoder('utf-8', { fatal: false })

/**
 * Undo the workarounds Suunto's own converter needs.
 *
 * `Samples+Array.X` and `Samples.Array.X` both mean "X inside the Samples
 * array"; the literal `Array` element is an artifact.
 */
export function cleanPath(path: string): string {
  let cleaned = path.trim()
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  cleaned = cleaned.replace('Samples+Array.', 'Samples+')
  cleaned = cleaned.replace('Samples.Array.', 'Samples.')
  return cleaned
}

/**
 * Split a path into segments. `.` separates levels; `+` marks the level *before*
 * it as repeating.
 *
 * `Samples+MeasIMU9.Timestamp`      -> Samples[], MeasIMU9, Timestamp
 * `Samples.MeasIMU9.ArrayAcc+x`     -> Samples, MeasIMU9, ArrayAcc[], x
 */
export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = []
  let name = ''
  let pendingArray = false

  const flush = () => {
    if (name.length === 0) return
    segments.push({ name, isArray: pendingArray })
    name = ''
    pendingArray = false
  }

  for (const char of path) {
    if (char === '.') {
      flush()
    } else if (char === '+') {
      // Applies to the name being accumulated right now.
      pendingArray = true
      flush()
    } else {
      name += char
    }
  }
  flush()

  return segments
}

export function parseDescriptorChunk(payload: Uint8Array): SbemDescriptor {
  if (payload.length < 2) {
    throw new Error(
      `Descriptor chunk is ${payload.length} bytes, too short for a data id`,
    )
  }

  const dataId = payload[0]! | (payload[1]! << 8)
  const body = payload.subarray(2)
  // Descriptors are often NUL-terminated.
  const end = body.length > 0 && body[body.length - 1] === 0 ? body.length - 1 : body.length
  const text = utf8.decode(body.subarray(0, end))

  let rawPath: string | null = null
  let format: SbemFormat | null = null
  let modifier: string | undefined
  let children: number[] | null = null
  let isUtf8 = false

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    if (trimmed.startsWith('<PTH>')) {
      rawPath = trimmed.slice(5).trim()
    } else if (trimmed.startsWith('<FRM>')) {
      const [name, inlineModifier] = trimmed.slice(5).split(',')
      const formatName = (name ?? '').trim()
      if (inlineModifier) modifier = inlineModifier.trim()
      if (formatName === 'utf8') {
        isUtf8 = true
      } else if (isSbemFormat(formatName)) {
        format = formatName
      } else if (formatName.length > 0) {
        throw new Error(`Unknown SBEM format "${formatName}" in descriptor ${dataId}`)
      }
    } else if (trimmed.startsWith('<MOD>')) {
      modifier = trimmed.slice(5).trim()
    } else if (trimmed.startsWith('<GRP>')) {
      children = trimmed
        .slice(5)
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value))
    }
    // Unknown tags are ignored rather than fatal: the format may grow.
  }

  if (children) {
    return { kind: 'group', dataId, children }
  }

  if (rawPath === '[' || rawPath === ']') {
    return { kind: 'marker', dataId, marker: rawPath }
  }

  if (rawPath === null) {
    return { kind: 'dummy', dataId, path: '' }
  }

  // A leading `+` marks a descriptor that exists only to make the reference
  // converter's output shape work out. It carries no real value.
  if (rawPath.startsWith('+')) {
    return { kind: 'dummy', dataId, path: rawPath }
  }

  const cleaned = cleanPath(rawPath)
  const scale = parseModifierScale(modifier)
  const leaf: SbemLeafDescriptor = {
    kind: 'leaf',
    dataId,
    path: cleaned,
    segments: parsePath(cleaned),
    format: isUtf8 ? null : format,
    ...(modifier === undefined ? {} : { modifier }),
    ...(scale === null ? {} : { scale }),
  }
  return leaf
}
