/**
 * GSP (GATT SensorData Protocol) constants.
 *
 * See docs/gsp-protocol.md for the wire format these describe. Values are
 * taken from examples/python-datalogger-tool/sensor_command.py, which is
 * known to work against real hardware.
 */

export const GSP_SERVICE_UUID = '34802252-7185-4d5d-b431-630e7050e8f0'
/** Client writes commands here. */
export const GSP_WRITE_CHARACTERISTIC_UUID = '34800001-7185-4d5d-b431-630e7050e8f0'
/** Sensor notifies responses and data here. */
export const GSP_NOTIFY_CHARACTERISTIC_UUID = '34800002-7185-4d5d-b431-630e7050e8f0'

export const GspCommand = {
  Hello: 0,
  Subscribe: 1,
  Unsubscribe: 2,
  FetchLog: 3,
  Get: 4,
  ClearLogbook: 5,
  PutDataLoggerConfig: 6,
  PutSystemMode: 7,
  PutUtcTime: 8,
  PutDataLoggerState: 9,
} as const
export type GspCommand = (typeof GspCommand)[keyof typeof GspCommand]

export const GspResponse = {
  CommandResponse: 1,
  Data: 2,
  DataPart2: 3,
} as const
export type GspResponse = (typeof GspResponse)[keyof typeof GspResponse]

/** `/Mem/DataLogger/State` values. */
export const DataLoggerState = {
  Unknown: 1,
  Ready: 2,
  Logging: 3,
} as const
export type DataLoggerState = (typeof DataLoggerState)[keyof typeof DataLoggerState]

export const DATA_LOGGER_STATE_LABELS: Record<number, string> = {
  1: 'Unknown',
  2: 'Ready',
  3: 'Logging',
}

/** `/System/Mode` values. */
export const SystemMode = {
  FullPowerOff: 1,
  Application: 5,
  FwUpdate: 12,
} as const
export type SystemMode = (typeof SystemMode)[keyof typeof SystemMode]

/** Raw ECG sample to millivolts, for firmware without the `/mV` path. */
export const ECG_LSB_TO_MV = 0.000381469726563

/**
 * `/Time/Detailed` is what anchors sensor timestamps to wall-clock time, so
 * every DataLogger config we write includes it.
 */
export const TIME_DETAILED_PATH = '/Time/Detailed'

/**
 * The reference GUI caps DataLogger configs at 3 paths. Unverified as a
 * firmware limit, so we warn rather than block.
 */
export const RECOMMENDED_MAX_LOG_PATHS = 3
