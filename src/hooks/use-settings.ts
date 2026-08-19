import { useCallback, useSyncExternalStore } from 'react'
import { settingsStore, type Settings } from '@/lib/settings'
import { presetStore, type Preset } from '@/lib/record/presets'

export function useSettings(): Settings {
  return useSyncExternalStore(
    useCallback((listener: () => void) => settingsStore.subscribe(listener), []),
    () => settingsStore.getSnapshot(),
    () => settingsStore.getSnapshot(),
  )
}

export function usePresets(): readonly Preset[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => presetStore.subscribe(listener), []),
    () => presetStore.getSnapshot(),
    () => presetStore.getSnapshot(),
  )
}
