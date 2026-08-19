import {
  GSP_NOTIFY_CHARACTERISTIC_UUID,
  GSP_SERVICE_UUID,
  GSP_WRITE_CHARACTERISTIC_UUID,
} from './constants'
import { GspDisconnectedError, GspError, GspUnsupportedError } from './errors'

/**
 * The transport boundary.
 *
 * This is the only place in `src/lib` that touches Web Bluetooth. Everything
 * above it works against this interface, which is what lets the whole client be
 * tested in Node against a scripted fake.
 */
export interface GspTransport {
  /** Stable identifier for this device across reconnects. */
  readonly id: string
  readonly name: string | null
  readonly connected: boolean
  connect(): Promise<void>
  disconnect(): Promise<void>
  write(bytes: Uint8Array): Promise<void>
  /** Returns an unsubscribe function. */
  onNotify(listener: (bytes: Uint8Array) => void): () => void
  /** Returns an unsubscribe function. */
  onDisconnect(listener: () => void): () => void
}

/** How wide a net the device chooser casts. */
export type DeviceRequestMode = 'movesense' | 'all'

/** Movesense advertises names like `Movesense 250230002214`. */
export const MOVESENSE_NAME_PREFIX = 'Movesense'

/**
 * 16-bit service UUIDs a Movesense sensor really does advertise, observed with a
 * BLE scanner: 0xFDF3 (member-assigned) and 0x180D (standard Heart Rate Service).
 * Filtering on these is sturdier than a name prefix, since a renamed sensor still
 * advertises them.
 */
export const MOVESENSE_ADVERTISED_SERVICES = [0xfdf3, 0x180d] as const

/**
 * Build the options for `requestDevice`.
 *
 * A BLE advertising packet holds 31 bytes. A 128-bit service UUID costs 18 of
 * them and the local name `Movesense 174630000192` costs 24, so a sensor cannot
 * advertise both - in practice it advertises the name. Filtering on the GSP
 * service UUID alone therefore matches nothing, which is why the Python
 * reference tool scans unfiltered and matches on the name instead.
 *
 * So: filter on the name as well (filters are OR-ed), and keep the service in
 * `optionalServices` so it is still reachable once connected. `all` is the
 * escape hatch for firmware that advertises under some other name.
 */
export function buildDeviceRequestOptions(
  mode: DeviceRequestMode = 'movesense',
): RequestDeviceOptions {
  if (mode === 'all') {
    // `acceptAllDevices` and `filters` are mutually exclusive.
    return { acceptAllDevices: true, optionalServices: [GSP_SERVICE_UUID] }
  }

  return {
    // Filters are OR-ed. The name prefix covers the common case; the advertised
    // 16-bit services cover a renamed sensor; the GSP UUID is kept in case some
    // firmware advertises it, though none we have scanned does.
    filters: [
      { namePrefix: MOVESENSE_NAME_PREFIX },
      ...MOVESENSE_ADVERTISED_SERVICES.map((service) => ({ services: [service] })),
      { services: [GSP_SERVICE_UUID] },
    ],
    optionalServices: [GSP_SERVICE_UUID],
  }
}

/**
 * Ask the browser for a Movesense sensor.
 *
 * Must be called from a user gesture - the browser shows its own chooser and
 * there is no way around that.
 */
export async function requestMovesenseDevice(
  mode: DeviceRequestMode = 'movesense',
): Promise<BluetoothDevice> {
  if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
    throw new GspUnsupportedError('This browser has no Web Bluetooth support.')
  }

  return navigator.bluetooth.requestDevice(buildDeviceRequestOptions(mode))
}

/** Devices this origin has already been granted, where the browser supports it. */
export async function getPermittedDevices(): Promise<BluetoothDevice[]> {
  if (
    typeof navigator === 'undefined' ||
    !('bluetooth' in navigator) ||
    typeof navigator.bluetooth.getDevices !== 'function'
  ) {
    return []
  }
  try {
    return await navigator.bluetooth.getDevices()
  } catch {
    // Chrome gates this behind a flag in some versions; absence is not an error.
    return []
  }
}

export class WebBluetoothTransport implements GspTransport {
  private writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  private notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null
  private readonly notifyListeners = new Set<(bytes: Uint8Array) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private readonly handleGattDisconnected = () => {
    this.writeCharacteristic = null
    this.notifyCharacteristic = null
    for (const listener of this.disconnectListeners) listener()
  }

  private readonly handleCharacteristicValue = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic
    const value = target.value
    if (!value) return
    // Copy: the DataView's buffer is owned by the platform and may be reused.
    const bytes = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    )
    for (const listener of this.notifyListeners) listener(bytes)
  }

  constructor(private readonly device: BluetoothDevice) {}

  get id(): string {
    return this.device.id
  }

  get name(): string | null {
    return this.device.name ?? null
  }

  get connected(): boolean {
    return this.device.gatt?.connected === true && this.writeCharacteristic !== null
  }

  async connect(): Promise<void> {
    const gatt = this.device.gatt
    if (!gatt) {
      throw new GspError('Device exposes no GATT server')
    }

    this.device.addEventListener('gattserverdisconnected', this.handleGattDisconnected)

    const server = gatt.connected ? gatt : await gatt.connect()
    const service = await server.getPrimaryService(GSP_SERVICE_UUID)

    this.writeCharacteristic = await service.getCharacteristic(
      GSP_WRITE_CHARACTERISTIC_UUID,
    )
    this.notifyCharacteristic = await service.getCharacteristic(
      GSP_NOTIFY_CHARACTERISTIC_UUID,
    )

    this.notifyCharacteristic.addEventListener(
      'characteristicvaluechanged',
      this.handleCharacteristicValue,
    )
    // Notifications must be running before the first command is written, or
    // its response is lost.
    await this.notifyCharacteristic.startNotifications()
  }

  async disconnect(): Promise<void> {
    this.device.removeEventListener(
      'gattserverdisconnected',
      this.handleGattDisconnected,
    )

    const notify = this.notifyCharacteristic
    this.notifyCharacteristic = null
    this.writeCharacteristic = null

    if (notify) {
      notify.removeEventListener(
        'characteristicvaluechanged',
        this.handleCharacteristicValue,
      )
      try {
        await notify.stopNotifications()
      } catch {
        // The link may already be gone; nothing useful to do about it.
      }
    }

    try {
      this.device.gatt?.disconnect()
    } catch {
      // Same.
    }
  }

  async write(bytes: Uint8Array): Promise<void> {
    const characteristic = this.writeCharacteristic
    if (!characteristic || this.device.gatt?.connected !== true) {
      throw new GspDisconnectedError('Cannot write: sensor is not connected')
    }
    // `writeValueWithResponse` is the correct call; fall back for older
    // Chromium builds that only expose the deprecated `writeValue`.
    if (typeof characteristic.writeValueWithResponse === 'function') {
      await characteristic.writeValueWithResponse(bytes as BufferSource)
    } else {
      await characteristic.writeValue(bytes as BufferSource)
    }
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
