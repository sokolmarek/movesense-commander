/// <reference lib="webworker" />
import { decodeSbem, type SbemDocument } from './decode'
import { extractSamples, type SampleSeries } from './samples'
import { toJson, toJsonLines } from '@/lib/export/json'

/**
 * Decoding, off the main thread.
 *
 * Two problems this solves, both seen on a real recording:
 *
 *  - **The tab froze, then died.** `decodeSbem` builds an object per chunk, so a
 *    multi-megabyte log allocates hundreds of megabytes and blocks the UI thread
 *    for the duration. In a worker it neither blocks nor takes the page with it if
 *    it runs out of memory.
 *  - **The records were never needed on the main thread.** The UI wants a stream
 *    summary and sample series; the nested per-chunk records are an intermediate
 *    ten times their size. They stay here and are dropped as soon as the series
 *    are built.
 *
 * The document is kept alive per open log so an export does not have to decode
 * again, and `close` releases it.
 */

export interface WorkerSummary {
  readonly header: string
  readonly rootName: string | null
  readonly recordCount: number
  readonly streams: SbemDocument['streams']
  readonly warnings: SbemDocument['warnings']
  readonly skipped: SbemDocument['skipped']
  readonly scales: Record<string, number>
  readonly truncated: boolean
}

/** A series with its numbers moved rather than copied. */
export interface TransferableSeries {
  readonly key: string
  readonly stream: string
  readonly channel: string | null
  readonly columns: readonly string[]
  readonly estimatedRateHz: number | null
  readonly filledSamples: number
  readonly scale: number | null
  readonly timestamps: Float64Array
  readonly values: Float64Array[]
}

export type WorkerRequest =
  | { id: number; type: 'open'; key: string; bytes: ArrayBuffer; fillGaps: boolean }
  | { id: number; type: 'export'; key: string; format: 'json' | 'jsonl' }
  | { id: number; type: 'close'; key: string }

export type WorkerResponse =
  | {
      id: number
      type: 'opened'
      summary: WorkerSummary
      series: TransferableSeries[]
      anchor: ReturnType<typeof extractSamples>['anchor']
    }
  | { id: number; type: 'exported'; text: string }
  | { id: number; type: 'closed' }
  | { id: number; type: 'error'; message: string }

const open = new Map<string, SbemDocument>()

function toTransferable(series: SampleSeries): TransferableSeries {
  return {
    key: series.key,
    stream: series.stream,
    channel: series.channel,
    columns: [...series.columns],
    estimatedRateHz: series.estimatedRateHz,
    filledSamples: series.filledSamples,
    scale: series.scale,
    timestamps: Float64Array.from(series.timestamps),
    values: series.values.map((column) => Float64Array.from(column)),
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  try {
    if (request.type === 'open') {
      const document = decodeSbem(new Uint8Array(request.bytes))
      open.set(request.key, document)

      const set = extractSamples(
        document,
        request.fillGaps ? { fillGaps: true } : {},
      )
      const series = set.series.map(toTransferable)

      const summary: WorkerSummary = {
        header: document.header,
        rootName: document.rootName,
        recordCount: document.records.length,
        streams: document.streams,
        warnings: document.warnings,
        skipped: document.skipped,
        scales: document.scales,
        truncated: document.truncated,
      }

      const response: WorkerResponse = {
        id: request.id,
        type: 'opened',
        summary,
        series,
        anchor: set.anchor,
      }

      // Move the sample buffers rather than copying them.
      const transfer = series.flatMap((entry) => [
        entry.timestamps.buffer,
        ...entry.values.map((column) => column.buffer),
      ])
      self.postMessage(response, transfer)
      return
    }

    if (request.type === 'export') {
      const document = open.get(request.key)
      if (!document) throw new Error('That log is no longer open for export.')
      const text =
        request.format === 'jsonl' ? toJsonLines(document) : toJson(document)
      self.postMessage({ id: request.id, type: 'exported', text } satisfies WorkerResponse)
      return
    }

    open.delete(request.key)
    self.postMessage({ id: request.id, type: 'closed' } satisfies WorkerResponse)
  } catch (error) {
    self.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse)
  }
}
