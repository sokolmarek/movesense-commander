import { useMemo, useState } from 'react'
import { Braces, FileSpreadsheet, HeartPulse, Loader2, Package } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Waveform } from '@/components/waveform'
import { csvFileName, seriesToCsv } from '@/lib/export/csv'
import { buildEdf } from '@/lib/export/edf'
import { createZip } from '@/lib/export/zip'
import { exportLogText, type OpenedLog } from '@/lib/sbem/decode-client'
import type { StoredLog } from '@/lib/storage/db'
import { cn } from '@/lib/utils'

function save(name: string, data: string | Uint8Array, type: string) {
  // Copy into a fresh buffer: TypeScript models Uint8Array over ArrayBufferLike,
  // which is not assignable to BlobPart, and a copy is cheap next to the download.
  const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data).buffer
  const url = URL.createObjectURL(new Blob([part], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Export buttons and a waveform preview for one decoded log. */
export function LogExports({ log, opened }: { log: StoredLog; opened: OpenedLog }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)

  const base = `Movesense_log_${log.logId}_${log.serial}`
  const series = opened.series
  const active = series.find((entry) => entry.key === selected) ?? series[0] ?? null

  const scaled = useMemo(
    () => series.filter((entry) => entry.scale !== null).map((entry) => entry.key),
    [series],
  )

  /**
   * JSON is built in the worker, which still holds the decoded records. Doing it
   * here would mean shipping the whole record set across for one string.
   */
  const exportText = async (format: 'json' | 'jsonl') => {
    setExporting(format)
    try {
      const text = await exportLogText(log.key, format)
      save(
        `${base}.${format}`,
        text,
        format === 'json' ? 'application/json' : 'application/x-ndjson',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(null)
    }
  }

  const exportCsvZip = () => {
    const entries = series.map((entry) => ({
      name: csvFileName(entry, { serial: log.serial, logId: log.logId }),
      data: new TextEncoder().encode(
        seriesToCsv(entry, { anchor: opened.anchor }),
      ),
    }))
    if (entries.length === 0) {
      toast.error('Nothing to export: no sample series in this log')
      return
    }
    if (entries.length === 1) {
      save(entries[0]!.name, entries[0]!.data, 'text/csv')
      return
    }
    save(
      `${base}_csv.zip`,
      createZip(entries, new Date(log.downloadedAt)),
      'application/zip',
    )
  }

  const exportEdf = () => {
    const result = buildEdf(series, {
      startTime: new Date(log.downloadedAt),
      equipment: 'Movesense',
    })
    if (result.bytes.length === 0) {
      toast.error(
        result.skipped[0]?.reason ?? 'No series in this log can be written as EDF',
      )
      return
    }
    save(`${base}.edf`, result.bytes, 'application/octet-stream')
    for (const note of result.notes) toast.info(note)
    for (const skip of result.skipped) {
      toast.warning(`${skip.key} left out of the EDF: ${skip.reason}`)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={exporting !== null}
          onClick={() => void exportText('json')}
        >
          {exporting === 'json' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Braces className="size-3.5" />
          )}
          JSON
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={exporting !== null}
          onClick={() => void exportText('jsonl')}
        >
          {exporting === 'jsonl' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Braces className="size-3.5" />
          )}
          JSONL
        </Button>
        <Button size="sm" variant="secondary" onClick={exportCsvZip}>
          {series.length > 1 ? (
            <Package className="size-3.5" />
          ) : (
            <FileSpreadsheet className="size-3.5" />
          )}
          CSV{series.length > 1 ? ` (${series.length} files, zipped)` : ''}
        </Button>
        <Button size="sm" variant="secondary" onClick={exportEdf}>
          <HeartPulse className="size-3.5" />
          EDF+
        </Button>
      </div>

      <p className="text-muted-foreground text-xs">
        JSON keeps the values exactly as stored, matching what{' '}
        <span className="font-mono">sbem2json</span> reports. CSV, EDF and the chart
        apply the scale factor from the log&rsquo;s own descriptor, so they are in
        physical units.
        {scaled.length > 0
          ? ` Scaled here: ${scaled.join(', ')}.`
          : ' No stream in this log declares a scale factor.'}
      </p>

      {series.length > 0 && active ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {series.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSelected(entry.key)}
                aria-pressed={entry.key === active.key}
                className={cn(
                  'rounded-md px-2.5 py-1 font-mono text-xs transition-colors',
                  entry.key === active.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {entry.key}
              </button>
            ))}
          </div>
          <Waveform series={active} />
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No sample series to plot in this log.
        </p>
      )}
    </div>
  )
}
