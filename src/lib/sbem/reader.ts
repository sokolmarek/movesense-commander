/**
 * SBEM chunk framing. See docs/sbem-format.md.
 *
 * A file is an 8-byte ASCII header followed by `id, length, payload` chunks,
 * where both id and length are one byte unless that byte is the escape value.
 */

/**
 * The escape sentinel.
 *
 * The Python reference writes this as `b"\255"`, which Python reads as an
 * *octal* escape - so that constant is actually 0xAD (173), not 255 as its name
 * says. We use 0xFF and warn when a single byte lands in 173..254, the only
 * range where the two readings disagree. If that warning ever fires on real
 * sensor output we will have evidence to settle it; until then, do not "fix"
 * this to 0xAD.
 */
export const SBEM_ESCAPE = 0xff

/** The range where our reading and the Python reference's would diverge. */
export const AMBIGUOUS_ESCAPE_MIN = 0xad
export const AMBIGUOUS_ESCAPE_MAX = 0xfe

/** Chunk id 0 is reserved for descriptors. */
export const SBEM_DESCRIPTOR_ID = 0

export const SBEM_HEADER_BYTES = 8

export interface SbemChunk {
  readonly id: number
  readonly payload: Uint8Array
  /** Byte offset of the chunk header within the file, for diagnostics. */
  readonly offset: number
}

export interface SbemFileWarning {
  readonly kind: 'ambiguous-escape' | 'truncated' | 'bad-header'
  readonly message: string
  readonly offset: number
}

export interface SbemFile {
  /** The 8-byte header as ASCII, e.g. `SBEM0112`. */
  readonly header: string
  readonly chunks: SbemChunk[]
  readonly warnings: SbemFileWarning[]
  /** True when the file ended mid-chunk - a download with a hole, most likely. */
  readonly truncated: boolean
}

class Cursor {
  offset = 0
  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  byte(): number {
    return this.bytes[this.offset++]!
  }

  uint(width: number): number {
    let value = 0
    for (let i = 0; i < width; i++) {
      value += this.bytes[this.offset + i]! * 2 ** (8 * i)
    }
    this.offset += width
    return value
  }
}

export function readSbem(bytes: Uint8Array): SbemFile {
  const warnings: SbemFileWarning[] = []
  const chunks: SbemChunk[] = []

  if (bytes.length < SBEM_HEADER_BYTES) {
    return {
      header: '',
      chunks,
      warnings: [
        {
          kind: 'truncated',
          message: `File is ${bytes.length} bytes, too short even for the ${SBEM_HEADER_BYTES}-byte header.`,
          offset: 0,
        },
      ],
      truncated: true,
    }
  }

  const header = new TextDecoder('ascii').decode(
    bytes.subarray(0, SBEM_HEADER_BYTES),
  )
  if (!header.startsWith('SBEM')) {
    warnings.push({
      kind: 'bad-header',
      message: `Expected a header starting "SBEM", found "${header}". Parsing anyway.`,
      offset: 0,
    })
  }

  const cursor = new Cursor(bytes)
  cursor.offset = SBEM_HEADER_BYTES
  let truncated = false

  while (cursor.remaining > 0) {
    const chunkStart = cursor.offset

    // --- id ---
    const idByte = cursor.byte()
    let id: number
    if (idByte < SBEM_ESCAPE) {
      id = idByte
      noteAmbiguity(warnings, idByte, chunkStart, 'chunk id')
    } else {
      if (cursor.remaining < 2) {
        truncated = true
        warnings.push(truncationWarning(chunkStart, 'escaped chunk id'))
        break
      }
      id = cursor.uint(2)
    }

    if (cursor.remaining < 1) {
      truncated = true
      warnings.push(truncationWarning(chunkStart, 'chunk length'))
      break
    }

    // --- length ---
    const lengthByte = cursor.byte()
    let length: number
    if (lengthByte < SBEM_ESCAPE) {
      length = lengthByte
      noteAmbiguity(warnings, lengthByte, chunkStart, 'chunk length')
    } else {
      if (cursor.remaining < 4) {
        truncated = true
        warnings.push(truncationWarning(chunkStart, 'escaped chunk length'))
        break
      }
      length = cursor.uint(4)
    }

    // --- payload ---
    if (cursor.remaining < length) {
      truncated = true
      warnings.push({
        kind: 'truncated',
        message: `Chunk ${id} at offset ${chunkStart} claims ${length} bytes but only ${cursor.remaining} remain.`,
        offset: chunkStart,
      })
      break
    }

    chunks.push({
      id,
      payload: bytes.subarray(cursor.offset, cursor.offset + length),
      offset: chunkStart,
    })
    cursor.offset += length
  }

  return { header, chunks, warnings, truncated }
}

function noteAmbiguity(
  warnings: SbemFileWarning[],
  value: number,
  offset: number,
  what: string,
): void {
  if (value < AMBIGUOUS_ESCAPE_MIN || value > AMBIGUOUS_ESCAPE_MAX) return
  // Only worth saying once - a file full of these would drown the report.
  if (warnings.some((warning) => warning.kind === 'ambiguous-escape')) return
  warnings.push({
    kind: 'ambiguous-escape',
    message: `Single-byte ${what} 0x${value.toString(16)} at offset ${offset} falls in 0xAD..0xFE, where our escape value (0xFF) and the Python reference's (0xAD) disagree. This file may be parsed differently by the two tools - see docs/sbem-format.md.`,
    offset,
  })
}

function truncationWarning(offset: number, what: string): SbemFileWarning {
  return {
    kind: 'truncated',
    message: `File ends mid-${what} at offset ${offset}.`,
    offset,
  }
}
