import { createStore, type Store } from '@/lib/store'

/**
 * User preferences, in localStorage.
 *
 * Deliberately not IndexedDB: these are a handful of scalars that the UI wants
 * synchronously on first render, and IndexedDB is asynchronous. Recordings, which
 * are large and can wait, live in IndexedDB instead.
 */
export interface Settings {
  /** Set the sensor clock on connect. Recordings need it for a UTC anchor. */
  readonly syncTimeOnConnect: boolean
  readonly temperatureUnit: 'K' | 'C'
  /** Reboot after stopping a recording, which rolls the sensor to a new log. */
  readonly rebootAfterStop: boolean
  /** How many samples a live chart keeps per channel. */
  readonly liveBufferSamples: number
}

export const DEFAULT_SETTINGS: Settings = {
  syncTimeOnConnect: true,
  temperatureUnit: 'C',
  rebootAfterStop: true,
  liveBufferSamples: 20_000,
}

const KEY = 'movesense-commander.settings'

function load(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_SETTINGS
    // Merge over the defaults so a setting added later does not read as undefined.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const store: Store<Settings> = createStore<Settings>(load())

export const settingsStore = {
  getSnapshot: (): Settings => store.get(),
  subscribe: (listener: () => void) => store.subscribe(listener),
  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const next = { ...store.get(), [key]: value }
    store.set(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // A full or blocked storage quota should not break the app.
    }
  },
  reset(): void {
    store.set(DEFAULT_SETTINGS)
    try {
      localStorage.removeItem(KEY)
    } catch {
      // As above.
    }
  },
}
