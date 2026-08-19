import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeSbem, type SbemObject } from './decode'
import { parseModifierScale } from './descriptors'
import { extractSamples, toUtcMillis } from './samples'

/**
 * A real recording made on a Movesense Flash: ECG at 200 Hz plus
 * `/Time/Detailed`, configured and downloaded over GSP, 5272 bytes.
 *
 * `ecg-flash-log.expected.json` is the output of Movesense's own `sbem2json` on
 * this exact file, so the assertions below compare our decoder against the
 * reference implementation on real data rather than against our own reasoning.
 */
function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url))),
  )
}

interface ReferenceJson {
  Samples: Array<Record<string, { Samples?: number[]; [key: string]: unknown }>>
}

const reference: ReferenceJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/ecg-flash-log.expected.json', import.meta.url)),
    'utf8',
  ),
)

const document = decodeSbem(fixture('ecg-flash-log.sbem'))

describe('a real Movesense Flash ECG log', () => {
  it('parses cleanly: nothing skipped, nothing truncated, no warnings', () => {
    expect(document.header).toBe('SBEM0112')
    expect(document.truncated).toBe(false)
    expect(document.skipped).toEqual([])
    // No byte in the ambiguous 0xAD..0xFE escape range, so the two possible
    // readings of the escape sentinel agree on this file.
    expect(document.warnings).toEqual([])
  })

  it('finds the same records as the reference tool, in the same order', () => {
    expect(document.records).toHaveLength(reference.Samples.length)
    expect(document.records.map((record) => record.stream)).toEqual(
      reference.Samples.map((sample) => Object.keys(sample)[0]!),
    )
  })

  it('agrees with the reference tool on every ECG sample', () => {
    let compared = 0
    document.records.forEach((record, index) => {
      if (record.stream !== 'MeasECGmV') return
      const ours = (record.value.MeasECGmV as SbemObject).Samples as number[]
      const theirs = reference.Samples[index]!.MeasECGmV!.Samples as number[]
      expect(ours).toEqual(theirs)
      compared += ours.length
    })
    // 127 chunks of 16 samples.
    expect(compared).toBe(2032)
  })

  it('summarises the two streams the recording was configured with', () => {
    expect(document.streams.map((s) => s.stream)).toEqual([
      'TimeDetailed',
      'MeasECGmV',
    ])
    const ecg = document.streams.find((s) => s.stream === 'MeasECGmV')!
    expect(ecg.records).toBe(127)
    expect(ecg.samples).toBe(2032)
  })
})

describe('the descriptor states its own unit', () => {
  it('reads the decode factor out of the MOD expression', () => {
    // Verbatim from this log's ECG descriptor.
    expect(
      parseModifierScale('x*0.001,roundf(MIN(+32.767f,MAX(y,-32.767f))*1000.0f)'),
    ).toBe(0.001)
    expect(parseModifierScale(undefined)).toBeNull()
    expect(parseModifierScale('something else')).toBeNull()
  })

  it('exposes the ECG scale, keyed by stream and field', () => {
    expect(document.scales).toEqual({ 'MeasECGmV.Samples': 0.001 })
  })

  it('leaves decoded records unscaled, so they still match the reference', () => {
    const first = document.records.find((r) => r.stream === 'MeasECGmV')!
    const samples = (first.value.MeasECGmV as SbemObject).Samples as number[]
    // Stored microvolts, exactly as the reference tool reports them.
    expect(samples.slice(0, 5)).toEqual([0, 0, 0, -1, -21])
  })

  it('applies the scale when extracting samples, giving millivolts', () => {
    const set = extractSamples(document)
    const ecg = set.series.find((s) => s.stream === 'MeasECGmV')!
    expect(ecg.scale).toBe(0.001)
    expect(ecg.values[0]!.slice(0, 5)).toEqual([0, 0, 0, -0.001, -0.021])
  })
})

describe('timing on the real log', () => {
  const set = extractSamples(document)
  const ecg = set.series.find((s) => s.stream === 'MeasECGmV')!

  it('recovers the configured 200 Hz exactly', () => {
    // The recording was configured as /Meas/ECG/200/mV, and the median-interval
    // estimator has to land on it from per-chunk timestamps alone.
    expect(ecg.estimatedRateHz).toBe(200)
    expect(ecg.timestamps).toHaveLength(2032)
  })

  it('spaces samples 5 ms apart', () => {
    expect(ecg.timestamps[1]! - ecg.timestamps[0]!).toBeCloseTo(5, 9)
  })

  it('reads the time anchor, which carries no tick rate in a log', () => {
    // The GSP resource has a tickRate field; the logged record has only
    // relativeTime and utcTime. Both are milliseconds regardless.
    expect(set.anchor).toEqual({
      utcMicros: 1787165109516000,
      relativeMs: 24583,
      tickRate: null,
    })
  })

  it('anchors sample time to a wall clock within milliseconds of the log', () => {
    // relativeTime 24583 and the first ECG timestamp 24586 are 3 ms apart, which
    // is only true because both are in the same unit.
    const utc = toUtcMillis(set.anchor, ecg.timestamps[0]!)!
    expect(new Date(utc).toISOString()).toBe('2026-08-19T18:45:09.519Z')
  })
})
