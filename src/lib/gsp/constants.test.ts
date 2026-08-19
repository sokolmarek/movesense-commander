import { describe, expect, it } from 'vitest'
import {
  DataLoggerState,
  GSP_NOTIFY_CHARACTERISTIC_UUID,
  GSP_SERVICE_UUID,
  GSP_WRITE_CHARACTERISTIC_UUID,
  GspCommand,
  GspResponse,
  SystemMode,
} from './constants'

/**
 * A typo in any of these is a bug that only shows up as a silent BLE failure
 * against real hardware, so pin them against docs/gsp-protocol.md here.
 */
describe('GSP constants', () => {
  it('uses the documented UUIDs, lowercase as Web Bluetooth requires', () => {
    expect(GSP_SERVICE_UUID).toBe('34802252-7185-4d5d-b431-630e7050e8f0')
    expect(GSP_WRITE_CHARACTERISTIC_UUID).toBe('34800001-7185-4d5d-b431-630e7050e8f0')
    expect(GSP_NOTIFY_CHARACTERISTIC_UUID).toBe('34800002-7185-4d5d-b431-630e7050e8f0')

    for (const uuid of [
      GSP_SERVICE_UUID,
      GSP_WRITE_CHARACTERISTIC_UUID,
      GSP_NOTIFY_CHARACTERISTIC_UUID,
    ]) {
      expect(uuid).toBe(uuid.toLowerCase())
      expect(uuid).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
    }
  })

  it('maps command codes to their protocol values', () => {
    expect(GspCommand).toEqual({
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
    })
  })

  it('maps response codes and state enums', () => {
    expect(GspResponse).toEqual({ CommandResponse: 1, Data: 2, DataPart2: 3 })
    expect(DataLoggerState).toEqual({ Unknown: 1, Ready: 2, Logging: 3 })
    expect(SystemMode).toEqual({ FullPowerOff: 1, Application: 5, FwUpdate: 12 })
  })
})
