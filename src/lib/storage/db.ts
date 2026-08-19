/**
 * IndexedDB storage for downloaded recordings.
 *
 * Downloads are slow - a few kB/s over BLE - so a log is kept once fetched
 * rather than re-downloaded. Nothing leaves the browser: this is the whole of
 * the app's persistence.
 */

const DB_NAME = 'movesense-commander'
const DB_VERSION = 1
const LOG_STORE = 'logs'

export interface StoredLog {
  /** `${serial}:${logId}` - stable across reconnects. */
  key: string
  deviceId: string
  serial: string
  logId: number
  bytes: ArrayBuffer
  size: number
  downloadedAt: number
  /** Byte ranges that never arrived. Non-empty means the file has holes. */
  gaps: Array<[number, number]>
  /** From the logbook listing, when the log came from there. */
  lastModified: number | null
}

export function logKey(serial: string, logId: number): string {
  return `${serial}:${logId}`
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LOG_STORE)) {
        const store = db.createObjectStore(LOG_STORE, { keyPath: 'key' })
        store.createIndex('serial', 'serial', { unique: false })
        store.createIndex('downloadedAt', 'downloadedAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open database'))
  })

  return dbPromise
}

function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(LOG_STORE, mode)
        const request = action(transaction.objectStore(LOG_STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Database request failed'))
      }),
  )
}

export async function putStoredLog(log: StoredLog): Promise<void> {
  await run('readwrite', (store) => store.put(log))
}

export async function getStoredLog(key: string): Promise<StoredLog | undefined> {
  return run<StoredLog | undefined>('readonly', (store) => store.get(key))
}

export async function listStoredLogs(): Promise<StoredLog[]> {
  const all = await run<StoredLog[]>('readonly', (store) => store.getAll())
  return all.sort(
    (a, b) => b.downloadedAt - a.downloadedAt || b.logId - a.logId,
  )
}

export async function deleteStoredLog(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key))
}

export async function clearStoredLogs(): Promise<void> {
  await run('readwrite', (store) => store.clear())
}

/** Bytes held by stored logs, and the browser's quota if it will say. */
export async function storageUsage(): Promise<{
  logs: number
  bytes: number
  quota: number | null
}> {
  const logs = await listStoredLogs()
  const bytes = logs.reduce((sum, log) => sum + log.size, 0)

  let quota: number | null = null
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate()
      quota = estimate.quota ?? null
    } catch {
      // Not all browsers expose a quota; not worth surfacing.
    }
  }

  return { logs: logs.length, bytes, quota }
}
