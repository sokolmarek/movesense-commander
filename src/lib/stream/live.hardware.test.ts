import { describe, expect, it } from 'vitest'
import { LiveStream } from './live'

/**
 * Real subscription packets, captured from a Movesense Flash through the API
 * explorer and a direct BLE client.
 *
 * The packet bodies are genuine hardware bytes; only the timestamps are stepped,
 * so this exercises the real layouts, channel splitting and unit conversions. It
 * does not reproduce BLE jitter - that part still needs a live sensor.
 */
const hex = (text: string) =>
  new Uint8Array(text.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)))

const IMU9 = hex(
  '15 9e 01 00 5c 6e 61 bd 56 d2 9c bd 8c 2a 1d c1 ee 54 e6 bd cc d5 fe bc 8c 2a 1d c1 ' +
    'c9 87 dc bd 31 05 13 bd 27 3e 1d c1 cc d5 fe bd ec 06 44 bd f7 a9 1d c1 ' +
    '48 e1 fa 3f 8f c2 25 c0 c3 f5 68 3f 66 66 06 40 cd cc 1c c0 3e 0a 57 3f ' +
    '85 eb 01 40 cd cc 1c c0 3e 0a 57 3f 66 66 06 40 ae 47 21 c0 b8 1e 45 3f ' +
    '52 a8 6f 42 81 7b b0 c2 72 e8 5a 43 1b 6e 6a 42 f0 53 ac c2 4a dd 5a 43 ' +
    '77 70 6d 42 04 ec b1 c2 db 61 59 43 35 90 6f 42 0b 7e b0 c2 d2 34 5a 43',
)

const ECG_MV = hex(
  'c3 06 02 00 ba ff c5 ff c9 ff c5 ff c1 ff c2 ff c2 ff c2 ff ' +
    'c1 ff c1 ff c1 ff c6 ff cb ff d0 ff cf ff ca ff',
)

function stamped(packet: Uint8Array, timestamp: number): Uint8Array {
  const copy = new Uint8Array(packet)
  new DataView(copy.buffer).setUint32(0, timestamp, true)
  return copy
}

describe('IMU9 replay', () => {
  const stream = new LiveStream('/Meas/IMU9/52')
  // 4 samples per packet at 52 Hz is 76.92 ms between packets.
  for (let i = 0; i < 40; i++) {
    stream.push(stamped(IMU9, 1000 + Math.round((i * 4000) / 52)))
  }
  const state = stream.getSnapshot()

  it('splits into three channels with their measured units', () => {
    expect(state.channels.map((c) => c.label)).toEqual(['Acc', 'Gyro', 'Magn'])
    expect(state.channels.map((c) => c.unit.unit)).toEqual(['m/s²', 'dps', 'µT'])
  })

  it('counts four samples per packet', () => {
    expect(state.packets).toBe(40)
    expect(state.samples).toBe(160)
    for (const channel of state.channels) expect(channel.time).toHaveLength(160)
  })

  it('puts gravity on the accelerometer', () => {
    const acc = state.channels.find((c) => c.label === 'Acc')!
    expect(acc.values[2]![0]).toBeCloseTo(-9.823, 3)
  })

  it('recovers a rate close to the 52 Hz requested', () => {
    expect(state.measuredHz).toBeGreaterThan(51)
    expect(state.measuredHz).toBeLessThan(53)
    expect(state.droppedSamples).toBe(0)
  })
})

describe('ECG replay', () => {
  it('converts microvolts to millivolts and recovers 200 Hz exactly', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    // 16 samples per packet at 200 Hz is 80 ms.
    for (let i = 0; i < 40; i++) stream.push(stamped(ECG_MV, 1000 + i * 80))

    const state = stream.getSnapshot()
    expect(state.samples).toBe(640)
    expect(state.measuredHz).toBeCloseTo(200, 6)

    const channel = state.channels[0]!
    expect(channel.unit).toEqual({ scale: 0.001, unit: 'mV' })
    // -70 microvolts as stored, so -0.07 mV.
    expect(channel.values[0]![0]).toBeCloseTo(-0.07, 6)
  })

  it('reports exactly one packet of samples when one packet is lost', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    for (let i = 0; i < 40; i++) {
      if (i === 20) continue // this packet never arrives
      stream.push(stamped(ECG_MV, 1000 + i * 80))
    }
    const state = stream.getSnapshot()
    expect(state.packets).toBe(39)
    expect(state.samples).toBe(624)
    // One 16-sample packet missing, and the count says so precisely.
    expect(state.droppedSamples).toBe(16)
  })
})
