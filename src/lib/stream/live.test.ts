import { describe, expect, it } from 'vitest'
import { LiveStream } from './live'
import { channelUnit, ECG_MV_PER_COUNT, requestedRateHz } from './units'

/** Build an ECG /mV packet: uint32 timestamp then int16 microvolt samples. */
function ecgMvPacket(timestamp: number, samples: number[]): Uint8Array {
  const out = new Uint8Array(4 + samples.length * 2)
  const view = new DataView(out.buffer)
  view.setUint32(0, timestamp, true)
  samples.forEach((value, i) => view.setInt16(4 + i * 2, value, true))
  return out
}

/** Build an IMU9 packet: uint32 timestamp then acc, gyro, magn float blocks. */
function imu9Packet(timestamp: number, samplesPerSensor: number): Uint8Array {
  const floats = samplesPerSensor * 9
  const out = new Uint8Array(4 + floats * 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, timestamp, true)
  for (let i = 0; i < floats; i++) view.setFloat32(4 + i * 4, i + 1, true)
  return out
}

describe('units', () => {
  it('reads the requested rate out of the path', () => {
    expect(requestedRateHz('/Meas/ECG/200/mV')).toBe(200)
    expect(requestedRateHz('/Meas/IMU9/52')).toBe(52)
    expect(requestedRateHz('/Meas/HR')).toBeNull()
  })

  it('scales the two ECG paths differently, as measured', () => {
    // The /mV path sends microvolts; the raw path sends counts.
    expect(channelUnit('/Meas/ECG/200/mV', 'Samples')).toEqual({
      scale: 0.001,
      unit: 'mV',
    })
    expect(channelUnit('/Meas/ECG/200', 'Samples')).toEqual({
      scale: ECG_MV_PER_COUNT,
      unit: 'mV',
    })
  })

  it('labels IMU channels by sensor', () => {
    expect(channelUnit('/Meas/IMU9/52', 'ArrayAcc').unit).toBe('m/s²')
    expect(channelUnit('/Meas/IMU9/52', 'ArrayGyro').unit).toBe('dps')
    expect(channelUnit('/Meas/IMU9/52', 'ArrayMagn').unit).toBe('µT')
  })

  it('leaves an unknown channel unitless rather than guessing', () => {
    expect(channelUnit('/Meas/Quux/13', 'Whatever')).toEqual({ scale: 1, unit: '' })
  })
})

describe('LiveStream', () => {
  it('starts empty and knows the rate it asked for', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    expect(stream.getSnapshot()).toMatchObject({
      packets: 0,
      samples: 0,
      droppedSamples: 0,
      requestedHz: 200,
      measuredHz: null,
    })
  })

  it('decodes packets into a channel and converts to millivolts', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    // 1000 microvolts is 1 mV.
    stream.push(ecgMvPacket(1000, [1000, 2000, -500, 0]))

    const state = stream.getSnapshot()
    expect(state.packets).toBe(1)
    expect(state.samples).toBe(4)
    const channel = state.channels[0]!
    expect(channel.label).toBe('Samples')
    expect(channel.unit).toEqual({ scale: 0.001, unit: 'mV' })
    expect(channel.values[0]).toEqual([1, 2, -0.5, 0])
  })

  it('spreads a packet across its interval, since one timestamp covers many samples', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    stream.push(ecgMvPacket(1000, [0, 0, 0, 0]))
    // 200 Hz is 5 ms per sample.
    expect(stream.getSnapshot().channels[0]!.time).toEqual([1000, 1005, 1010, 1015])
  })

  it('splits an IMU9 packet into three channels with their own units', () => {
    const stream = new LiveStream('/Meas/IMU9/52')
    stream.push(imu9Packet(500, 4))

    const state = stream.getSnapshot()
    expect(state.samples).toBe(4)
    expect(state.channels.map((c) => c.label)).toEqual(['Acc', 'Gyro', 'Magn'])
    for (const channel of state.channels) {
      expect(channel.columns).toEqual(['x', 'y', 'z'])
      expect(channel.time).toHaveLength(4)
      expect(channel.values[0]).toHaveLength(4)
    }
  })

  it('counts dropped samples from the timestamp gap', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    // Packets of 4 samples at 5 ms each: 20 ms apart is continuous.
    stream.push(ecgMvPacket(1000, [1, 2, 3, 4]))
    stream.push(ecgMvPacket(1020, [5, 6, 7, 8]))
    expect(stream.getSnapshot().droppedSamples).toBe(0)

    // Jumping 60 ms means two packets - eight samples - never arrived.
    stream.push(ecgMvPacket(1080, [9, 10, 11, 12]))
    expect(stream.getSnapshot().droppedSamples).toBe(8)
  })

  it('cannot count drops without a rate, and does not pretend to', () => {
    const stream = new LiveStream('/Meas/HR')
    const hr = new Uint8Array(6)
    new DataView(hr.buffer).setFloat32(0, 60, true)
    new DataView(hr.buffer).setUint16(4, 1000, true)
    stream.push(hr)
    stream.push(hr)
    expect(stream.getSnapshot().requestedHz).toBeNull()
    expect(stream.getSnapshot().droppedSamples).toBe(0)
  })

  it('measures the rate from sample times, not packet times', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    // Packets of 4 samples, 20 ms apart: exactly 200 Hz.
    for (let i = 0; i < 10; i++) {
      stream.push(ecgMvPacket(1000 + i * 20, [1, 2, 3, 4]))
    }
    // Spanning to the last sample rather than the last packet is what makes this
    // land on 200 instead of overstating it by one packet's duration.
    expect(stream.getSnapshot().measuredHz).toBeCloseTo(200, 6)
  })

  it('trims old samples to stay inside its memory budget', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV', { maxSamples: 8 })
    for (let i = 0; i < 10; i++) {
      // 1000 microvolts per step, so the millivolt value is just i.
      stream.push(ecgMvPacket(1000 + i * 20, [i * 1000, i * 1000, i * 1000, i * 1000]))
    }
    const channel = stream.getSnapshot().channels[0]!
    expect(channel.time).toHaveLength(8)
    expect(channel.values[0]).toHaveLength(8)
    // The newest samples survive; the oldest are gone.
    expect(channel.values[0]!.at(-1)).toBeCloseTo(9, 9)
    expect(channel.values[0]![0]).toBeCloseTo(8, 9)
  })

  it('counts undecodable payloads instead of throwing', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    // Odd length cannot be a whole number of int16 samples.
    stream.push(new Uint8Array([1, 2, 3, 4, 5]))
    expect(stream.getSnapshot().undecodable).toBe(1)
    expect(stream.getSnapshot().packets).toBe(0)
  })

  it('publishes a new channel array so subscribers re-render', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    let notifications = 0
    stream.subscribe(() => notifications++)
    const before = stream.getSnapshot()
    stream.push(ecgMvPacket(1000, [1, 2, 3, 4]))
    expect(notifications).toBe(1)
    expect(stream.getSnapshot()).not.toBe(before)
  })

  it('clears its buffers on reset', () => {
    const stream = new LiveStream('/Meas/ECG/200/mV')
    stream.push(ecgMvPacket(1000, [1, 2, 3, 4]))
    stream.reset()
    expect(stream.getSnapshot()).toMatchObject({
      packets: 0,
      samples: 0,
      channels: [],
    })
  })
})
