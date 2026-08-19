import {
  getPermittedDevices,
  requestMovesenseDevice,
  WebBluetoothTransport,
  type DeviceRequestMode,
} from '@/lib/gsp/transport'
import { settingsStore } from '@/lib/settings'
import { createStore, type Store } from '@/lib/store'
import { DeviceSession } from './session'

/**
 * Registry of connected sensors.
 *
 * A Movesense sensor accepts one BLE central at a time, so "multiple devices"
 * means several sensors and one browser. The manager holds a map from the
 * start, which keeps the single-device case honest and multi-device cheap.
 */
export class DeviceManager {
  private readonly sessions = new Map<string, DeviceSession>()
  /** Per-session unsubscribes, so session changes republish this store. */
  private readonly watchers = new Map<string, () => void>()
  private readonly store: Store<readonly DeviceSession[]> = createStore<
    readonly DeviceSession[]
  >([])

  getSnapshot(): readonly DeviceSession[] {
    return this.store.get()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  get(id: string): DeviceSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Show the browser's device chooser and connect what the user picks.
   * Must be called from a user gesture.
   *
   * `mode: 'all'` drops the name filter, for a sensor that advertises under an
   * unexpected name.
   */
  async connectNew(mode: DeviceRequestMode = 'movesense'): Promise<DeviceSession> {
    const device = await requestMovesenseDevice(mode)
    return this.connectDevice(device)
  }

  /**
   * Reconnect a device this origin already has permission for, without the
   * chooser. Only works where `navigator.bluetooth.getDevices()` exists.
   */
  async reconnect(deviceId: string): Promise<DeviceSession | null> {
    const existing = this.sessions.get(deviceId)
    if (existing) {
      await existing.connect()
      return existing
    }

    const permitted = await getPermittedDevices()
    const device = permitted.find((candidate) => candidate.id === deviceId)
    if (!device) return null
    return this.connectDevice(device)
  }

  /** Devices we could reconnect to without showing the chooser. */
  async listReconnectable(): Promise<BluetoothDevice[]> {
    const permitted = await getPermittedDevices()
    return permitted.filter((device) => !this.sessions.has(device.id))
  }

  async disconnect(id: string): Promise<void> {
    await this.sessions.get(id)?.disconnect()
  }

  /** Disconnect and forget a session. */
  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      await session.disconnect()
    } finally {
      this.watchers.get(id)?.()
      this.watchers.delete(id)
      this.sessions.delete(id)
      this.publish()
    }
  }

  private async connectDevice(device: BluetoothDevice): Promise<DeviceSession> {
    const existing = this.sessions.get(device.id)
    if (existing) {
      await existing.connect()
      return existing
    }

    // Honour the user's clock-sync preference at the moment of connecting.
    const session = new DeviceSession(new WebBluetoothTransport(device), {
      syncTimeOnConnect: settingsStore.getSnapshot().syncTimeOnConnect,
    })
    this.sessions.set(device.id, session)
    // Republish when any session's own state changes, so consumers reading a
    // session's status through this list re-render. Without this, a device that
    // disconnects would still look connected to anything watching the list.
    this.watchers.set(device.id, session.subscribe(() => this.publish()))
    this.publish()

    // A failed connect leaves the session in the list on purpose: its error
    // and trace are how the user finds out what went wrong.
    await session.connect()
    return session
  }

  private publish(): void {
    this.store.set([...this.sessions.values()])
  }
}

/**
 * Module singleton. Web Bluetooth is a per-origin global, so there is nothing
 * meaningful to scope a second manager to.
 */
export const deviceManager = new DeviceManager()
