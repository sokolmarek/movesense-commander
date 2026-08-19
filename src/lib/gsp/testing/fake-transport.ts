import { GspResponse } from '../constants'
import { GspDisconnectedError } from '../errors'
import type { GspTransport } from '../transport'

/**
 * A scripted transport for tests.
 *
 * Every write is handed to a responder, which may emit any number of
 * notifications. That is enough to reproduce the awkward cases - interleaved
 * references, responses arriving out of order, packet loss during a log fetch -
 * none of which can be provoked reliably against real hardware.
 */
export class FakeTransport implements GspTransport {
  readonly id: string
  readonly name: string | null
  connected = false

  /** Every command written, in order. */
  readonly writes: Uint8Array[] = []

  private readonly notifyListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private responder:
    | ((command: Uint8Array, transport: FakeTransport) => void | Promise<void>)
    | null = null

  constructor(options: { id?: string; name?: string | null } = {}) {
    this.id = options.id ?? 'fake-device'
    this.name = options.name ?? 'Movesense 000000000000'
  }

  /** Install the function that answers writes. */
  onCommand(
    responder: (command: Uint8Array, transport: FakeTransport) => void | Promise<void>,
  ): void {
    this.responder = responder
  }

  /** Push a notification to the client. */
  emit(bytes: Uint8Array): void {
    for (const listener of this.notifyListeners) listener(bytes)
  }

  /** Simulate the link dropping. */
  dropLink(): void {
    this.connected = false
    for (const listener of this.disconnectListeners) listener()
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.connected) {
      throw new GspDisconnectedError('Cannot write: fake transport not connected')
    }
    const copy = new Uint8Array(bytes)
    this.writes.push(copy)
    await this.responder?.(copy, this)
  }

  onNotify(listener: (bytes: Uint8Array) => void): () => void {
    this.notifyListeners.add(listener)
    return () => {
      this.notifyListeners.delete(listener)
    }
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }
}

// ---------------------------------------------------------------------------
// Frame builders - the sensor side of the wire
// ---------------------------------------------------------------------------

export function commandResponse(
  reference: number,
  status: number,
  data: ArrayLike<number> = [],
): Uint8Array {
  const frame = new Uint8Array(4 + data.length)
  frame[0] = GspResponse.CommandResponse
  frame[1] = reference
  frame[2] = status & 0xff
  frame[3] = (status >> 8) & 0xff
  frame.set(Array.from(data), 4)
  return frame
}

/** HELLO responses carry no status field - the payload starts at byte 2. */
export function helloResponse(
  reference: number,
  info: {
    protocolVersion?: number
    serialNumber?: string
    productName?: string
    dfuMacAddress?: string
    appName?: string
    appVersion?: string
  } = {},
): Uint8Array {
  const strings = [
    info.serialNumber ?? '174630000192',
    info.productName ?? 'Movesense Flash',
    info.dfuMacAddress ?? 'AA:BB:CC:DD:EE:FF',
    info.appName ?? 'DataLogger',
    info.appVersion ?? '2.3.1',
  ]
  const body = new TextEncoder().encode(strings.join('\0'))
  const frame = new Uint8Array(3 + body.length)
  frame[0] = GspResponse.CommandResponse
  frame[1] = reference
  frame[2] = info.protocolVersion ?? 1
  frame.set(body, 3)
  return frame
}

export function dataFrame(
  reference: number,
  offset: number,
  bytes: ArrayLike<number>,
  continuation = false,
): Uint8Array {
  const frame = new Uint8Array(6 + bytes.length)
  frame[0] = continuation ? GspResponse.DataPart2 : GspResponse.Data
  frame[1] = reference
  new DataView(frame.buffer).setUint32(2, offset, true)
  frame.set(Array.from(bytes), 6)
  return frame
}

/** The end-of-log marker: a data packet with an offset but no body. */
export function endOfLogFrame(reference: number, offset: number): Uint8Array {
  return dataFrame(reference, offset, [])
}

/** A raw subscription sample, which has no offset prefix. */
export function subscriptionFrame(
  reference: number,
  payload: ArrayLike<number>,
): Uint8Array {
  const frame = new Uint8Array(2 + payload.length)
  frame[0] = GspResponse.Data
  frame[1] = reference
  frame.set(Array.from(payload), 2)
  return frame
}

/** Logbook listing payload: uint8 count, then 16 bytes per entry. */
export function logbookEntriesPayload(
  entries: Array<{ id: number; lastModified?: number; size: number }>,
  declaredCount = entries.length,
): Uint8Array {
  const payload = new Uint8Array(1 + entries.length * 16)
  payload[0] = declaredCount
  const view = new DataView(payload.buffer)
  entries.forEach((entry, index) => {
    const at = 1 + index * 16
    view.setUint32(at, entry.id, true)
    view.setUint32(at + 4, entry.lastModified ?? 0, true)
    view.setBigUint64(at + 8, BigInt(entry.size), true)
  })
  return payload
}
