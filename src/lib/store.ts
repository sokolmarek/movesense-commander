/**
 * Minimal observable store.
 *
 * Enough for `useSyncExternalStore` and nothing more - the app's state is a
 * handful of device snapshots, which does not justify a state library. The
 * snapshot is replaced rather than mutated, so its identity changes exactly
 * when its contents do.
 */
export interface Store<T> {
  get(): T
  set(next: T | ((previous: T) => T)): void
  subscribe(listener: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()

  return {
    get: () => state,
    set: (next) => {
      const value =
        typeof next === 'function' ? (next as (previous: T) => T)(state) : next
      if (value === state) return
      state = value
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
