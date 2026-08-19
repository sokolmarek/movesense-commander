import type { SampleSeries, TimeAnchor } from './samples'
import type {
  TransferableSeries,
  WorkerRequest,
  WorkerResponse,
  WorkerSummary,
} from './decode-worker'

/**
 * Main-thread handle on the decode worker.
 *
 * One worker is shared: decoding is CPU-bound, so several in parallel would only
 * compete. Requests are matched by id, the same discipline the GSP client uses for
 * reference codes.
 */

export interface OpenedLog {
  readonly summary: WorkerSummary
  readonly series: SampleSeries[]
  readonly anchor: TimeAnchor | null
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<
  number,
  { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void }
>()

function ensureWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./decode-worker.ts', import.meta.url), {
    type: 'module',
  })

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    entry.resolve(event.data)
  }

  worker.onerror = (event) => {
    // A worker-level failure (out of memory, for instance) kills every request on
    // it, so fail them all and start fresh next time rather than hanging.
    const error = new Error(
      event.message || 'The decoder stopped unexpectedly, probably out of memory.',
    )
    for (const [, entry] of pending) entry.reject(error)
    pending.clear()
    worker?.terminate()
    worker = null
  }

  return worker
}

function send(request: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
  const instance = ensureWorker()
  return new Promise<WorkerResponse>((resolve, reject) => {
    pending.set(request.id, { resolve, reject })
    instance.postMessage(request, transfer)
  })
}

function fromTransferable(series: TransferableSeries): SampleSeries {
  return {
    key: series.key,
    stream: series.stream,
    channel: series.channel,
    columns: series.columns,
    estimatedRateHz: series.estimatedRateHz,
    filledSamples: series.filledSamples,
    scale: series.scale,
    // uPlot and the exporters want plain arrays.
    timestamps: Array.from(series.timestamps),
    values: series.values.map((column) => Array.from(column)),
  }
}

/**
 * Decode a log and return its summary and sample series.
 *
 * `bytes` is transferred, not copied, so the caller must not use it afterwards.
 */
export async function openLog(
  key: string,
  bytes: ArrayBuffer,
  options: { fillGaps?: boolean } = {},
): Promise<OpenedLog> {
  const response = await send(
    {
      id: nextId++,
      type: 'open',
      key,
      bytes,
      fillGaps: options.fillGaps === true,
    },
    [bytes],
  )

  if (response.type === 'error') throw new Error(response.message)
  if (response.type !== 'opened') throw new Error('Unexpected reply from the decoder')

  return {
    summary: response.summary,
    series: response.series.map(fromTransferable),
    anchor: response.anchor,
  }
}

/** JSON or JSONL text, built in the worker so the main thread holds one copy. */
export async function exportLogText(
  key: string,
  format: 'json' | 'jsonl',
): Promise<string> {
  const response = await send({ id: nextId++, type: 'export', key, format })
  if (response.type === 'error') throw new Error(response.message)
  if (response.type !== 'exported') throw new Error('Unexpected reply from the decoder')
  return response.text
}

/** Release the worker's copy of a decoded log. */
export async function closeLog(key: string): Promise<void> {
  await send({ id: nextId++, type: 'close', key }).catch(() => {
    // Closing is best-effort; a dead worker has already released everything.
  })
}
