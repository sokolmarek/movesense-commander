import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeSbem, type SbemDocument } from '@/lib/sbem/decode'
import { extractSamples, toUtcMillis } from '@/lib/sbem/samples'
import type { SampleSeries } from '@/lib/sbem/samples'
import { csvFileName, seriesToCsv } from './csv'
import { buildEdf, dimensionFor, formatEdfNumber, seriesToSignals } from './edf'
import { toJson, toJsonLines } from './json'
import { createZip, crc32 } from './zip'

function fixture(): Uint8Array {
  const path = fileURLToPath(
    new URL('../sbem/__fixtures__/imu9-prefix.sbem', import.meta.url),
  )
  return new Uint8Array(readFileSync(path))
}

const document = decodeSbem(fixture())

function series(overrides: Partial<SampleSeries> = {}): SampleSeries {
  return {
    key: 'MeasECG',
    stream: 'MeasECG',
    channel: null,
    columns: ['value'],
    timestamps: [0, 5, 10, 15],
    values: [[1, 2, 3, 4]],
    estimatedRateHz: 200,
    filledSamples: 0,
    scale: null,
    ...overrides,
  }
}

describe('extractSamples', () => {
  const set = extractSamples(document)

  it('splits an IMU9 chunk into one series per sensor', () => {
    expect(set.series.map((s) => s.key).sort()).toEqual([
      'MeasHR',
      'MeasIMU9.Acc',
      'MeasIMU9.Gyro',
      'MeasIMU9.Magn',
    ])
  })

  it('interpolates a timestamp per sample, not per chunk', () => {
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    // 39 chunks of four samples.
    expect(acc.timestamps).toHaveLength(39 * 4)
    expect(acc.values).toHaveLength(3)
    expect(acc.values[0]).toHaveLength(39 * 4)

    // Chunks are stamped from 866085854 onwards. The step comes from the median
    // chunk spacing over the whole stream, not from the first pair, so it lands
    // on a clean 20 ms rather than the 19.75 ms the first two chunks suggest.
    expect(acc.timestamps[0]).toBe(866085854)
    expect(acc.estimatedRateHz).toBe(50)
    expect(acc.timestamps[1]! - acc.timestamps[0]!).toBeCloseTo(
      1000 / acc.estimatedRateHz!,
      6,
    )
  })

  it('estimates a plausible IMU rate', () => {
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    // 79 ms per four samples is about 50.6 Hz - a 52 Hz configuration.
    expect(acc.estimatedRateHz).toBeGreaterThan(45)
    expect(acc.estimatedRateHz).toBeLessThan(55)
  })

  it('keeps x, y and z as columns of one series', () => {
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    expect(acc.columns).toEqual(['x', 'y', 'z'])
    // y is dominated by gravity in this recording.
    expect(acc.values[1]![0]).toBeGreaterThan(9)
  })

  it('times heart rate by cumulative RR interval, not by sample rate', () => {
    const hr = set.series.find((s) => s.key === 'MeasHR')!
    expect(hr.columns).toEqual(['average', 'rrInterval'])
    expect(hr.estimatedRateHz).toBeNull()
    expect(hr.timestamps[0]).toBe(0)
  })

  it('has no time anchor when the log carries no /Time/Detailed record', () => {
    // This fixture is IMU9 and HR only, so there is nothing to anchor to and we
    // must not invent one.
    expect(set.anchor).toBeNull()
    expect(toUtcMillis(set.anchor, 1000)).toBeNull()
  })

  it('converts sensor time to UTC when an anchor exists', () => {
    const anchor = {
      utcMicros: 1_700_000_000_000_000,
      relativeMs: 500,
      tickRate: null,
    }
    expect(toUtcMillis(anchor, 1500)).toBe(1_700_000_000_000 + 1000)
  })

  it('ignores tickRate, because relativeTime is already milliseconds', () => {
    // tickRate reads 1024 on hardware, but relativeTime was measured advancing at
    // exactly 1000 per second. Dividing by tickRate here would shift the wall
    // clock by 2.4%.
    const anchor = {
      utcMicros: 1_700_000_000_000_000,
      relativeMs: 1000,
      tickRate: 1024,
    }
    expect(toUtcMillis(anchor, 2000)).toBe(1_700_000_000_000 + 1000)

    const withoutTickRate = { ...anchor, tickRate: null }
    expect(toUtcMillis(withoutTickRate, 2000)).toBe(toUtcMillis(anchor, 2000))
  })
})

/** A hand-built document, so gaps can be placed exactly where a test needs them. */
function ecgDocument(timestamps: number[], samplesPerChunk = 2): SbemDocument {
  return {
    header: 'SBEM0112',
    rootName: 'Samples',
    records: timestamps.map((timestamp, chunk) => ({
      dataId: 104,
      stream: 'MeasECG',
      value: {
        MeasECG: {
          Timestamp: timestamp,
          Samples: Array.from(
            { length: samplesPerChunk },
            (_, i) => chunk * samplesPerChunk + i,
          ),
        },
      },
    })),
    streams: [],
    warnings: [],
    truncated: false,
    skipped: [],
    scales: {},
  }
}

describe('gap filling', () => {
  it('is off unless asked for', () => {
    // The fixture is continuous anyway, so this also guards against a detector
    // that fires on evenly spaced data.
    const set = extractSamples(document, {})
    for (const entry of set.series) expect(entry.filledSamples).toBe(0)

    const gappy = extractSamples(ecgDocument([0, 10, 40, 50]))
    expect(gappy.series[0]!.filledSamples).toBe(0)
  })

  it('does not fill an evenly spaced series', () => {
    const set = extractSamples(ecgDocument([0, 10, 20, 30]), { fillGaps: true })
    expect(set.series[0]!.filledSamples).toBe(0)
    expect(set.series[0]!.timestamps).toHaveLength(8)
  })

  it('bridges missing chunks with the fill value', () => {
    // Two samples per chunk at 5 ms each, so chunks should start at
    // 0, 10, 20, 30, 40, 50. The ones at 20 and 30 never arrived: four samples
    // missing.
    const set = extractSamples(ecgDocument([0, 10, 40, 50]), {
      fillGaps: true,
      fillValue: -1.5,
    })
    const ecg = set.series[0]!

    expect(ecg.filledSamples).toBe(4)
    expect(ecg.timestamps).toHaveLength(12)
    // Filled samples sit at the expected cadence, carrying the fill value.
    expect(ecg.timestamps.slice(4, 8)).toEqual([20, 25, 30, 35])
    expect(ecg.values[0]!.slice(4, 8)).toEqual([-1.5, -1.5, -1.5, -1.5])
    // Real samples resume after them.
    expect(ecg.timestamps[8]).toBe(40)
    expect(ecg.values[0]![8]).toBe(4)
  })

  it('keeps the sample interval stable across a gap', () => {
    // The gap must not inflate the estimated rate: 5 ms per sample means 200 Hz,
    // whether or not a chunk is missing.
    const gappy = extractSamples(ecgDocument([0, 10, 40, 50]))
    expect(gappy.series[0]!.estimatedRateHz).toBeCloseTo(200, 6)
    const clean = extractSamples(ecgDocument([0, 10, 20, 30]))
    expect(clean.series[0]!.estimatedRateHz).toBeCloseTo(200, 6)
  })
})

describe('JSON export', () => {
  it('emits one object per record under the container name', () => {
    const parsed = JSON.parse(toJson(document)) as {
      header: string
      Samples: unknown[]
    }
    expect(parsed.header).toBe('SBEM0112')
    expect(parsed.Samples).toHaveLength(40)
  })

  it('emits one line per record in JSONL', () => {
    const lines = toJsonLines(document).split('\n')
    expect(lines).toHaveLength(40)
    expect(JSON.parse(lines[0]!)).toHaveProperty('MeasIMU9')
  })
})

describe('CSV export', () => {
  it('writes a header and one row per sample', () => {
    const csv = seriesToCsv(series())
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('Timestamp_ms,value')
    expect(lines).toHaveLength(5)
    expect(lines[1]).toBe('0,1')
  })

  it('adds a UTC column only when there is an anchor', () => {
    const withAnchor = seriesToCsv(series(), {
      anchor: {
        utcMicros: 1_700_000_000_000_000,
        relativeMs: 0,
        tickRate: null,
      },
    })
    expect(withAnchor.split('\n')[0]).toBe('Timestamp_ms,value,UTC_ISO')
    expect(withAnchor.split('\n')[1]).toContain('2023-11-14T')

    expect(seriesToCsv(series(), { anchor: null }).split('\n')[0]).toBe(
      'Timestamp_ms,value',
    )
  })

  it('writes three columns for a three-axis series', () => {
    const set = extractSamples(document)
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    const lines = seriesToCsv(acc).trimEnd().split('\n')
    expect(lines[0]).toBe('Timestamp_ms,x,y,z')
    expect(lines[1]!.split(',')).toHaveLength(4)
  })

  it('leaves a missing value empty rather than writing NaN', () => {
    const csv = seriesToCsv(series({ values: [[1, Number.NaN, 3, 4]] }))
    expect(csv.split('\n')[2]).toBe('5,')
  })

  it('names files per stream and channel', () => {
    const set = extractSamples(document)
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    expect(csvFileName(acc, { serial: '174630000192', logId: 3 })).toBe(
      'Movesense_log_3_174630000192_MeasIMU9_Acc.csv',
    )
  })
})

describe('ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    // Known-answer test: CRC32("123456789") == 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes local headers, a central directory and an end record', () => {
    const data = new TextEncoder().encode('a,b\n1,2\n')
    const zip = createZip([{ name: 'test.csv', data }], new Date(2026, 0, 2, 3, 4, 5))

    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50) // local header
    expect(zip.length).toBeGreaterThan(data.length)

    // End-of-central-directory record is the last 22 bytes.
    const endOffset = zip.length - 22
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50)
    expect(view.getUint16(endOffset + 10, true)).toBe(1) // one entry
  })

  it('is reproducible for the same input and timestamp', () => {
    const entry = { name: 'x.txt', data: new Uint8Array([1, 2, 3]) }
    const stamp = new Date(2026, 5, 6, 7, 8, 9)
    expect(createZip([entry], stamp)).toEqual(createZip([entry], stamp))
  })
})

describe('EDF+ writer', () => {
  it('fits numbers into the 8-character header fields', () => {
    expect(formatEdfNumber(1)).toBe('1')
    expect(formatEdfNumber(-1.5)).toBe('-1.50000')
    expect(formatEdfNumber(0.000381469726563).length).toBeLessThanOrEqual(8)
    expect(formatEdfNumber(-12345.6789).length).toBeLessThanOrEqual(8)
  })

  it('labels units it knows and leaves the rest blank', () => {
    expect(dimensionFor(series({ stream: 'MeasECG' }))).toBe('mV')
    expect(dimensionFor(series({ stream: 'MeasIMU9', channel: 'Acc' }))).toBe('m/s2')
    expect(dimensionFor(series({ stream: 'MeasQuux', channel: 'Quux' }))).toBe('')
  })

  it('makes one signal per column', () => {
    const set = extractSamples(document)
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    const { signals } = seriesToSignals([acc], 1)
    expect(signals.map((s) => s.label)).toEqual(['Acc x', 'Acc y', 'Acc z'])
  })

  it('refuses a stream with no fixed rate, and says why', () => {
    const set = extractSamples(document)
    const hr = set.series.find((s) => s.key === 'MeasHR')!
    const { signals, skipped } = seriesToSignals([hr], 1)
    expect(signals).toEqual([])
    expect(skipped[0]!.reason).toMatch(/no sample rate/)
  })

  it('writes a header of 256 bytes per signal plus one', () => {
    const set = extractSamples(document)
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    const result = buildEdf([acc], { startTime: new Date(2026, 0, 2, 3, 4, 5) })

    expect(result.records).toBeGreaterThan(0)
    // 3 axis signals + 1 annotation signal = 4, so 5 x 256 bytes of header.
    const headerBytes = Number(
      new TextDecoder('ascii').decode(result.bytes.subarray(184, 192)).trim(),
    )
    expect(headerBytes).toBe(256 * 5)
    expect(new TextDecoder('ascii').decode(result.bytes.subarray(192, 197))).toBe(
      'EDF+C',
    )
  })

  it('produces nothing rather than a malformed file when there is no usable data', () => {
    const result = buildEdf([series({ estimatedRateHz: null })])
    expect(result.bytes).toHaveLength(0)
    expect(result.records).toBe(0)
    expect(result.skipped).not.toEqual([])
  })

  it('drops the tail that does not fill a whole record', () => {
    // 250 samples at 200 Hz is one full 1-second record plus 50 spare.
    const partial = series({
      timestamps: Array.from({ length: 250 }, (_, i) => i * 5),
      values: [Array.from({ length: 250 }, (_, i) => i)],
    })
    expect(buildEdf([partial]).records).toBe(1)
  })
})

describe('EDF+ identification fields', () => {
  it('formats dates as dd-MMM-yyyy, which is what EDF+ readers require', async () => {
    const { edfPlusDate, patientField, recordingField } = await import('./edf')
    expect(edfPlusDate(new Date(2026, 0, 2))).toBe('02-JAN-2026')
    expect(patientField({ name: 'Test Subject', sex: 'X' })).toBe('X X X Test_Subject')
    expect(recordingField(new Date(2026, 0, 2), { equipment: 'Movesense Flash' })).toBe(
      'Startdate 02-JAN-2026 X X Movesense_Flash',
    )
  })

  it('reports a rate it had to round for EDF', () => {
    // EDF stores a whole number of samples per record, so a fractional rate has
    // to move. 50.63 Hz becomes 51 Hz, and the user is told.
    const odd = series({
      estimatedRateHz: 50.63,
      timestamps: Array.from({ length: 200 }, (_, i) => i * 19.75),
      values: [Array.from({ length: 200 }, (_, i) => i / 100)],
    })
    expect(buildEdf([odd]).notes.join(' ')).toContain('written as 51 Hz')
  })

  it('says nothing when the rate fits exactly', () => {
    const set = extractSamples(document)
    const acc = set.series.find((s) => s.key === 'MeasIMU9.Acc')!
    expect(acc.estimatedRateHz).toBe(50)
    expect(buildEdf([acc]).notes).toEqual([])
  })
})
