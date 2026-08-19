import { createContext, useContext } from 'react'
import { useDeviceSessions } from '@/hooks/use-devices'
import type { DeviceSession } from './session'

/**
 * Which sensor the action pages operate on.
 *
 * A Movesense sensor accepts one BLE central at a time, so several sensors means
 * several connections in one browser. There is no global "active device": each
 * page resolves one, defaulting to the only connected sensor, and the selector
 * appears only when the choice would actually change something.
 */
export interface SelectedDeviceContextValue {
  selectedId: string | null
  select: (id: string) => void
}

export const SelectedDeviceContext =
  createContext<SelectedDeviceContextValue | null>(null)

export function useSelectedDeviceContext(): SelectedDeviceContextValue | null {
  return useContext(SelectedDeviceContext)
}

/**
 * The chosen connected sensor, defaulting to the only one. `session` is null
 * when nothing is connected.
 */
export function useSelectedDevice(): {
  session: DeviceSession | null
  connected: readonly DeviceSession[]
  sessions: readonly DeviceSession[]
} {
  const sessions = useDeviceSessions()
  const context = useContext(SelectedDeviceContext)

  // Reading snapshots directly rather than through a hook is safe here: the
  // manager republishes its list whenever any session changes, so this
  // recomputes. A hook per session is impossible - the list length varies.
  const connected = sessions.filter(
    (candidate) => candidate.getSnapshot().status === 'connected',
  )

  const session =
    connected.find((candidate) => candidate.id === context?.selectedId) ??
    connected[0] ??
    null

  return { session, connected, sessions }
}
