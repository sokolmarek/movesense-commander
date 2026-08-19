import { lazy, Suspense, useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileDown,
  Loader2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { closeLog, openLog, type OpenedLog } from '@/lib/sbem/decode-client'
import { formatBytes } from '@/lib/record/config'
import { getStoredLog, type StoredLog } from '@/lib/storage/db'
import { logStore } from '@/lib/storage/log-store'

/**
 * The exporters and the chart library are only needed once a log is opened, and
 * uPlot alone is a sizeable dependency, so they load on demand.
 */
const LogExports = lazy(() =>
  import('@/components/log-exports').then((module) => ({
    default: module.LogExports,
  })),
)

/**
 * Above this a log is decoded only when the user explicitly asks.
 *
 * Decoding builds an object per chunk, and on a real multi-megabyte recording that
 * was enough to take the tab down. It now runs in a worker, so the page survives
 * either way, but a long wait should still be the user's choice rather than a
 * side effect of clicking a row.
 */
const CONFIRM_DECODE_BYTES = 2 * 1024 * 1024

/** One downloaded recording: what it is, what is in it, and how to get it out. */
export function StoredLogRow({ log }: { log: StoredLog }) {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState<OpenedLog | null>(null)
  const [decoding, setDecoding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [fillGaps, setFillGaps] = useState(false)

  const missingBytes = log.gaps.reduce((sum, [start, end]) => sum + (end - start), 0)
  const large = log.size >= CONFIRM_DECODE_BYTES
  const needsConfirmation = large && !confirmed

  // Release the worker's copy when the row closes or unmounts.
  useEffect(() => {
    if (open) return
    return () => {
      void closeLog(log.key)
    }
  }, [open, log.key])

  const decode = async (bridgeGaps = fillGaps) => {
    setDecoding(true)
    setError(null)
    try {
      // Re-read from IndexedDB: `openLog` transfers the buffer to the worker, so
      // the copy held in the list must not be the one handed over.
      const fresh = await getStoredLog(log.key)
      if (!fresh) throw new Error('That recording is no longer stored.')
      setOpened(await openLog(log.key, fresh.bytes, { fillGaps: bridgeGaps }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast.error(`Could not decode log ${log.logId}: ${message}`)
    } finally {
      setDecoding(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && opened === null && !decoding && !needsConfirmation) void decode()
  }

  const saveRaw = () => {
    const blob = new Blob([log.bytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `Movesense_log_${log.logId}_${log.serial}.sbem`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className="size-4 shrink-0" />
          )}
          <span className="font-mono text-sm">
            log {log.logId} · {log.serial}
          </span>
          <span className="text-muted-foreground tabular text-xs">
            {formatBytes(log.size)}
          </span>
          <span className="text-muted-foreground text-xs">
            {new Date(log.downloadedAt).toLocaleString()}
          </span>
          {missingBytes > 0 ? (
            <Badge variant="destructive" className="gap-1 text-xs">
              <AlertTriangle className="size-3" />
              {formatBytes(missingBytes)} missing
            </Badge>
          ) : null}
        </button>

        <Button size="sm" variant="secondary" onClick={saveRaw}>
          <FileDown className="size-3.5" />
          Save .sbem
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void logStore.remove(log.key)}
          aria-label={`Delete log ${log.logId}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {open ? (
        <div className="space-y-3 border-t p-3 text-sm">
          {needsConfirmation && opened === null ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">
                This recording is {formatBytes(log.size)}. Decoding it builds one
                object per chunk, which takes a while and a lot of memory. It runs
                off the main thread, so the page stays usable, but it is your call.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmed(true)
                    void decode()
                  }}
                >
                  Decode anyway
                </Button>
                <Button size="sm" variant="secondary" onClick={saveRaw}>
                  <FileDown className="size-3.5" />
                  Save the raw file instead
                </Button>
              </div>
            </div>
          ) : decoding ? (
            <p className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Decoding in the background…
            </p>
          ) : error !== null ? (
            <div className="space-y-2">
              <p className="text-destructive">{error}</p>
              <Button size="sm" variant="secondary" onClick={() => void decode()}>
                Try again
              </Button>
            </div>
          ) : opened ? (
            <>
              <LogContents opened={opened} missingBytes={missingBytes} />

              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  id={`fill-${log.key}`}
                  checked={fillGaps}
                  onCheckedChange={(value) => {
                    setFillGaps(value)
                    // Gap bridging happens during extraction, so changing it means
                    // decoding again.
                    void decode(value)
                  }}
                />
                <Label htmlFor={`fill-${log.key}`} className="text-xs font-normal">
                  Bridge gaps
                </Label>
                <span className="text-muted-foreground text-xs">
                  {fillGaps
                    ? 'Missing chunks are filled with -1.5 so the rate stays constant, which EDF and most analysis tools assume.'
                    : 'A dropped chunk shows as a jump in the timestamps.'}
                </span>
              </div>
              <Suspense
                fallback={
                  <p className="text-muted-foreground flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Loading export tools…
                  </p>
                }
              >
                <LogExports log={log} opened={opened} />
              </Suspense>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function LogContents({
  opened,
  missingBytes,
}: {
  opened: OpenedLog
  missingBytes: number
}) {
  const { summary } = opened

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground font-mono text-xs">
        {summary.header} · {summary.recordCount.toLocaleString()} records
        {summary.rootName ? ` · root "${summary.rootName}"` : ''}
      </p>

      {missingBytes > 0 ? (
        <p className="text-destructive text-xs">
          This file has holes from lost notifications, so some chunks below are
          missing or were skipped. Download the log again to fill them.
        </p>
      ) : null}

      {summary.streams.length === 0 ? (
        <p className="text-muted-foreground">
          No decodable streams. The log may be empty or truncated.
        </p>
      ) : (
        <ul className="space-y-1">
          {summary.streams.map((stream) => (
            <li key={stream.stream} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{stream.stream}</span>
              <span className="text-muted-foreground tabular text-xs">
                {stream.records.toLocaleString()} records ·{' '}
                {stream.samples.toLocaleString()} samples
              </span>
              {stream.firstTimestamp !== null && stream.lastTimestamp !== null ? (
                <span className="text-muted-foreground tabular text-xs">
                  t {stream.firstTimestamp}-{stream.lastTimestamp}
                </span>
              ) : null}
              <span className="text-muted-foreground font-mono text-xs">
                id {stream.dataIds.join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {summary.skipped.length > 0 ? (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer">
            {summary.skipped.length} chunk(s) skipped
          </summary>
          <ul className="text-muted-foreground mt-1 space-y-0.5 font-mono">
            {summary.skipped.slice(0, 20).map((entry, index) => (
              <li key={`${entry.offset}-${index}`}>
                offset {entry.offset}: {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {summary.warnings.length > 0 ? (
        <ul className="text-muted-foreground space-y-1 text-xs">
          {summary.warnings.map((warning) => (
            <li key={`${warning.kind}-${warning.offset}`}>{warning.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
