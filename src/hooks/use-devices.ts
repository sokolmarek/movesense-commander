import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { deviceManager } from '@/lib/device/manager'
import type { DeviceSession, DeviceSnapshot } from '@/lib/device/session'
import { describeError } from '@/lib/device/session'
import type { TraceEntry, TraceRecorder } from '@/lib/gsp/trace'
import type { DeviceRequestMode } from '@/lib/gsp/transport'

/** Every session the manager knows about, connected or failed. */
export function useDeviceSessions(): readonly DeviceSession[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => deviceManager.subscribe(listener), []),
    () => deviceManager.getSnapshot(),
    () => deviceManager.getSnapshot(),
  )
}

/** Live state of one session. */
export function useDeviceSnapshot(session: DeviceSession): DeviceSnapshot {
  return useSyncExternalStore(
    useCallback((listener: () => void) => session.subscribe(listener), [session]),
    () => session.getSnapshot(),
    () => session.getSnapshot(),
  )
}

export function useTrace(recorder: TraceRecorder): readonly TraceEntry[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => recorder.subscribe(listener), [recorder]),
    () => recorder.getEntries(),
    () => recorder.getEntries(),
  )
}

/**
 * The connect intent, with its own pending and error state.
 *
 * `requestDevice` rejects with NotFoundError when the user closes the chooser,
 * which is a cancellation rather than a failure and should not be shown as one.
 */
export function useConnect() {
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async (mode: DeviceRequestMode = 'movesense') => {
    setConnecting(true)
    setError(null)
    try {
      await deviceManager.connectNew(mode)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'NotFoundError') {
        // Chooser dismissed, or nothing matched the filter. Not an error.
      } else {
        setError(describeError(cause))
      }
    } finally {
      setConnecting(false)
    }
  }, [])

  return { connect, connecting, error, clearError: () => setError(null) }
}

/** Devices this origin may reopen without the chooser. */
export function useReconnectable(): { devices: BluetoothDevice[]; refresh: () => void } {
  const [devices, setDevices] = useState<BluetoothDevice[]>([])
  const [nonce, setNonce] = useState(0)
  const sessions = useDeviceSessions()

  useEffect(() => {
    let cancelled = false
    void deviceManager.listReconnectable().then((found) => {
      if (!cancelled) setDevices(found)
    })
    return () => {
      cancelled = true
    }
  }, [nonce, sessions])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return useMemo(() => ({ devices, refresh }), [devices, refresh])
}
