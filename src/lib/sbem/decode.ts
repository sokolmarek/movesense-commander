import {
  parseDescriptorChunk,
  SBEM_FORMAT_SIZES,
  type PathSegment,
  type SbemDescriptor,
  type SbemLeafDescriptor,
} from './descriptors'
import {
  readSbem,
  SBEM_DESCRIPTOR_ID,
  type SbemChunk,
  type SbemFileWarning,
} from './reader'

export type SbemValue = number | boolean
export type SbemRecordValue =
  | SbemValue
  | SbemValue[]
  | SbemObject
  | SbemObject[]
export interface SbemObject {
  [key: string]: SbemRecordValue
}

export interface SbemRecord {
  /** The chunk id this record was decoded from. */
  readonly dataId: number
  /** Top-level stream name, e.g. `MeasIMU9`. */
  readonly stream: string
  readonly value: SbemObject
}

export interface SbemStreamSummary {
  readonly stream: string
  readonly records: number
  /** How many leaf samples the stream contributed, arrays expanded. */
  readonly samples: number
  readonly firstTimestamp: number | null
  readonly lastTimestamp: number | null
  /** Chunk ids seen for this stream. */
  readonly dataIds: number[]
}

export interface SbemDocument {
  readonly header: string
  /** Name of the outermost container, `Samples` in every file we have seen. */
  readonly rootName: string | null
  readonly records: SbemRecord[]
  readonly streams: SbemStreamSummary[]
  readonly warnings: SbemFileWarning[]
  readonly truncated: boolean
  /** Data chunks we could not decode, with the reason. */
  readonly skipped: Array<{ dataId: number; offset: number; reason: string }>
  /**
   * Decode factors from `<MOD>`, keyed by the dotted path below the root
   * (e.g. `MeasECGmV.Samples` -> 0.001).
   *
   * Not applied to `records`: those stay exactly as stored, so they can be
   * checked against the reference tool byte for byte. `extractSamples` applies
   * them, which is where physical units actually matter.
   */
  readonly scales: Record<string, number>
}

/**
 * Array marking is inconsistent across sibling descriptors: for an IMU9 chunk
 * only `ArrayAcc+x` carries the `+`, while `ArrayAcc.y` and `ArrayAcc.z` do not.
 * So the marking has to be pooled across the whole descriptor set - once a
 * prefix has been seen as an array, every path sharing it is one too. The Python
 * reference does the same thing with a module-level set.
 */
function collectArrayPrefixes(
  leaf: SbemLeafDescriptor,
  into: Set<string>,
): void {
  const parts: string[] = []
  for (const segment of leaf.segments) {
    parts.push(segment.name)
    if (segment.isArray) into.add(parts.join('.'))
  }
}

function applyArrayPrefixes(
  segments: readonly PathSegment[],
  arrayPrefixes: ReadonlySet<string>,
): PathSegment[] {
  const parts: string[] = []
  return segments.map((segment) => {
    parts.push(segment.name)
    return segment.isArray || arrayPrefixes.has(parts.join('.'))
      ? { name: segment.name, isArray: true }
      : segment
  })
}

/** A leaf plus where it sits in the flattened group expansion. */
interface FlatLeaf {
  readonly leaf: SbemLeafDescriptor
  readonly size: number
}

/**
 * Decode a whole SBEM file.
 *
 * Descriptors are picked up as they appear, which is what Movesense Flash logs
 * need - they carry their descriptors inline, interleaved with data.
 */
export function decodeSbem(bytes: Uint8Array): SbemDocument {
  const file = readSbem(bytes)
  const descriptors = new Map<number, SbemDescriptor>()
  const flatCache = new Map<number, FlatLeaf[] | null>()
  const records: SbemRecord[] = []
  const skipped: SbemDocument['skipped'] = []
  const warnings = [...file.warnings]
  const arrayPrefixes = new Set<string>()
  const scales: Record<string, number> = {}
  let rootName: string | null = null

  for (const chunk of file.chunks) {
    if (chunk.id === SBEM_DESCRIPTOR_ID) {
      try {
        const descriptor = parseDescriptorChunk(chunk.payload)
        descriptors.set(descriptor.dataId, descriptor)
        // A new descriptor can change how a previously seen id decodes.
        flatCache.clear()
        if (descriptor.kind === 'leaf') {
          collectArrayPrefixes(descriptor, arrayPrefixes)
          rootName ??= descriptor.segments[0]?.name ?? null
          if (descriptor.scale !== undefined) {
            const names = descriptor.segments.map((segment) => segment.name)
            const below = names[0] === rootName ? names.slice(1) : names
            // Key on the container, not the leaf: every axis of a channel shares
            // one scale.
            scales[below.join('.')] = descriptor.scale
          }
        }
      } catch (error) {
        skipped.push({
          dataId: SBEM_DESCRIPTOR_ID,
          offset: chunk.offset,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      continue
    }

    const record = decodeDataChunk(
      chunk,
      descriptors,
      flatCache,
      rootName,
      arrayPrefixes,
    )
    if ('reason' in record) {
      skipped.push({ dataId: chunk.id, offset: chunk.offset, reason: record.reason })
    } else {
      records.push(record.record)
    }
  }

  return {
    header: file.header,
    rootName,
    records,
    streams: summariseStreams(records),
    warnings,
    truncated: file.truncated,
    skipped,
    scales,
  }
}

function decodeDataChunk(
  chunk: SbemChunk,
  descriptors: Map<number, SbemDescriptor>,
  flatCache: Map<number, FlatLeaf[] | null>,
  rootName: string | null,
  arrayPrefixes: ReadonlySet<string>,
): { record: SbemRecord } | { reason: string } {
  const flat = flattenCached(chunk.id, descriptors, flatCache)
  if (flat === null) {
    return { reason: `No usable descriptor for data id ${chunk.id}` }
  }

  const expected = flat.reduce((sum, item) => sum + item.size, 0)
  if (expected !== chunk.payload.length) {
    // The reference tool skips these too. A mismatch means the descriptor set is
    // wrong for this chunk, and decoding anyway would produce garbage numbers.
    return {
      reason: `Descriptor for id ${chunk.id} describes ${expected} bytes, chunk holds ${chunk.payload.length}`,
    }
  }

  const view = new DataView(
    chunk.payload.buffer,
    chunk.payload.byteOffset,
    chunk.payload.byteLength,
  )

  const value: SbemObject = {}
  let offset = 0
  for (const item of flat) {
    const raw = readValue(view, offset, item.leaf.format!)
    offset += item.size
    // Drop the outermost container segment: one record *is* one element of it.
    const segments = applyArrayPrefixes(item.leaf.segments, arrayPrefixes)
    const relative =
      rootName !== null && segments[0]?.name === rootName
        ? segments.slice(1)
        : segments
    if (relative.length === 0) continue
    assign(value, relative, raw)
  }

  const stream = Object.keys(value)[0] ?? `id${chunk.id}`
  return { record: { dataId: chunk.id, stream, value } }
}

function flattenCached(
  dataId: number,
  descriptors: Map<number, SbemDescriptor>,
  cache: Map<number, FlatLeaf[] | null>,
): FlatLeaf[] | null {
  const cached = cache.get(dataId)
  if (cached !== undefined) return cached
  const flat = flatten(dataId, descriptors, new Set())
  cache.set(dataId, flat)
  return flat
}

/**
 * Expand a data id into its ordered list of fixed-width leaves.
 *
 * Groups nest and can repeat a child several times over (that is how the sensor
 * expresses "four samples in this chunk"), so this walks the tree in order and
 * keeps duplicates.
 */
function flatten(
  dataId: number,
  descriptors: Map<number, SbemDescriptor>,
  visiting: Set<number>,
): FlatLeaf[] | null {
  const descriptor = descriptors.get(dataId)
  if (!descriptor) return null

  if (descriptor.kind === 'leaf') {
    // utf8 leaves have no fixed size, so a chunk containing one cannot be
    // decoded by fixed layout at all.
    if (descriptor.format === null) return null
    return [{ leaf: descriptor, size: SBEM_FORMAT_SIZES[descriptor.format] }]
  }

  // Markers and dummies contribute no bytes.
  if (descriptor.kind === 'marker' || descriptor.kind === 'dummy') return []

  if (visiting.has(dataId)) {
    // Malformed descriptor set; refuse rather than recurse forever.
    return null
  }
  visiting.add(dataId)

  const out: FlatLeaf[] = []
  for (const child of descriptor.children) {
    const expanded = flatten(child, descriptors, visiting)
    if (expanded === null) {
      visiting.delete(dataId)
      return null
    }
    out.push(...expanded)
  }
  visiting.delete(dataId)
  return out
}

function readValue(
  view: DataView,
  offset: number,
  format: NonNullable<SbemLeafDescriptor['format']>,
): SbemValue {
  switch (format) {
    case 'int8':
      return view.getInt8(offset)
    case 'uint8':
      return view.getUint8(offset)
    case 'bool':
      return view.getUint8(offset) !== 0
    case 'int16':
      return view.getInt16(offset, true)
    case 'uint16':
      return view.getUint16(offset, true)
    case 'int32':
      return view.getInt32(offset, true)
    case 'uint32':
      return view.getUint32(offset, true)
    case 'float32':
      return view.getFloat32(offset, true)
    case 'float64':
      return view.getFloat64(offset, true)
    case 'int64':
      return Number(view.getBigInt64(offset, true))
    case 'uint64':
      return Number(view.getBigUint64(offset, true))
  }
}

/**
 * Place a value at its path, treating a second assignment to the same field as
 * repetition.
 *
 * That single rule handles both ways SBEM expresses repeats:
 *   - an intermediate segment marked `+` (`ArrayAcc+x`) collects objects, so a
 *     repeat starts a new element: `ArrayAcc: [{x,y,z}, {x,y,z}, ...]`
 *   - an unmarked leaf repeated inside a group collects scalars, so a repeat
 *     promotes it to an array: `rrData: [421, 430, ...]`
 *
 * This is where we diverge from the Python reference, which ignores the `[`/`]`
 * repetition brackets and so flattens a four-sample IMU9 chunk into per-axis
 * arrays (`ArrayAcc: [{x: [4 values], y: [...], z: [...]}]`) instead of four
 * samples. The numbers are the same; the structure here reflects what the
 * descriptors actually say.
 */
function assign(
  root: SbemObject,
  segments: readonly PathSegment[],
  value: SbemValue,
): void {
  let node: SbemObject = root

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!
    const rest = segments.slice(i + 1)

    if (segment.isArray) {
      let array = node[segment.name]
      if (!Array.isArray(array)) {
        array = [{}]
        node[segment.name] = array as SbemObject[]
      }
      const elements = array as SbemObject[]
      let last = elements[elements.length - 1]
      if (last === undefined) {
        last = {}
        elements.push(last)
      }
      // If the remaining path is already filled in, this value belongs to a new
      // element of the array.
      if (hasPath(last, rest)) {
        last = {}
        elements.push(last)
      }
      node = last
    } else {
      let child = node[segment.name]
      if (typeof child !== 'object' || child === null || Array.isArray(child)) {
        child = {}
        node[segment.name] = child
      }
      node = child as SbemObject
    }
  }

  const leaf = segments[segments.length - 1]!
  const existing = node[leaf.name]

  if (leaf.isArray) {
    if (Array.isArray(existing)) {
      ;(existing as SbemValue[]).push(value)
    } else {
      node[leaf.name] = [value]
    }
    return
  }

  if (existing === undefined) {
    node[leaf.name] = value
  } else if (Array.isArray(existing)) {
    ;(existing as SbemValue[]).push(value)
  } else {
    node[leaf.name] = [existing as SbemValue, value]
  }
}

/** Whether `node` already holds a value at `segments`. */
function hasPath(node: SbemObject, segments: readonly PathSegment[]): boolean {
  let current: SbemRecordValue | undefined = node
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return false
    if (Array.isArray(current)) {
      current = current[current.length - 1] as SbemRecordValue | undefined
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        return false
      }
    }
    current = (current as SbemObject)[segment.name]
    if (current === undefined) return false
  }
  return true
}

function summariseStreams(records: readonly SbemRecord[]): SbemStreamSummary[] {
  const byStream = new Map<
    string,
    {
      records: number
      samples: number
      first: number | null
      last: number | null
      dataIds: Set<number>
    }
  >()

  for (const record of records) {
    let entry = byStream.get(record.stream)
    if (!entry) {
      entry = { records: 0, samples: 0, first: null, last: null, dataIds: new Set() }
      byStream.set(record.stream, entry)
    }
    entry.records++
    entry.dataIds.add(record.dataId)
    entry.samples += countSamples(record.value)

    const timestamp = findTimestamp(record.value)
    if (timestamp !== null) {
      if (entry.first === null) entry.first = timestamp
      entry.last = timestamp
    }
  }

  return [...byStream.entries()].map(([stream, entry]) => ({
    stream,
    records: entry.records,
    samples: entry.samples,
    firstTimestamp: entry.first,
    lastTimestamp: entry.last,
    dataIds: [...entry.dataIds].sort((a, b) => a - b),
  }))
}

/**
 * How many samples a record carries: the longest array anywhere in it, or 1 for
 * a record with no arrays.
 */
function countSamples(value: SbemRecordValue): number {
  if (Array.isArray(value)) {
    const nested = value.map((item) => countSamples(item as SbemRecordValue))
    return Math.max(value.length, ...nested)
  }
  if (typeof value === 'object' && value !== null) {
    const nested = Object.values(value).map(countSamples)
    return nested.length ? Math.max(1, ...nested) : 1
  }
  return 1
}

function findTimestamp(value: SbemRecordValue): number | null {
  if (typeof value !== 'object' || value === null) return null
  if (Array.isArray(value)) return null

  for (const [key, child] of Object.entries(value)) {
    if (
      (key === 'Timestamp' || key === 'timestamp' || key === 'relativeTime') &&
      typeof child === 'number'
    ) {
      return child
    }
    const nested = findTimestamp(child)
    if (nested !== null) return nested
  }
  return null
}
