import { describe, expect, it } from 'vitest'
import {
  decodePayload,
  decodeWithLayout,
  fixedSize,
  layoutsFor,
  type Layout,
} from './layouts'

/** Build a payload from a little-endian field description. */
function bytes(...parts: Array<[type: string, value: number]>): Uint8Array {
  const sizes: Record<string, number> = {
    u8: 1,
    i16: 2,
    u16: 2,
    u32: 4,
    i32: 4,
    f32: 4,
    u64: 8,
  }
  const total = parts.reduce((sum, [type]) => sum + sizes[type]!, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let at = 0
  for (const [type, value] of parts) {
    switch (type) {
      case 'u8':
        view.setUint8(at, value)
        break
      case 'i16':
        view.setInt16(at, value, true)
        break
      case 'u16':
        view.setUint16(at, value, true)
        break
      case 'u32':
        view.setUint32(at, value, true)
        break
      case 'i32':
        view.setInt32(at, value, true)
        break
      case 'f32':
        view.setFloat32(at, value, true)
        break
      case 'u64':
        view.setBigUint64(at, BigInt(value), true)
        break
    }
    at += sizes[type]!
  }
  return out
}

describe('layout registry', () => {
  it('matches measurement paths regardless of rate', () => {
    expect(layoutsFor('/Meas/IMU9/52')).toHaveLength(1)
    expect(layoutsFor('/Meas/IMU9/833')).toHaveLength(1)
    expect(layoutsFor('/Meas/Acc/13')).toHaveLength(1)
  })

  it('gives the two ECG paths different layouts, because they differ', () => {
    // Hardware: raw is 68-byte int32 packets, /mV is 36-byte int16 in microvolts.
    const mv = layoutsFor('/Meas/ECG/200/mV')[0]!
    const raw = layoutsFor('/Meas/ECG/200')[0]!
    expect(mv).not.toBe(raw)
    expect(mv.name).toContain('int16')
    expect(raw.name).toContain('int32')
  })

  it('has layouts for the Info resources', () => {
    expect(layoutsFor('/Meas/Acc/Info').length).toBeGreaterThan(0)
    expect(layoutsFor('/Meas/ECG/Info')).toHaveLength(1)
  })

  it('gives /Meas/IMU/Info its own layout rather than the single-sensor one', () => {
    // It carries three range lists, so it cannot share the Acc/Gyro/Magn shape.
    // The registry returns the first matching pattern, so ordering matters here.
    const imu = layoutsFor('/Meas/IMU/Info')
    expect(imu).toHaveLength(1)
    expect(imu[0]!.name).toContain('Combined')
    expect(layoutsFor('/Meas/Acc/Info')[0]!.name).not.toContain('Combined')
  })

  it('has nothing for an unknown path, rather than a fallback that might fit', () => {
    expect(layoutsFor('/Meas/Nonsense/7')).toEqual([])
    expect(layoutsFor('/Info')).toEqual([])
  })

  it('labels every layout with where it came from', () => {
    for (const path of [
      '/System/Energy/Level',
      '/Meas/IMU9/52',
      '/Meas/HR',
      '/Time',
      '/Time/Detailed',
    ]) {
      for (const layout of layoutsFor(path)) {
        expect(['verified', 'derived', 'documented', 'guess']).toContain(
          layout.provenance,
        )
        expect(layout.note.length).toBeGreaterThan(10)
      }
    }
  })

  it('computes a fixed size only when there is no array', () => {
    expect(fixedSize(layoutsFor('/Time')[0]!.fields)).toBe(8)
    expect(fixedSize(layoutsFor('/Meas/IMU9/52')[0]!.fields)).toBeNull()
  })
})

describe('decoding', () => {
  it('reads a single-byte payload', () => {
    const result = decodePayload('/System/Energy/Level', new Uint8Array([87]))
    expect(result.best?.value).toEqual({ percent: 87 })
    expect(result.best?.exact).toBe(true)
  })

  it('reads a timestamp and an array of triples that fills the packet', () => {
    // No count prefix: the sample count is implied by the payload length.
    const payload = bytes(
      ['u32', 1000],
      ['f32', 1],
      ['f32', 2],
      ['f32', 3],
      ['f32', 4],
      ['f32', 5],
      ['f32', 6],
    )
    const result = decodePayload('/Meas/Acc/52', payload)

    expect(result.best).not.toBeNull()
    expect(result.best!.value).toEqual({
      Timestamp: 1000,
      samples: [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
      ],
    })
  })

  it('splits a filled IMU9 packet array-major across the three sensors', () => {
    const triple = (base: number) =>
      [
        ['f32', base] as [string, number],
        ['f32', base + 1] as [string, number],
        ['f32', base + 2] as [string, number],
      ] satisfies Array<[string, number]>

    const payload = bytes(['u32', 5], ...triple(1), ...triple(10), ...triple(20))

    const result = decodePayload('/Meas/IMU9/52', payload)
    expect(result.best!.value).toEqual({
      Timestamp: 5,
      ArrayAcc: [{ x: 1, y: 2, z: 3 }],
      ArrayGyro: [{ x: 10, y: 11, z: 12 }],
      ArrayMagn: [{ x: 20, y: 21, z: 22 }],
    })
  })

  it('reads a scalar array as plain values, not objects', () => {
    const payload = bytes(['u32', 7], ['i16', -1], ['i16', 0], ['i16', 1])
    const result = decodePayload('/Meas/ECG/200/mV', payload)
    expect(result.best!.value).toEqual({ Timestamp: 7, Samples: [-1, 0, 1] })
  })

  it('reads the raw ECG path as int32', () => {
    const payload = bytes(['u32', 7], ['i32', 20835], ['i32', -20488])
    const result = decodePayload('/Meas/ECG/200', payload)
    expect(result.best!.value).toEqual({ Timestamp: 7, Samples: [20835, -20488] })
  })

  it('reads a count-prefixed array where Info resources use one', () => {
    // Info resources do prefix their arrays; measurement streams do not.
    const payload = bytes(['u8', 2], ['u16', 13], ['u16', 26], ['u8', 1], ['u8', 4])
    const result = decodePayload('/Meas/Acc/Info', payload)
    expect(result.best!.value).toEqual({ SampleRates: [13, 26], Ranges: [4] })
  })

  it('refuses a filled array whose body is not a whole number of samples', () => {
    // One trailing byte means the field order is wrong, however sane the numbers.
    const payload = bytes(['u32', 1000], ['f32', 1], ['f32', 2], ['f32', 3])
    const withExtra = new Uint8Array(payload.length + 1)
    withExtra.set(payload)

    const result = decodePayload('/Meas/Acc/52', withExtra)
    expect(result.best).toBeNull()
    // The fill field bails before producing a value, so there is no partial
    // attempt to report - only that a candidate existed and did not fit.
    expect(result.candidatesTried).toBe(1)
    expect(result.attempts).toEqual([])
  })

  it('reports a partial attempt for a fixed-size layout that leaves bytes over', () => {
    const payload = bytes(['u32', 12], ['f32', 296.5], ['u32', 99])
    const result = decodePayload('/Meas/Temp', payload)
    expect(result.best).toBeNull()
    expect(result.attempts.length).toBeGreaterThan(0)
    expect(result.attempts[0]!.exact).toBe(false)
    expect(result.attempts[0]!.consumed).toBe(8)
  })

  it('reports no attempt at all when the payload is too short', () => {
    const result = decodePayload('/Meas/IMU9/52', new Uint8Array([1, 2]))
    expect(result.best).toBeNull()
    expect(result.attempts).toEqual([])
    expect(result.candidatesTried).toBe(1)
  })

  it('picks the candidate that fits when a path has several', () => {
    // Temperature has a with-timestamp and a value-only candidate.
    const valueOnly = decodePayload('/Meas/Temp', bytes(['f32', 296.5]))
    expect(valueOnly.best!.layout.name).toContain('value only')
    expect(valueOnly.best!.value).toMatchObject({ Measurement: 296.5 })

    const withTimestamp = decodePayload('/Meas/Temp', bytes(['u32', 12], ['f32', 296.5]))
    expect(withTimestamp.best!.layout.name).toBe('Temperature')
    expect(withTimestamp.best!.value).toMatchObject({ Timestamp: 12 })
  })

  it('gives nothing for a path with no layout, leaving hex as the answer', () => {
    const result = decodePayload('/Info', new Uint8Array([1, 2, 3]))
    expect(result.candidatesTried).toBe(0)
    expect(result.best).toBeNull()
  })

  it('decodes an explicit layout including strings', () => {
    const layout: Layout = {
      name: 'test',
      provenance: 'guess',
      note: 'a test layout with a string field',
      fields: [
        { kind: 'scalar', name: 'version', type: 'uint8' },
        { kind: 'string', name: 'serial' },
      ],
    }
    const payload = new Uint8Array([2, 65, 66, 0])
    const attempt = decodeWithLayout(payload, layout)!
    expect(attempt.value).toEqual({ version: 2, serial: 'AB' })
    expect(attempt.exact).toBe(true)
  })
})
