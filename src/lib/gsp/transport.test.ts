import { describe, expect, it } from 'vitest'
import { GSP_SERVICE_UUID } from './constants'
import {
  buildDeviceRequestOptions,
  MOVESENSE_ADVERTISED_SERVICES,
  MOVESENSE_NAME_PREFIX,
} from './transport'

/**
 * Filtering only on the GSP service UUID finds nothing: it does not fit in the
 * advertising packet next to the device name, so the sensor advertises the name.
 * These assertions exist to stop that regressing.
 */
describe('buildDeviceRequestOptions', () => {
  it('filters on the device name, not just the service UUID', () => {
    const options = buildDeviceRequestOptions('movesense')
    expect(options).not.toHaveProperty('acceptAllDevices')
    const filters = (options as { filters: Array<Record<string, unknown>> }).filters
    // Name prefix first, then the 16-bit services a sensor really advertises,
    // then the GSP UUID as a long shot. Filters are OR-ed.
    expect(filters).toEqual([
      { namePrefix: MOVESENSE_NAME_PREFIX },
      { services: [0xfdf3] },
      { services: [0x180d] },
      { services: [GSP_SERVICE_UUID] },
    ])
  })

  it('filters on services the sensor was observed advertising', () => {
    // A BLE scan of a Movesense Flash showed 0xFDF3 and 0x180D, and no GSP UUID,
    // so filtering on GSP alone matches nothing.
    expect(MOVESENSE_ADVERTISED_SERVICES).toEqual([0xfdf3, 0x180d])
  })

  it('keeps the GSP service reachable after connecting', () => {
    // A service is only usable if it appears in `filters.services` or
    // `optionalServices`, so the name-filtered path must list it explicitly.
    for (const mode of ['movesense', 'all'] as const) {
      const options = buildDeviceRequestOptions(mode) as {
        optionalServices?: string[]
      }
      expect(options.optionalServices).toContain(GSP_SERVICE_UUID)
    }
  })

  it('drops all filters in the diagnostic mode', () => {
    const options = buildDeviceRequestOptions('all')
    expect(options).toMatchObject({ acceptAllDevices: true })
    // `acceptAllDevices` and `filters` are mutually exclusive in the spec.
    expect(options).not.toHaveProperty('filters')
  })

  it('defaults to the Movesense filter', () => {
    expect(buildDeviceRequestOptions()).toEqual(
      buildDeviceRequestOptions('movesense'),
    )
  })
})
