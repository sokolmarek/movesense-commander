import { describe, expect, it } from 'vitest'
import { ECG_RATES, IMU_RATES, MEASUREMENTS, measurementPath } from '@/lib/api/catalog'
import { TIME_DETAILED_PATH } from '@/lib/gsp/constants'
import {
  buildRecordingPlan,
  estimateThroughput,
  formatDataRate,
  formatDuration,
} from './config'

describe('catalog', () => {
  it('uses the documented rate lists', () => {
    expect(ECG_RATES).toEqual([125, 128, 200, 250, 256, 500, 512])
    expect(IMU_RATES).toEqual([13, 26, 52, 104, 208, 416, 833, 1666])
  })

  it('gives every measurement a unique id and a /Meas or /Algo path', () => {
    const ids = MEASUREMENTS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const measurement of MEASUREMENTS) {
      expect(measurement.basePath).toMatch(/^\/(Meas|Algo)\//)
      expect(measurement.bytesPerSample).toBeGreaterThan(0)
    }
  })

  it('builds ECG paths with the rate and the millivolt suffix', () => {
    const ecg = MEASUREMENTS.find((m) => m.id === 'ecg')!
    expect(measurementPath(ecg, 200)).toBe('/Meas/ECG/200/mV')
  })

  it('omits the rate for streams that have none in their path', () => {
    const temp = MEASUREMENTS.find((m) => m.id === 'temp')!
    expect(measurementPath(temp)).toBe('/Meas/Temp')
    const hr = MEASUREMENTS.find((m) => m.id === 'hr')!
    expect(measurementPath(hr)).toBe('/Meas/HR')
  })

  it('falls back to the default rate when none is given', () => {
    const acc = MEASUREMENTS.find((m) => m.id === 'acc')!
    expect(measurementPath(acc)).toBe('/Meas/Acc/52')
  })
})

describe('buildRecordingPlan', () => {
  it('is invalid with nothing selected, and writes no paths', () => {
    const plan = buildRecordingPlan([])
    expect(plan.valid).toBe(false)
    expect(plan.paths).toEqual([])
  })

  it('always appends /Time/Detailed, last', () => {
    const plan = buildRecordingPlan([{ measurementId: 'ecg', rate: 200 }])
    expect(plan.paths).toEqual(['/Meas/ECG/200/mV', TIME_DETAILED_PATH])
  })

  it('preserves selection order', () => {
    const plan = buildRecordingPlan([
      { measurementId: 'acc', rate: 52 },
      { measurementId: 'ecg', rate: 200 },
    ])
    expect(plan.paths).toEqual([
      '/Meas/Acc/52',
      '/Meas/ECG/200/mV',
      TIME_DETAILED_PATH,
    ])
  })

  it('drops duplicate paths', () => {
    const plan = buildRecordingPlan([
      { measurementId: 'acc', rate: 52 },
      { measurementId: 'acc', rate: 52 },
    ])
    expect(plan.paths).toEqual(['/Meas/Acc/52', TIME_DETAILED_PATH])
  })

  it('warns above the rate the upstream tool considers safe', () => {
    const safe = buildRecordingPlan([{ measurementId: 'ecg', rate: 200 }])
    expect(safe.warnings).toEqual([])

    const risky = buildRecordingPlan([{ measurementId: 'ecg', rate: 512 }])
    expect(risky.warnings.map((w) => w.level)).toContain('warning')
    expect(risky.warnings[0]!.message).toContain('512 Hz')
  })

  it('warns past three measurements without blocking, since the limit is unverified', () => {
    const plan = buildRecordingPlan([
      { measurementId: 'ecg', rate: 200 },
      { measurementId: 'acc', rate: 52 },
      { measurementId: 'gyro', rate: 52 },
      { measurementId: 'magn', rate: 52 },
    ])
    expect(plan.valid).toBe(true)
    expect(plan.warnings.some((w) => w.message.includes('4 measurements'))).toBe(true)
  })

  it('does not count /Time/Detailed toward the measurement limit', () => {
    const plan = buildRecordingPlan([
      { measurementId: 'ecg', rate: 200 },
      { measurementId: 'acc', rate: 52 },
      { measurementId: 'gyro', rate: 52 },
    ])
    expect(plan.paths).toHaveLength(4)
    expect(plan.warnings.some((w) => w.message.includes('measurements selected'))).toBe(
      false,
    )
  })

  it('flags an unknown measurement instead of writing a broken path', () => {
    const plan = buildRecordingPlan([{ measurementId: 'nope' }])
    expect(plan.valid).toBe(false)
    expect(plan.warnings[0]!.message).toContain('Unknown measurement')
    expect(plan.paths).toEqual([])
  })

  it('says when the data rate relies on an assumed cadence', () => {
    const plan = buildRecordingPlan([{ measurementId: 'temp' }])
    expect(plan.throughput.hasAssumedRates).toBe(true)
    expect(plan.warnings.some((w) => w.level === 'info')).toBe(true)
  })
})

describe('estimateThroughput', () => {
  it('scales with rate and record size, plus SBEM overhead', () => {
    // ECG: 200 Hz x 4 bytes = 800 B/s, x1.1 overhead.
    expect(estimateThroughput([{ measurementId: 'ecg', rate: 200 }])).toMatchObject({
      bytesPerSecond: 880,
      hasAssumedRates: false,
    })
  })

  it('adds up across streams', () => {
    const single = estimateThroughput([{ measurementId: 'acc', rate: 52 }])
    const double = estimateThroughput([
      { measurementId: 'acc', rate: 52 },
      { measurementId: 'gyro', rate: 52 },
    ])
    // Rounding is applied to the total, not per stream, so doubling is exact
    // only to within a byte.
    expect(double.bytesPerSecond).toBeCloseTo(single.bytesPerSecond * 2, -1)
    expect(double.bytesPerSecond).toBeGreaterThan(single.bytesPerSecond)
  })

  it('is zero with nothing selected', () => {
    expect(estimateThroughput([]).bytesPerSecond).toBe(0)
  })
})

describe('formatting', () => {
  it('formats data rates', () => {
    expect(formatDataRate(0)).toBe('0 B/s')
    expect(formatDataRate(880)).toBe('880 B/s')
    expect(formatDataRate(2048)).toBe('2.0 kB/s')
  })

  it('formats durations, dropping hours until they matter', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })
})
