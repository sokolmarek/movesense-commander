/**
 * Decoders for GSP binary payloads. See docs/gsp-protocol.md section 7.
 *
 * Payload shapes are per-resource and only partially documented, so this file
 * holds only shapes confirmed against the working Python reference or real
 * hardware. Anything else stays raw bytes - guessing a layout produces
 * plausible numbers that are silently wrong, which is worse than showing hex.
 */

import { GspDecodeError } from './errors'

export interface DeviceInfo {
  protocolVersion: number
  serialNumber: string
  productName: string
  dfuMacAddress: string
  appName: string
  appVersion: string
}

const utf8 = new TextDecoder('utf-8', { fatal: false })

/**
 * HELLO response payload: a version byte, then NUL-separated strings.
 *
 * Note there is no status field on a HELLO response - the caller must pass the
 * payload starting at byte 2 of the frame, not byte 4.
 */
export function decodeHello(payload: Uint8Array): DeviceInfo {
  if (payload.length < 1) {
    throw new GspDecodeError('HELLO response is empty')
  }

  const strings = utf8.decode(payload.subarray(1)).split('\0')

  return {
    protocolVersion: payload[0]!,
    serialNumber: strings[0] ?? '',
    productName: strings[1] ?? '',
    dfuMacAddress: strings[2] ?? '',
    appName: strings[3] ?? '',
    appVersion: strings[4] ?? '',
  }
}

/** A single-byte payload, as used by `/System/Energy/Level` and DataLogger state. */
export function decodeUint8(payload: Uint8Array, what = 'value'): number {
  if (payload.length < 1) {
    throw new GspDecodeError(`Expected a uint8 ${what}, got an empty payload`)
  }
  return payload[0]!
}

export interface LogbookEntry {
  id: number
  /** Sensor-reported last-modified stamp. Units are not documented. */
  lastModified: number
  /** Log size in bytes. */
  size: number
  /** False when the entry was found by probing rather than from the listing. */
  fromListing: boolean
}

export const LOGBOOK_ENTRY_BYTES = 16

/**
 * `/Mem/Logbook/entries` payload: a uint8 count, then 16 bytes per entry
 * (uint32 id, uint32 lastModified, uint64 size).
 *
 * The response is capped at one notification, so `count` routinely exceeds the
 * number of entries actually present in the payload. That is not corruption -
 * it is the MTU truncation described in docs/gsp-protocol.md, and it is why log
 * enumeration also probes for ids past the end of this list.
 */
export function decodeLogbookEntries(payload: Uint8Array): {
  entries: LogbookEntry[]
  declaredCount: number
  truncated: boolean
} {
  if (payload.length < 1) {
    return { entries: [], declaredCount: 0, truncated: false }
  }

  const declaredCount = payload[0]!
  const body = payload.subarray(1)
  const available = Math.floor(body.length / LOGBOOK_ENTRY_BYTES)
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)

  const entries: LogbookEntry[] = []
  for (let i = 0; i < available; i++) {
    const at = i * LOGBOOK_ENTRY_BYTES
    entries.push({
      id: view.getUint32(at, true),
      lastModified: view.getUint32(at + 4, true),
      // Sizes far exceed the sensor's storage, so a Number is safe and easier
      // to work with than a BigInt.
      size: Number(view.getBigUint64(at + 8, true)),
      fromListing: true,
    })
  }

  return {
    entries,
    declaredCount,
    truncated: declaredCount > available,
  }
}
