import { createStore, type Store } from '@/lib/store'
import type { Selection } from './config'

/**
 * Saved DataLogger configurations.
 *
 * Kept in localStorage next to the other preferences, and exportable as JSON so a
 * configuration can be shared or version-controlled alongside a study protocol.
 */
export interface Preset {
  readonly id: string
  readonly name: string
  readonly selections: readonly Selection[]
  readonly createdAt: number
}

const KEY = 'movesense-commander.presets'

function load(): Preset[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Preset[]) : []
  } catch {
    return []
  }
}

const store: Store<readonly Preset[]> = createStore<readonly Preset[]>(load())

function persist(next: readonly Preset[]): void {
  store.set(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Ignore quota failures; the in-memory list still works for this session.
  }
}

/** Stable id without a random source, so repeated saves stay predictable. */
function makeId(name: string, existing: readonly Preset[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'preset'
  if (!existing.some((preset) => preset.id === base)) return base
  let n = 2
  while (existing.some((preset) => preset.id === `${base}-${n}`)) n++
  return `${base}-${n}`
}

export const presetStore = {
  getSnapshot: (): readonly Preset[] => store.get(),
  subscribe: (listener: () => void) => store.subscribe(listener),

  save(name: string, selections: readonly Selection[], now = Date.now()): Preset {
    const current = store.get()
    const preset: Preset = {
      id: makeId(name, current),
      name: name.trim() || 'Untitled',
      selections: [...selections],
      createdAt: now,
    }
    persist([...current, preset])
    return preset
  },

  remove(id: string): void {
    persist(store.get().filter((preset) => preset.id !== id))
  },

  toJson(): string {
    return JSON.stringify({ presets: store.get() }, null, 2)
  },

  /**
   * Merge presets from exported JSON.
   *
   * Validates rather than trusting the file: a malformed entry is skipped and
   * counted, so importing someone else's file cannot corrupt the list.
   */
  fromJson(text: string): { imported: number; skipped: number } {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('That file is not valid JSON.')
    }

    const list = (parsed as { presets?: unknown }).presets
    if (!Array.isArray(list)) {
      throw new Error('Expected an object with a "presets" array.')
    }

    let imported = 0
    let skipped = 0
    let current = store.get()

    for (const entry of list) {
      const candidate = entry as Partial<Preset>
      const selections = candidate.selections
      if (
        typeof candidate.name !== 'string' ||
        !Array.isArray(selections) ||
        !selections.every(
          (selection) =>
            typeof (selection as Selection)?.measurementId === 'string',
        )
      ) {
        skipped++
        continue
      }
      const preset: Preset = {
        id: makeId(candidate.name, current),
        name: candidate.name,
        selections: selections as Selection[],
        createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
      }
      current = [...current, preset]
      imported++
    }

    persist(current)
    return { imported, skipped }
  },
}
