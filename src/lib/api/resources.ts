/**
 * The Movesense resource paths, for the API explorer's autocomplete.
 *
 * From the [API reference](https://www.movesense.com/docs/esw/api_reference/).
 *
 * **What GSP can actually do to these:** GSP has no generic PUT. Its command set
 * offers `GET` and `SUBSCRIBE` for any path, and exactly four writes -
 * DataLogger config, DataLogger state, system mode and UTC time. So a resource
 * documented as PUT-able in the reference is still read-only over this protocol
 * unless it happens to be one of those four. The `writable` flag below records
 * that distinction rather than the documentation's.
 */

export type ResourceOperation = 'GET' | 'SUBSCRIBE'

export interface Resource {
  readonly path: string
  readonly operations: readonly ResourceOperation[]
  readonly summary: string
  /** True when one of GSP's four dedicated writes targets this resource. */
  readonly writable?: boolean
  readonly group: string
}

/** `{n}` marks a placeholder the user must replace, e.g. a sample rate. */
export const RESOURCES: readonly Resource[] = [
  // --- identity and system ---
  { path: '/Info', operations: ['GET'], summary: 'Device and platform information', group: 'System' },
  { path: '/Info/App', operations: ['GET'], summary: 'Application name, version, company', group: 'System' },
  { path: '/System/Energy/Level', operations: ['GET'], summary: 'Battery charge, 0-100', group: 'System' },
  { path: '/System/Memory/Heap', operations: ['GET'], summary: 'Heap usage', group: 'System' },
  { path: '/System/Mode', operations: ['GET'], summary: 'Operating mode', writable: true, group: 'System' },
  { path: '/System/States/0', operations: ['GET', 'SUBSCRIBE'], summary: 'Movement state', group: 'System' },
  { path: '/System/States/1', operations: ['GET', 'SUBSCRIBE'], summary: 'Battery status state', group: 'System' },
  { path: '/System/States/2', operations: ['GET', 'SUBSCRIBE'], summary: 'Connector state', group: 'System' },
  { path: '/System/States/3', operations: ['GET', 'SUBSCRIBE'], summary: 'Double tap', group: 'System' },
  { path: '/System/States/4', operations: ['GET', 'SUBSCRIBE'], summary: 'Tap', group: 'System' },
  { path: '/System/States/5', operations: ['GET', 'SUBSCRIBE'], summary: 'Free fall', group: 'System' },

  // --- time ---
  { path: '/Time', operations: ['GET', 'SUBSCRIBE'], summary: 'UTC time, microseconds since the epoch', writable: true, group: 'Time' },
  { path: '/Time/Detailed', operations: ['GET', 'SUBSCRIBE'], summary: 'Sensor time against UTC - the anchor recordings need', group: 'Time' },

  // --- measurements ---
  { path: '/Meas/Acc/Info', operations: ['GET'], summary: 'Accelerometer rates and G ranges', group: 'Measurement' },
  { path: '/Meas/Acc/Config', operations: ['GET'], summary: 'Accelerometer G range', group: 'Measurement' },
  { path: '/Meas/Acc/{n}', operations: ['SUBSCRIBE'], summary: 'Accelerometer at {n} Hz', group: 'Measurement' },
  { path: '/Meas/Gyro/Info', operations: ['GET'], summary: 'Gyroscope rates and DPS ranges', group: 'Measurement' },
  { path: '/Meas/Gyro/Config', operations: ['GET'], summary: 'Gyroscope DPS range', group: 'Measurement' },
  { path: '/Meas/Gyro/{n}', operations: ['SUBSCRIBE'], summary: 'Gyroscope at {n} Hz', group: 'Measurement' },
  { path: '/Meas/Magn/Info', operations: ['GET'], summary: 'Magnetometer rates', group: 'Measurement' },
  { path: '/Meas/Magn/{n}', operations: ['SUBSCRIBE'], summary: 'Magnetometer at {n} Hz', group: 'Measurement' },
  { path: '/Meas/IMU/Info', operations: ['GET'], summary: 'Combined IMU capabilities', group: 'Measurement' },
  { path: '/Meas/IMU6/{n}', operations: ['SUBSCRIBE'], summary: 'Acc + gyro at {n} Hz', group: 'Measurement' },
  { path: '/Meas/IMU6m/{n}', operations: ['SUBSCRIBE'], summary: 'Acc + magnetometer at {n} Hz', group: 'Measurement' },
  { path: '/Meas/IMU9/{n}', operations: ['SUBSCRIBE'], summary: 'Acc + gyro + magnetometer at {n} Hz', group: 'Measurement' },
  { path: '/Meas/ECG/Info', operations: ['GET'], summary: 'ECG rates, array size, filters', group: 'Measurement' },
  { path: '/Meas/ECG/Config', operations: ['GET'], summary: 'ECG filter settings (firmware 2.1+)', group: 'Measurement' },
  { path: '/Meas/ECG/{n}', operations: ['SUBSCRIBE'], summary: 'ECG at {n} Hz, raw counts', group: 'Measurement' },
  { path: '/Meas/ECG/{n}/mV', operations: ['SUBSCRIBE'], summary: 'ECG at {n} Hz in millivolts (firmware 2.3+)', group: 'Measurement' },
  { path: '/Meas/HR/Info', operations: ['GET'], summary: 'Heart-rate range and accuracy', group: 'Measurement' },
  { path: '/Meas/HR', operations: ['SUBSCRIBE'], summary: 'Heart rate and RR intervals', group: 'Measurement' },
  { path: '/Meas/Temp/Info', operations: ['GET'], summary: 'Temperature range and accuracy', group: 'Measurement' },
  { path: '/Meas/Temp', operations: ['GET', 'SUBSCRIBE'], summary: 'Internal temperature, Kelvin', group: 'Measurement' },
  { path: '/Algo/ECGRR', operations: ['SUBSCRIBE'], summary: 'Detected R-R intervals', group: 'Measurement' },

  // --- memory ---
  { path: '/Mem/DataLogger/Config', operations: ['GET'], summary: 'What the logger is set to record', writable: true, group: 'Memory' },
  { path: '/Mem/DataLogger/State', operations: ['GET', 'SUBSCRIBE'], summary: 'Ready or logging', writable: true, group: 'Memory' },
  { path: '/Mem/Logbook/entries', operations: ['GET'], summary: 'Recording list - truncated to one notification', group: 'Memory' },
  { path: '/Mem/Logbook/IsFull', operations: ['GET'], summary: 'Whether storage is full', group: 'Memory' },

  // --- communication ---
  { path: '/Comm/Ble/Addr', operations: ['GET'], summary: 'BLE MAC address', group: 'Comm' },
  { path: '/Comm/Ble/Peers', operations: ['GET', 'SUBSCRIBE'], summary: 'Connected centrals', group: 'Comm' },
  { path: '/Comm/Ble/Security/Bonds', operations: ['GET'], summary: 'Bonded devices', group: 'Comm' },

  // --- components ---
  { path: '/Component/Leds', operations: ['GET'], summary: 'LED states', group: 'Component' },
  { path: '/Component/Leds/0', operations: ['GET'], summary: 'The single red LED', group: 'Component' },
  { path: '/Component/Eeprom/0/Info', operations: ['GET'], summary: 'EEPROM chip 0 model and size', group: 'Component' },
  { path: '/Component/Eeprom/1/Info', operations: ['GET'], summary: 'EEPROM chip 1 model and size', group: 'Component' },
  { path: '/Ui/Ind/Visual', operations: ['GET'], summary: 'Visual indication state', group: 'Component' },
]

export const RESOURCE_GROUPS = [...new Set(RESOURCES.map((r) => r.group))]

/** Rough match on path or summary, for the explorer's suggestion list. */
export function searchResources(query: string, limit = 12): Resource[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return RESOURCES.slice(0, limit)

  const scored = RESOURCES.map((resource) => {
    const path = resource.path.toLowerCase()
    let score = 0
    if (path === needle) score = 100
    else if (path.startsWith(needle)) score = 60
    else if (path.includes(needle)) score = 40
    else if (resource.summary.toLowerCase().includes(needle)) score = 20
    return { resource, score }
  })

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.resource.path.localeCompare(b.resource.path))
    .slice(0, limit)
    .map((entry) => entry.resource)
}
