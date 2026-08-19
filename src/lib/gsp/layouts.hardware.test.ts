import { describe, expect, it } from 'vitest'
import { decodePayload } from './layouts'

/**
 * Real payloads captured from a Movesense Flash sensor through the API explorer.
 *
 * These are the strongest tests in the project: not "our decoder agrees with our
 * assumptions" but "our decoder reproduces what the hardware actually sent, and
 * the values match the published API reference".
 */
function hex(text: string): Uint8Array {
  return new Uint8Array(
    text
      .trim()
      .split(/\s+/)
      .map((byte) => Number.parseInt(byte, 16)),
  )
}

const CAPTURES = {
  accInfo: '08 0d 00 1a 00 34 00 68 00 d0 00 a0 01 41 03 82 06 04 02 04 08 10',
  ecgInfo:
    '07 7d 00 80 00 c8 00 fa 00 00 01 f4 01 00 02 10 00 03 28 00 64 00 96 00 01 00 00 00 3f',
  imu9:
    '15 9e 01 00 5c 6e 61 bd 56 d2 9c bd 8c 2a 1d c1 ee 54 e6 bd cc d5 fe bc 8c 2a 1d c1 ' +
    'c9 87 dc bd 31 05 13 bd 27 3e 1d c1 cc d5 fe bd ec 06 44 bd f7 a9 1d c1 ' +
    '48 e1 fa 3f 8f c2 25 c0 c3 f5 68 3f 66 66 06 40 cd cc 1c c0 3e 0a 57 3f ' +
    '85 eb 01 40 cd cc 1c c0 3e 0a 57 3f 66 66 06 40 ae 47 21 c0 b8 1e 45 3f ' +
    '52 a8 6f 42 81 7b b0 c2 72 e8 5a 43 1b 6e 6a 42 f0 53 ac c2 4a dd 5a 43 ' +
    '77 70 6d 42 04 ec b1 c2 db 61 59 43 35 90 6f 42 0b 7e b0 c2 d2 34 5a 43',
  ecg:
    'c3 06 02 00 ba ff c5 ff c9 ff c5 ff c1 ff c2 ff c2 ff c2 ff ' +
    'c1 ff c1 ff c1 ff c6 ff cb ff d0 ff cf ff ca ff',
  temp: '8e 61 02 00 33 c3 95 43',
  gyroInfo: '08 0d 00 1a 00 34 00 68 00 d0 00 a0 01 41 03 82 06 05 7d 00 f5 00 f4 01 e8 03 d0 07',
  magnInfo: '08 0d 00 1a 00 34 00 68 00 d0 00 a0 01 41 03 82 06 01 88 13',
  hr: '83 c8 13 43 96 01',
  timeDetailed: '58 d8 97 e1 69 59 06 00 d0 89 24 00 00 04 00 00 14 00 00 00',
  imuInfo:
    '08 0d 00 1a 00 34 00 68 00 d0 00 a0 01 41 03 82 06 04 02 04 08 10 ' +
    '05 7d 00 f5 00 f4 01 e8 03 d0 07 01 88 13',
  ecgConfig: '28 00 00 00 00 3f',
  tempInfo: 'e9 00 00 00 8e 01 00 00 00 00 80 3f',
  hrInfo: 'c8 00 d0 07 00 00 a0 40',
}

describe('/Meas/Acc/Info, captured', () => {
  const result = decodePayload('/Meas/Acc/Info', hex(CAPTURES.accInfo))

  it('decodes exactly, with no bytes left over', () => {
    expect(result.best).not.toBeNull()
    expect(result.best!.consumed).toBe(22)
    expect(result.best!.layout.provenance).toBe('verified')
  })

  it('reports the eight documented sample rates and four G ranges', () => {
    expect(result.best!.value).toEqual({
      SampleRates: [13, 26, 52, 104, 208, 416, 833, 1666],
      Ranges: [2, 4, 8, 16],
    })
  })
})

describe('/Meas/ECG/Info, captured', () => {
  const result = decodePayload('/Meas/ECG/Info', hex(CAPTURES.ecgInfo))

  it('decodes exactly', () => {
    expect(result.best).not.toBeNull()
    expect(result.best!.consumed).toBe(29)
  })

  it('matches the API reference in every field', () => {
    expect(result.best!.value).toEqual({
      SampleRates: [125, 128, 200, 250, 256, 500, 512],
      ArraySize: 16,
      LowPassFilters: [40, 100, 150],
      HighPassFilters: [0.5],
    })
  })
})

describe('/Meas/IMU9/52, captured', () => {
  const result = decodePayload('/Meas/IMU9/52', hex(CAPTURES.imu9))

  it('decodes exactly, with no count prefixes', () => {
    // 4 timestamp bytes + 144 = 148. Three count prefixes would make it 151.
    expect(result.best).not.toBeNull()
    expect(result.best!.consumed).toBe(148)
  })

  it('finds four samples per sensor, stored array-major', () => {
    const value = result.best!.value as Record<
      string,
      Array<{ x: number; y: number; z: number }>
    >
    expect(result.best!.value.Timestamp).toBe(106005)
    for (const key of ['ArrayAcc', 'ArrayGyro', 'ArrayMagn']) {
      expect(value[key]).toHaveLength(4)
    }
  })

  it('puts gravity on the accelerometer, not on another sensor', () => {
    // The sensor was resting: one acc axis must read about -9.8 m/s2, and this is
    // what proves the acc block comes first rather than the gyro or magn block.
    const acc = result.best!.value.ArrayAcc as Array<{ x: number; y: number; z: number }>
    expect(acc[0]!.z).toBeCloseTo(-9.82, 1)
    expect(Math.abs(acc[0]!.x)).toBeLessThan(1)
    expect(Math.abs(acc[0]!.y)).toBeLessThan(1)
  })

  it('reads plausible gyroscope and magnetometer values', () => {
    const gyro = result.best!.value.ArrayGyro as Array<{ x: number; y: number }>
    const magn = result.best!.value.ArrayMagn as Array<{ z: number }>
    // Nearly still, so a couple of degrees per second.
    expect(Math.abs(gyro[0]!.x)).toBeLessThan(20)
    // Microtesla, so tens to low hundreds.
    expect(Math.abs(magn[0]!.z)).toBeGreaterThan(10)
    expect(Math.abs(magn[0]!.z)).toBeLessThan(1000)
  })
})

describe('/Meas/ECG/200/mV, captured', () => {
  const result = decodePayload('/Meas/ECG/200/mV', hex(CAPTURES.ecg))

  it('decodes as int16, not the float32 the docs describe', () => {
    // 4 + 16*4 = 68 bytes would be needed for floats; the sensor sent 36.
    expect(hex(CAPTURES.ecg)).toHaveLength(36)
    expect(result.best).not.toBeNull()
    expect(result.best!.consumed).toBe(36)
  })

  it('reads sixteen samples, matching ArraySize from /Meas/ECG/Info', () => {
    const samples = result.best!.value.Samples as number[]
    expect(samples).toHaveLength(16)
    expect(samples[0]).toBe(-70)
    expect(result.best!.value.Timestamp).toBe(132803)
  })

  it('names the unit microvolts, which was measured not assumed', () => {
    expect(result.best!.layout.name).toContain('microvolts')
    expect(result.best!.layout.note).toMatch(/MICROvolts/)
  })

  it('uses a different layout from the raw path, which is int32', () => {
    // The raw path sends 68-byte packets: uint32 timestamp + 16 int32. The 36-byte
    // /mV capture cannot fit that, so it must not be decoded as raw.
    const asRaw = decodePayload('/Meas/ECG/200', hex(CAPTURES.ecg))
    expect(asRaw.best!.layout.name).toContain('int32')
    expect(asRaw.best!.layout.name).not.toBe(result.best!.layout.name)
  })

  it('reproduces the measured microvolts-per-count ratio', () => {
    // Captured live with both ECG paths subscribed at once, comparing samples that
    // shared a timestamp. This is what settled the unit question.
    const rawCounts = [20835, 20488, 20147, 19833]
    const microvolts = [7948, 7816, 7685, 7566]
    const ECG_UV_PER_COUNT = 0.381469726563

    for (const [i, counts] of rawCounts.entries()) {
      expect(Math.round(counts * ECG_UV_PER_COUNT)).toBe(microvolts[i])
    }
  })
})

describe('/Meas/Temp, captured', () => {
  const result = decodePayload('/Meas/Temp', hex(CAPTURES.temp))

  it('reads a plausible room temperature in Kelvin', () => {
    expect(result.best!.value.Timestamp).toBe(156046)
    expect(result.best!.value.Measurement as number).toBeCloseTo(299.525, 3)
    // 26.4 C
    expect((result.best!.value.Measurement as number) - 273.15).toBeCloseTo(26.37, 1)
  })
})

describe('fill arrays refuse a payload they cannot divide', () => {
  it('rejects an IMU9 packet whose body is not a whole number of samples', () => {
    const truncated = hex(CAPTURES.imu9).subarray(0, 147)
    // 143 body bytes / 36 per sample is not an integer, so no layout applies.
    expect(decodePayload('/Meas/IMU9/52', truncated).best).toBeNull()
  })

  it('rejects an ECG packet with an odd number of body bytes', () => {
    const odd = hex(CAPTURES.ecg).subarray(0, 35)
    expect(decodePayload('/Meas/ECG/200/mV', odd).best).toBeNull()
  })

  it('accepts a different sample count, since the count is implied by length', () => {
    // Eight samples rather than sixteen: still valid, just a shorter packet.
    const eight = hex(CAPTURES.ecg).subarray(0, 4 + 8 * 2)
    const result = decodePayload('/Meas/ECG/200/mV', eight)
    expect((result.best!.value.Samples as number[])).toHaveLength(8)
  })
})

describe('/Meas/Gyro/Info and /Meas/Magn/Info, captured', () => {
  it('reads gyroscope ranges as uint16, including one the docs omit', () => {
    const result = decodePayload('/Meas/Gyro/Info', hex(CAPTURES.gyroInfo))
    expect(result.best!.consumed).toBe(28)
    expect(result.best!.value).toEqual({
      SampleRates: [13, 26, 52, 104, 208, 416, 833, 1666],
      // The API reference lists 245/500/1000/2000; the sensor also offers 125.
      Ranges: [125, 245, 500, 1000, 2000],
    })
  })

  it('reads the magnetometer single fixed range', () => {
    const result = decodePayload('/Meas/Magn/Info', hex(CAPTURES.magnInfo))
    expect(result.best!.consumed).toBe(20)
    // 5000 uT is the +/-50 gauss full scale, and matches the ~219 uT readings
    // seen in the IMU9 capture.
    expect(result.best!.value.Ranges).toEqual([5000])
  })

  it('picks the right range width per sensor from length alone', () => {
    // Accelerometer ranges are uint8, gyroscope and magnetometer uint16. Nothing
    // in the payload says which; only the exact-length check distinguishes them.
    const acc = decodePayload('/Meas/Acc/Info', hex(CAPTURES.accInfo))
    const gyro = decodePayload('/Meas/Gyro/Info', hex(CAPTURES.gyroInfo))
    expect(acc.best!.layout.name).toContain('byte ranges')
    expect(gyro.best!.layout.name).toContain('uint16 ranges')
  })
})

describe('/Meas/HR, captured', () => {
  const result = decodePayload('/Meas/HR', hex(CAPTURES.hr))

  it('reads an average and RR intervals with no count prefix', () => {
    // 4 + 2 = 6 bytes. A uint8 count would make 4 + 1 + 2n, which has no integer
    // solution at 6 - so the fill form is the only one that can fit.
    expect(result.best!.consumed).toBe(6)
    expect(result.best!.value.average as number).toBeCloseTo(147.783, 3)
    expect(result.best!.value.rrData).toEqual([406])
  })

  it('is verified, not inferred', () => {
    expect(result.best!.layout.provenance).toBe('verified')
  })
})

describe('/Time/Detailed, captured', () => {
  const result = decodePayload('/Time/Detailed', hex(CAPTURES.timeDetailed))

  it('reads all four documented fields, 20 bytes exactly', () => {
    expect(result.best!.consumed).toBe(20)
    expect(result.best!.value).toEqual({
      utcTime: 1787161151527000,
      relativeTime: 2394576,
      tickRate: 1024,
      accuracy: 20,
    })
  })

  it('decodes utcTime to a real wall-clock date', () => {
    // A wrong field offset would give a nonsense year, so this is corroboration
    // rather than decoration.
    const micros = result.best!.value.utcTime as number
    const when = new Date(micros / 1000)
    expect(when.getUTCFullYear()).toBe(2026)
    expect(when.toISOString()).toBe('2026-08-19T17:39:11.527Z')
  })

  it('reports a tick rate, which is what makes relativeTime interpretable', () => {
    const value = result.best!.value as Record<string, number>
    expect(value.tickRate).toBe(1024)
    // 2394576 ticks at 1024 Hz is 2338.5 s of uptime. Read as milliseconds it
    // would be 2394.6 s - 56 seconds out.
    expect(value.relativeTime! / value.tickRate!).toBeCloseTo(2338.45, 1)
  })
})

describe('Info and Config resources, captured', () => {
  it('reads the combined IMU capabilities, each range list in its own width', () => {
    const result = decodePayload('/Meas/IMU/Info', hex(CAPTURES.imuInfo))
    expect(result.best!.consumed).toBe(36)
    expect(result.best!.value).toEqual({
      SampleRates: [13, 26, 52, 104, 208, 416, 833, 1666],
      AccRanges: [2, 4, 8, 16],
      GyroRanges: [125, 245, 500, 1000, 2000],
      MagnRanges: [5000],
    })
  })

  it('reads the ECG filter configuration', () => {
    const result = decodePayload('/Meas/ECG/Config', hex(CAPTURES.ecgConfig))
    expect(result.best!.consumed).toBe(6)
    // Both values appear in the option lists /Meas/ECG/Info advertises.
    expect(result.best!.value).toEqual({ LowPassHz: 40, HighPassHz: 0.5 })
  })

  it('reads the temperature range as -40 to +125 C', () => {
    const result = decodePayload('/Meas/Temp/Info', hex(CAPTURES.tempInfo))
    expect(result.best!.consumed).toBe(12)
    const value = result.best!.value as Record<string, number>
    expect(value.MinKelvin! - 273.15).toBeCloseTo(-40.15, 1)
    expect(value.MaxKelvin! - 273.15).toBeCloseTo(124.85, 1)
    expect(value.Accuracy).toBe(1)
  })

  it('reads the heart-rate limits, and admits the field names are inferred', () => {
    const result = decodePayload('/Meas/HR/Info', hex(CAPTURES.hrInfo))
    expect(result.best!.consumed).toBe(8)
    expect(result.best!.value).toEqual({
      MinRrMs: 200,
      MaxRrMs: 2000,
      Accuracy: 5,
    })
    expect(result.best!.layout.note).toMatch(/NAMES are inferred/)
  })
})
