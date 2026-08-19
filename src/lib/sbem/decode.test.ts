import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeSbem, type SbemObject } from './decode'
import { cleanPath, parseDescriptorChunk, parsePath } from './descriptors'
import { readSbem } from './reader'

/**
 * `imu9-prefix.sbem` is the header, every descriptor, and the first 40 data
 * chunks of `test_1.sbem` from Movesense's own sbem-tools (MIT). The expected
 * JSON next to it is the output of that project's `sbem2json` on this exact
 * file, so the numbers below are cross-checked against the reference tool rather
 * than against our own assumptions.
 */
function fixture(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))
  return new Uint8Array(readFileSync(path))
}

function expectedJson(): { Samples: Array<Record<string, SbemObject>> } {
  const path = fileURLToPath(
    new URL('./__fixtures__/imu9-prefix.expected.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('path parsing', () => {
  it('strips the Array artifact the reference converter needs', () => {
    expect(cleanPath('Samples+Array.MeasIMU9.Timestamp')).toBe(
      'Samples+MeasIMU9.Timestamp',
    )
    expect(cleanPath('Samples.Array.MeasIMU9.ArrayAcc+x')).toBe(
      'Samples.MeasIMU9.ArrayAcc+x',
    )
  })

  it('marks the segment before a + as repeating', () => {
    expect(parsePath('Samples+MeasIMU9.Timestamp')).toEqual([
      { name: 'Samples', isArray: true },
      { name: 'MeasIMU9', isArray: false },
      { name: 'Timestamp', isArray: false },
    ])
    expect(parsePath('Samples.MeasIMU9.ArrayAcc+x')).toEqual([
      { name: 'Samples', isArray: false },
      { name: 'MeasIMU9', isArray: false },
      { name: 'ArrayAcc', isArray: true },
      { name: 'x', isArray: false },
    ])
  })
})

describe('descriptor chunks', () => {
  const chunk = (dataId: number, text: string) => {
    const body = new TextEncoder().encode(text)
    const payload = new Uint8Array(2 + body.length)
    payload[0] = dataId & 0xff
    payload[1] = dataId >> 8
    payload.set(body, 2)
    return payload
  }

  it('parses a leaf', () => {
    const descriptor = parseDescriptorChunk(
      chunk(13, '<PTH>Samples+Array.MeasIMU9.Timestamp\n<FRM>uint32'),
    )
    expect(descriptor).toMatchObject({
      kind: 'leaf',
      dataId: 13,
      path: 'Samples+MeasIMU9.Timestamp',
      format: 'uint32',
    })
  })

  it('parses a group', () => {
    expect(parseDescriptorChunk(chunk(89, '<GRP>39,40,41'))).toEqual({
      kind: 'group',
      dataId: 89,
      children: [39, 40, 41],
    })
  })

  it('parses the repetition brackets', () => {
    expect(parseDescriptorChunk(chunk(54, '<PTH>['))).toEqual({
      kind: 'marker',
      dataId: 54,
      marker: '[',
    })
    expect(parseDescriptorChunk(chunk(55, '<PTH>]'))).toEqual({
      kind: 'marker',
      dataId: 55,
      marker: ']',
    })
  })

  it('treats a leading + path as a dummy', () => {
    expect(parseDescriptorChunk(chunk(56, '<PTH>+Samples.Array.ArrayBegin\n<FRM>uint8')))
      .toMatchObject({ kind: 'dummy', dataId: 56 })
  })

  it('keeps an inline format modifier', () => {
    expect(
      parseDescriptorChunk(chunk(7, '<PTH>A.B\n<FRM>int16,scale=0.1')),
    ).toMatchObject({ format: 'int16', modifier: 'scale=0.1' })
  })

  it('reports an unknown format rather than guessing a width', () => {
    expect(() => parseDescriptorChunk(chunk(8, '<PTH>A.B\n<FRM>quux'))).toThrow(
      /Unknown SBEM format/,
    )
  })

  it('gives utf8 no fixed size', () => {
    expect(parseDescriptorChunk(chunk(9, '<PTH>A.B\n<FRM>utf8'))).toMatchObject({
      format: null,
    })
  })
})

describe('chunk framing', () => {
  it('reads the real fixture cleanly to the last byte', () => {
    const file = readSbem(fixture('imu9-prefix.sbem'))
    expect(file.header).toBe('SBEM0112')
    expect(file.truncated).toBe(false)
    expect(file.warnings).toEqual([])
    expect(file.chunks).toHaveLength(70) // 30 descriptors + 40 data chunks
  })

  it('flags a file that ends mid-chunk instead of returning partial garbage', () => {
    const full = fixture('imu9-prefix.sbem')
    const file = readSbem(full.subarray(0, full.length - 20))
    expect(file.truncated).toBe(true)
    expect(file.warnings.some((w) => w.kind === 'truncated')).toBe(true)
  })

  it('warns on a single byte in the ambiguous escape range', () => {
    // 0xB0 is a valid single-byte length for us but an escape for the Python
    // reference, so the two tools would disagree about this file.
    const bytes = new Uint8Array(8 + 2 + 0xb0)
    bytes.set(new TextEncoder().encode('SBEM0112'))
    bytes[8] = 7
    bytes[9] = 0xb0
    const file = readSbem(bytes)
    expect(file.warnings.some((w) => w.kind === 'ambiguous-escape')).toBe(true)
    expect(file.chunks).toHaveLength(1)
    expect(file.chunks[0]!.payload).toHaveLength(0xb0)
  })

  it('rejects a file too short for a header', () => {
    const file = readSbem(new Uint8Array([1, 2, 3]))
    expect(file.truncated).toBe(true)
    expect(file.chunks).toEqual([])
  })
})

describe('decodeSbem against the reference fixture', () => {
  const document = decodeSbem(fixture('imu9-prefix.sbem'))
  const reference = expectedJson()

  it('decodes every data chunk, skipping none', () => {
    expect(document.skipped).toEqual([])
    expect(document.truncated).toBe(false)
    expect(document.records).toHaveLength(40)
    expect(document.records).toHaveLength(reference.Samples.length)
  })

  it('identifies the container and the streams', () => {
    expect(document.rootName).toBe('Samples')
    expect(document.streams.map((s) => s.stream).sort()).toEqual([
      'MeasHR',
      'MeasIMU9',
    ])
    const imu = document.streams.find((s) => s.stream === 'MeasIMU9')!
    expect(imu.records).toBe(39)
    expect(imu.dataIds).toEqual([94])
    // Group 94 brackets four repetitions of each axis triple, so 39 chunks
    // carry 156 samples.
    expect(imu.samples).toBe(39 * 4)
  })

  it('agrees with the reference tool on the record order and stream of each chunk', () => {
    const ours = document.records.map((record) => record.stream)
    const theirs = reference.Samples.map((sample) => Object.keys(sample)[0]!)
    expect(ours).toEqual(theirs)
  })

  it('agrees with the reference tool on timestamps', () => {
    const ourTimestamps = document.records
      .filter((record) => record.stream === 'MeasIMU9')
      .map((record) => (record.value.MeasIMU9 as SbemObject).Timestamp)

    const theirTimestamps = reference.Samples.filter((s) => 'MeasIMU9' in s).map(
      (s) => (s.MeasIMU9!.MeasIMU9 as SbemObject).Timestamp,
    )

    expect(ourTimestamps).toEqual(theirTimestamps)
    expect(ourTimestamps[0]).toBe(866085854)
  })

  it('reads four IMU9 samples per chunk, where the reference groups per axis', () => {
    // The reference ignores the [ ] repetition brackets and emits
    // ArrayAcc: [{x: [4], y: [4], z: [4]}]. The descriptors say four samples of
    // (x, y, z), so that is what we produce. Same numbers, better structure.
    const first = document.records[0]!
    const imu = first.value.MeasIMU9 as SbemObject
    const acc = imu.ArrayAcc as SbemObject[]

    expect(acc).toHaveLength(4)
    for (const sample of acc) {
      expect(Object.keys(sample).sort()).toEqual(['x', 'y', 'z'])
      expect(typeof sample.x).toBe('number')
    }

    const theirAcc = (reference.Samples[0]!.MeasIMU9!.ArrayAcc as SbemObject[])[0]!
    const theirX = theirAcc.x as number[]
    const theirY = theirAcc.y as number[]
    const theirZ = theirAcc.z as number[]

    expect(acc.map((s) => s.x as number)).toEqual(theirX)
    expect(acc.map((s) => s.y as number)).toEqual(theirY)
    expect(acc.map((s) => s.z as number)).toEqual(theirZ)
  })

  it('decodes all three IMU9 sensors', () => {
    const imu = document.records[0]!.value.MeasIMU9 as SbemObject
    expect(Object.keys(imu).sort()).toEqual([
      'ArrayAcc',
      'ArrayGyro',
      'ArrayMagn',
      'Timestamp',
    ])
    for (const key of ['ArrayAcc', 'ArrayGyro', 'ArrayMagn'] as const) {
      expect(imu[key] as SbemObject[]).toHaveLength(4)
    }
  })

  it('decodes a scalar-repeat stream the same way the reference does', () => {
    // MeasHR group 69 is average + one rrData, so rrData stays a scalar.
    const hr = document.records.find((record) => record.stream === 'MeasHR')!
    const value = hr.value.MeasHR as SbemObject
    const theirs = reference.Samples.find((s) => 'MeasHR' in s)!.MeasHR!

    expect(value.rrData).toBe((theirs.MeasHR as SbemObject | undefined)?.rrData ?? theirs.rrData)
    expect(value.average).toBeCloseTo(
      ((theirs.MeasHR as SbemObject | undefined)?.average ??
        theirs.average) as number,
      5,
    )
  })
})

describe('decodeSbem robustness', () => {
  it('skips a data chunk whose descriptor does not match its size', () => {
    const source = fixture('imu9-prefix.sbem')
    const bytes = new Uint8Array(source)
    // Shrink the first data chunk's declared length. Its header sits right after
    // the descriptors; find it by decoding and locating the first data chunk.
    const file = readSbem(source)
    const firstData = file.chunks.find((chunk) => chunk.id !== 0)!
    bytes[firstData.offset + 1] = 140 // was 148

    const document = decodeSbem(bytes)
    expect(document.skipped.length).toBeGreaterThan(0)
    expect(document.skipped[0]!.reason).toMatch(/describes 148 bytes, chunk holds 140/)
  })

  it('skips data with no descriptor rather than inventing a shape', () => {
    const bytes = new Uint8Array(8 + 2 + 4)
    bytes.set(new TextEncoder().encode('SBEM0112'))
    bytes[8] = 200 // data id nobody described
    bytes[9] = 4
    const document = decodeSbem(bytes)
    expect(document.records).toEqual([])
    expect(document.skipped[0]!.reason).toMatch(/No usable descriptor for data id 200/)
  })

  it('returns an empty document for an empty file', () => {
    const document = decodeSbem(new Uint8Array(0))
    expect(document.records).toEqual([])
    expect(document.truncated).toBe(true)
  })
})
