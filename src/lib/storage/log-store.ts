import { createStore, type Store } from '@/lib/store'
import {
  deleteStoredLog,
  listStoredLogs,
  putStoredLog,
  type StoredLog,
} from './db'

/**
 * Observable view of the stored logs, so the UI re-renders after a download or a
 * delete without every component polling IndexedDB.
 */
export interface LogStoreState {
  readonly logs: readonly StoredLog[]
  readonly loading: boolean
  readonly error: string | null
}

class LogStore {
  private readonly store: Store<LogStoreState> = createStore<LogStoreState>({
    logs: [],
    loading: false,
    error: null,
  })

  private loaded = false

  getSnapshot(): LogStoreState {
    return this.store.get()
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Load once on first use; call `refresh` to force a re-read. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await this.refresh()
  }

  async refresh(): Promise<void> {
    this.patch({ loading: true, error: null })
    try {
      const logs = await listStoredLogs()
      this.patch({ logs, loading: false })
    } catch (error) {
      this.patch({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async save(log: StoredLog): Promise<void> {
    await putStoredLog(log)
    await this.refresh()
  }

  async remove(key: string): Promise<void> {
    await deleteStoredLog(key)
    await this.refresh()
  }

  private patch(changes: Partial<LogStoreState>): void {
    this.store.set((previous) => ({ ...previous, ...changes }))
  }
}

export const logStore = new LogStore()
