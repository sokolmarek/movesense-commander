import { useState } from 'react'
import {
  AlertTriangle,
  Download,
  HardDrive,
  HardDriveDownload,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Page } from '@/components/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DeviceSelect } from '@/components/device-select'
import { StoredLogRow } from '@/components/stored-log-row'
import { useSelectedDevice } from '@/lib/device/selected-device'
import type { DeviceSession } from '@/lib/device/session'
import type { LogbookEntry } from '@/lib/gsp/decoders'
import { GspStatusError } from '@/lib/gsp/errors'
import { formatBytes } from '@/lib/record/config'
import { logKey } from '@/lib/storage/db'
import { logStore } from '@/lib/storage/log-store'
import { useStoredLogs } from '@/hooks/use-stored-logs'
import { useDeviceSnapshot } from '@/hooks/use-devices'

export function Logs() {
  const { session } = useSelectedDevice()
  const stored = useStoredLogs()

  return (
    <Page
      title="Logs"
      description="Download recordings from the sensor and keep them here."
      actions={<DeviceSelect />}
    >
      <div className="space-y-6">
        {session ? (
          <SensorLogs session={session} />
        ) : (
          <Alert>
            <Info className="size-4" />
            <AlertTitle>No connected sensor</AlertTitle>
            <AlertDescription>
              Connect a sensor on the dashboard to list and download its
              recordings. Anything already downloaded is listed below.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <HardDrive className="size-4" />
                Downloaded
              </CardTitle>
              <p className="text-muted-foreground mt-1 text-xs tabular">
                {stored.logs.length} log{stored.logs.length === 1 ? '' : 's'} ·{' '}
                {formatBytes(stored.logs.reduce((sum, log) => sum + log.size, 0))} in
                this browser
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void logStore.refresh()}
              disabled={stored.loading}
            >
              {stored.loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          </CardHeader>
          <CardContent>
            {stored.error ? (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription>{stored.error}</AlertDescription>
              </Alert>
            ) : stored.logs.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing downloaded yet. Recordings you fetch are stored in this
                browser and never uploaded anywhere.
              </p>
            ) : (
              <div className="space-y-3">
                {stored.logs.map((log) => (
                  <StoredLogRow key={log.key} log={log} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}

interface DownloadProgress {
  logId: number
  /** Highest byte position reached, which is what the bar tracks. */
  position: number
  /** Everything delivered, which can exceed the file size if ranges were resent. */
  delivered: number
  total: number | null
  overrun: boolean
}

/**
 * Above this, a log is offered as a direct-to-disk download instead of being kept
 * in the browser. Decoding a very large recording builds an object per chunk, and
 * that is what a tab runs out of memory doing.
 */
const LARGE_LOG_BYTES = 2 * 1024 * 1024

/** File System Access, where the browser has it. */
function canSaveToDisk(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

function SensorLogs({ session }: { session: DeviceSession }) {
  const device = useDeviceSnapshot(session)
  const stored = useStoredLogs()
  const [listing, setListing] = useState<{
    entries: LogbookEntry[]
    declaredCount: number
    truncated: boolean
  } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [controller, setController] = useState<AbortController | null>(null)
  const [confirmErase, setConfirmErase] = useState(false)

  const serial = device.info?.serialNumber ?? device.id
  const busy = device.busy || pending !== null

  const refreshListing = async () => {
    setPending('list')
    try {
      const result = await session.listLogs()
      setListing(result)
      if (result.entries.length === 0) {
        toast.info('The sensor reports no recordings')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  const download = async (logId: number, entry?: LogbookEntry) => {
    const abort = new AbortController()
    setController(abort)
    setPending(`download-${logId}`)
    setProgress({
      logId,
      position: 0,
      delivered: 0,
      total: entry?.size ?? null,
      overrun: false,
    })

    try {
      const log = await session.downloadLog(logId, {
        ...(entry ? { expectedSize: entry.size, lastModified: entry.lastModified } : {}),
        signal: abort.signal,
        onProgress: ({ position, deliveredBytes, total, overrun }) =>
          setProgress({ logId, position, delivered: deliveredBytes, total, overrun }),
      })
      if (log.gaps.length > 0) {
        toast.warning(
          `Log ${logId} downloaded with ${log.gaps.length} gap(s). Download it again to fill them.`,
        )
      } else {
        toast.success(`Log ${logId} downloaded (${formatBytes(log.size)})`)
      }
      return true
    } catch (error) {
      if (error instanceof GspStatusError && error.status === 404) {
        return false
      }
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setPending(null)
      setProgress(null)
      setController(null)
    }
  }

  /**
   * Find logs the listing could not report, by downloading successive ids until
   * one 404s. There is no cheaper probe: GSP cannot cancel a fetch, so asking
   * "does this log exist" costs the whole log. We keep what we get.
   */
  const findMore = async () => {
    const known = listing?.entries.map((entry) => entry.id) ?? []
    let next = (known.length ? Math.max(...known) : 0) + 1
    let found = 0

    for (let attempt = 0; attempt < 16; attempt++) {
      const ok = await download(next)
      if (!ok) break
      found++
      next++
    }

    toast.info(
      found === 0
        ? `No further logs beyond id ${next - 1}`
        : `Found and downloaded ${found} additional log(s)`,
    )
  }

  /**
   * Download straight to a file the user picks, keeping nothing in the browser.
   *
   * The right shape for a large recording: no heap copy, no IndexedDB entry, and
   * no decode. The file is still a plain `.sbem` that this app or `sbem2json` can
   * read later.
   */
  const downloadToDisk = async (logId: number, entry?: LogbookEntry) => {
    const serialForName = device.info?.serialNumber ?? device.id
    const picker = window.showSaveFilePicker
    if (!picker) return

    let handle: FileSystemFileHandle
    try {
      handle = await picker({
        suggestedName: `Movesense_log_${logId}_${serialForName}.sbem`,
        types: [
          { description: 'SBEM recording', accept: { 'application/octet-stream': ['.sbem'] } },
        ],
      })
    } catch {
      // The picker was dismissed.
      return
    }

    const abort = new AbortController()
    setController(abort)
    setPending(`download-${logId}`)
    setProgress({
      logId,
      position: 0,
      delivered: 0,
      total: entry?.size ?? null,
      overrun: false,
    })

    const writable = await handle.createWritable()
    try {
      const { bytes, gaps } = await session.downloadLogToSink(
        logId,
        {
          write: async (chunk, offset) => {
            // Seek, because packets are offset-addressed and may arrive out of order.
            // The copy is for typing: Uint8Array over ArrayBufferLike is not a
            // BufferSource, and the copy is trivial next to the write.
            await writable.write({
              type: 'write',
              position: offset,
              data: new Uint8Array(chunk),
            })
          },
        },
        {
          ...(entry ? { expectedSize: entry.size } : {}),
          signal: abort.signal,
          onProgress: ({ position, deliveredBytes, total, overrun }) =>
            setProgress({ logId, position, delivered: deliveredBytes, total, overrun }),
        },
      )
      await writable.close()
      if (gaps.length > 0) {
        toast.warning(
          `Saved ${formatBytes(bytes)} with ${gaps.length} gap(s). Download again to fill them.`,
        )
      } else {
        toast.success(`Saved ${formatBytes(bytes)} to disk`)
      }
    } catch (error) {
      await writable.abort().catch(() => {})
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
      setProgress(null)
      setController(null)
    }
  }

  const erase = async () => {
    setPending('erase')
    try {
      await session.eraseMemory()
      setListing(null)
      setConfirmErase(false)
      toast.success('Sensor memory erased')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">On the sensor</CardTitle>
          <p className="text-muted-foreground mt-1 font-mono text-xs">{serial}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refreshListing()}>
            {pending === 'list' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            List logs
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {progress ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>
                Downloading log {progress.logId}
                {progress.total === null ? ' (size unknown)' : ''}
              </span>
              <span className="tabular">
                {formatBytes(progress.position)}
                {progress.total ? ` / ${formatBytes(progress.total)}` : ''}
              </span>
            </div>
            <Progress
              value={
                progress.total
                  ? // Clamped: a sensor that sends past the stated size must not
                    // push the bar off the end of its track.
                    Math.min(100, Math.max(0, (progress.position / progress.total) * 100))
                  : undefined
              }
            />
            {progress.overrun ? (
              <p className="text-warning text-xs">
                The sensor has sent more than the {formatBytes(progress.total ?? 0)} the
                logbook listed. The extra data is kept; the listed size was wrong or
                the log grew.
              </p>
            ) : null}
            {progress.delivered > progress.position ? (
              <p className="text-muted-foreground text-xs tabular">
                {formatBytes(progress.delivered)} delivered, including ranges the
                sensor sent more than once.
              </p>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => controller?.abort()}
              disabled={!controller}
            >
              <X className="size-3.5" />
              Cancel
            </Button>
          </div>
        ) : null}

        {listing === null ? (
          <p className="text-muted-foreground text-sm">
            Use <strong className="text-foreground">List logs</strong> to read the
            sensor&rsquo;s logbook.
          </p>
        ) : (
          <>
            {listing.truncated ? (
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertTitle>Listing is incomplete</AlertTitle>
                <AlertDescription>
                  The sensor reports {listing.declaredCount} recordings but only{' '}
                  {listing.entries.length} fit in a single notification, which is a
                  limit of the protocol rather than an error. Use{' '}
                  <strong>Find more</strong> to reach the rest.
                </AlertDescription>
              </Alert>
            ) : null}

            {listing.entries.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Id</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Modified</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listing.entries.map((entry) => {
                    const already = stored.logs.some(
                      (log) => log.key === logKey(serial, entry.id),
                    )
                    const large = entry.size >= LARGE_LOG_BYTES
                    return (
                      <TableRow key={entry.id}>
                        <TableCell className="tabular font-mono">{entry.id}</TableCell>
                        <TableCell className="tabular">
                          {formatBytes(entry.size)}
                          {large ? (
                            <span className="text-warning ml-1.5 text-xs">large</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular text-xs">
                          {entry.lastModified || '-'}
                        </TableCell>
                        <TableCell className="space-x-1 text-right">
                          <Button
                            size="sm"
                            variant={already ? 'ghost' : 'secondary'}
                            disabled={busy}
                            onClick={() => void download(entry.id, entry)}
                          >
                            {pending === `download-${entry.id}` ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            {already ? 'Download again' : 'Download'}
                          </Button>
                          {canSaveToDisk() ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              title="Stream straight to a file, keeping nothing in the browser"
                              onClick={() => void downloadToDisk(entry.id, entry)}
                            >
                              <HardDriveDownload className="size-3.5" />
                              To disk
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground text-sm">
                The logbook is empty.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void findMore()}>
                <Search className="size-3.5" />
                Find more
              </Button>
              {confirmErase ? (
                <>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void erase()}>
                    {pending === 'erase' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    Erase everything, permanently
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmErase(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => setConfirmErase(true)}
                >
                  <Trash2 className="size-3.5" />
                  Erase sensor memory
                </Button>
              )}
            </div>

            {listing.entries.some((entry) => entry.size >= LARGE_LOG_BYTES) ? (
              <p className="text-muted-foreground text-xs">
                Recordings over {formatBytes(LARGE_LOG_BYTES)} are marked large.
                {canSaveToDisk()
                  ? ' Prefer "To disk" for those: the bytes go straight to a file, so nothing large is held in the browser or decoded here.'
                  : ' This browser cannot write straight to a file, so a large log is held in memory. Chrome and Edge can stream it to disk instead.'}
              </p>
            ) : null}

            <p className="text-muted-foreground text-xs">
              <strong className="text-foreground">Find more</strong> downloads
              successive log ids until one is missing. GSP cannot cancel a transfer
              once it starts, so checking whether a log exists costs a full
              download - which is why the data is kept rather than
              discarded.
            </p>
            {confirmErase ? (
              <p className="text-destructive text-xs">
                Erasing removes every recording from the sensor. Download anything
                you want to keep first - there is no undo.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
