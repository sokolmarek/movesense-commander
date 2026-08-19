/**
 * Catalog of the measurements the DataLogger can record.
 *
 * Sample rates come from the [Movesense API
 * reference](https://www.movesense.com/docs/esw/api_reference/) and from the
 * upstream Tkinter tool's own picker. `bytesPerSample` is our own estimate of
 * the on-wire record size, used only for the throughput hint - it is not read
 * from the sensor.
 *
 * The sensor is the authority on what it supports: `GET /Meas/{Sensor}/Info`
 * returns the real rate list. We do not decode those payloads yet (their shapes
 * are undocumented and unverified), so this catalog is the documented fallback.
 */

/** Rates shared by every IMU-derived stream. */
export const IMU_RATES = [13, 26, 52, 104, 208, 416, 833, 1666] as const

/** ECG rates the sensor accepts. */
export const ECG_RATES = [125, 128, 200, 250, 256, 500, 512] as const

export interface MeasurementSpec {
  readonly id: string
  readonly label: string
  /** Base resource path, without a rate suffix. */
  readonly basePath: string
  /** Selectable rates. Empty means the stream has no rate in its path. */
  readonly rates: readonly number[]
  readonly defaultRate?: number
  /**
   * Rate above which the upstream tool warns about dropped samples when several
   * streams are logged together.
   */
  readonly warnAboveRate?: number
  /** Estimated bytes per sample record, for the throughput hint. */
  readonly bytesPerSample: number
  /**
   * For streams with no rate in the path, the approximate rate at which the
   * sensor emits records. A guess, used only for the throughput hint.
   */
  readonly nominalRate?: number
  /** Appended to the path, e.g. ECG's millivolt variant. */
  readonly suffix?: string
  readonly note?: string
}

/**
 * Path casing follows the API reference (`/Meas/ECG`). The upstream Tkinter tool
 * is inconsistent - its picker says `/Meas/Ecg` while its default config string
 * says `/Meas/ECG` - which suggests Whiteboard paths are case-insensitive, but
 * the documented spelling is the safer one to send.
 */
export const MEASUREMENTS: readonly MeasurementSpec[] = [
  {
    id: 'ecg',
    label: 'ECG',
    basePath: '/Meas/ECG',
    rates: ECG_RATES,
    defaultRate: 200,
    warnAboveRate: 200,
    bytesPerSample: 4,
    suffix: '/mV',
    note: 'Millivolt floats. Needs firmware 2.3 or newer; drop the /mV suffix for raw counts.',
  },
  {
    id: 'acc',
    label: 'Accelerometer',
    basePath: '/Meas/Acc',
    rates: IMU_RATES,
    defaultRate: 52,
    warnAboveRate: 104,
    bytesPerSample: 12,
    note: 'Three float32 axes per sample.',
  },
  {
    id: 'gyro',
    label: 'Gyroscope',
    basePath: '/Meas/Gyro',
    rates: IMU_RATES,
    defaultRate: 52,
    warnAboveRate: 104,
    bytesPerSample: 12,
  },
  {
    id: 'magn',
    label: 'Magnetometer',
    basePath: '/Meas/Magn',
    rates: IMU_RATES,
    defaultRate: 52,
    warnAboveRate: 104,
    bytesPerSample: 12,
  },
  {
    id: 'imu6',
    label: 'IMU6 (acc + gyro)',
    basePath: '/Meas/IMU6',
    rates: IMU_RATES,
    defaultRate: 52,
    warnAboveRate: 104,
    bytesPerSample: 24,
    note: 'Synchronised accelerometer and gyroscope in one stream.',
  },
  {
    id: 'imu6m',
    label: 'IMU6m (acc + magn)',
    basePath: '/Meas/IMU6m',
    rates: IMU_RATES,
    defaultRate: 52,
    warnAboveRate: 104,
    bytesPerSample: 24,
  },
  {
    id: 'imu9',
    label: 'IMU9 (acc + gyro + magn)',
    basePath: '/Meas/IMU9',
    rates: IMU_RATES,
    defaultRate: 52,
    warnAboveRate: 104,
    bytesPerSample: 36,
  },
  {
    id: 'hr',
    label: 'Heart rate',
    basePath: '/Meas/HR',
    rates: [],
    bytesPerSample: 8,
    nominalRate: 1,
    note: 'Average heart rate plus RR intervals. The sensor decides the cadence.',
  },
  {
    id: 'ecgrr',
    label: 'ECG R-R intervals',
    basePath: '/Algo/ECGRR',
    rates: [],
    bytesPerSample: 4,
    nominalRate: 2,
    note: 'One record per detected beat.',
  },
  {
    id: 'temp',
    label: 'Temperature',
    basePath: '/Meas/Temp',
    rates: [],
    bytesPerSample: 4,
    nominalRate: 1,
    note: 'Internal sensor temperature, in Kelvin.',
  },
]

export function findMeasurement(id: string): MeasurementSpec | undefined {
  return MEASUREMENTS.find((measurement) => measurement.id === id)
}

/** The resource path for a measurement at a given rate. */
export function measurementPath(
  measurement: MeasurementSpec,
  rate?: number,
): string {
  const suffix = measurement.suffix ?? ''
  if (measurement.rates.length === 0) return `${measurement.basePath}${suffix}`
  const effective = rate ?? measurement.defaultRate ?? measurement.rates[0]!
  return `${measurement.basePath}/${effective}${suffix}`
}
