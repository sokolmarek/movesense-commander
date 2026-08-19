import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Copy, Info, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { toHex } from '@/lib/gsp/framing'
import type { TraceEntry, TraceRecorder } from '@/lib/gsp/trace'
import { useTrace } from '@/hooks/use-devices'

/**
 * Every GSP frame in and out, with a decoded summary and the raw bytes.
 *
 * This exists because BLE failures are otherwise invisible: a wrong byte looks
 * exactly like a sensor that is not responding. Traces are also the raw material
 * for fake-transport fixtures, so the copy button matters.
 */
export function TracePanel({ recorder }: { recorder: TraceRecorder }) {
  const entries = useTrace(recorder)
  const [showHex, setShowHex] = useState(true)
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!follow) return
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries, follow])

  const counts = useMemo(() => {
    let out = 0
    let incoming = 0
    for (const entry of entries) {
      if (entry.direction === 'out') out++
      else if (entry.direction === 'in') incoming++
    }
    return { out, in: incoming }
  }, [entries])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recorder.toText())
      toast.success('Trace copied to the clipboard')
    } catch {
      toast.error('Could not access the clipboard')
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Protocol trace</CardTitle>
          <p className="text-muted-foreground mt-1 text-xs tabular">
            {counts.out} sent · {counts.in} received
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="trace-hex" checked={showHex} onCheckedChange={setShowHex} />
            <Label htmlFor="trace-hex" className="text-xs font-normal">
              Hex
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="trace-follow" checked={follow} onCheckedChange={setFollow} />
            <Label htmlFor="trace-follow" className="text-xs font-normal">
              Follow
            </Label>
          </div>
          <Button size="sm" variant="secondary" onClick={copy} disabled={!entries.length}>
            <Copy className="size-3.5" />
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => recorder.clear()}
            disabled={!entries.length}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <div
          ref={scroller}
          className="bg-muted/30 h-72 overflow-y-auto rounded-md border p-2 font-mono text-xs"
        >
          {entries.length === 0 ? (
            <p className="text-muted-foreground p-2">
              Nothing yet. Frames appear here as soon as a sensor is connected.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {entries.map((entry) => (
                <TraceRow key={entry.id} entry={entry} showHex={showHex} />
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function TraceRow({ entry, showHex }: { entry: TraceEntry; showHex: boolean }) {
  return (
    <li className="flex gap-2 rounded px-1.5 py-1 hover:bg-muted/60">
      <span className="text-muted-foreground tabular w-16 shrink-0 text-right">
        {entry.at}ms
      </span>
      <span className="w-4 shrink-0 pt-px">
        {entry.direction === 'out' ? (
          <ArrowUpFromLine className="size-3" />
        ) : entry.direction === 'in' ? (
          <ArrowDownToLine className="size-3" />
        ) : (
          <Info className="text-muted-foreground size-3" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'break-words',
            entry.direction === 'note' && 'text-muted-foreground italic',
          )}
        >
          {entry.summary}
        </span>
        {showHex && entry.bytes ? (
          <span className="text-muted-foreground block break-all">
            {toHex(entry.bytes)}
          </span>
        ) : null}
      </span>
    </li>
  )
}
