/**
 * Physical units for live subscription data.
 *
 * Every factor here was measured against hardware, not taken from a table:
 * see docs/gsp-protocol.md. The ECG ones in particular are the reason this file
 * exists - the `/mV` path sends microvolts despite its name, and the raw path
 * sends ADC counts.
 */

/** Microvolts per raw ECG count, from the Movesense reference tooling. */
export const ECG_UV_PER_COUNT = 0.381469726563
/** Millivolts per raw ECG count. */
export const ECG_MV_PER_COUNT = ECG_UV_PER_COUNT / 1000

export interface ChannelUnit {
  /** Multiply raw values by this to get `unit`. */
  readonly scale: number
  readonly unit: string
}

const UNSCALED = (unit: string): ChannelUnit => ({ scale: 1, unit })

/**
 * Unit for one channel of a subscription.
 *
 * `channel` is the decoded field name - `Samples`, `ArrayAcc`, `rrData` and so on.
 */
export function channelUnit(path: string, channel: string): ChannelUnit {
  const lower = path.toLowerCase()

  if (/^\/meas\/ecg\/\d+\/mv$/.test(lower)) {
    // Verified: the /mV path carries microvolts as int16.
    return { scale: 0.001, unit: 'mV' }
  }
  if (/^\/meas\/ecg\/\d+$/.test(lower)) {
    // Verified: the bare path carries raw counts as int32.
    return { scale: ECG_MV_PER_COUNT, unit: 'mV' }
  }

  if (channel === 'ArrayAcc' || /^\/meas\/acc\//.test(lower)) return UNSCALED('m/s²')
  if (channel === 'ArrayGyro' || /^\/meas\/gyro\//.test(lower)) return UNSCALED('dps')
  if (channel === 'ArrayMagn' || /^\/meas\/magn\//.test(lower)) return UNSCALED('µT')
  if (/^\/meas\/temp$/.test(lower)) return UNSCALED('K')
  if (channel === 'rrData') return UNSCALED('ms')
  if (channel === 'average') return UNSCALED('bpm')

  return UNSCALED('')
}

/** Kelvin to Celsius, for the temperature display preference. */
export function kelvinToCelsius(kelvin: number): number {
  return kelvin - 273.15
}

/**
 * The sample rate a measurement path asks for, from the path itself.
 *
 * Used to predict the packet interval, which is what makes dropped-packet
 * detection exact rather than a guess from observed jitter.
 */
export function requestedRateHz(path: string): number | null {
  const match = /\/(\d+)(?:\/mV)?$/i.exec(path.trim())
  if (!match) return null
  const rate = Number.parseInt(match[1]!, 10)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}
