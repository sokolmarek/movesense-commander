import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { logStore, type LogStoreState } from '@/lib/storage/log-store'

/** Stored recordings, loaded from IndexedDB on first use. */
export function useStoredLogs(): LogStoreState {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => logStore.subscribe(listener), []),
    () => logStore.getSnapshot(),
    () => logStore.getSnapshot(),
  )

  useEffect(() => {
    void logStore.ensureLoaded()
  }, [])

  return state
}
