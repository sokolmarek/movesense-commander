import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  AlertTriangle,
  Download,
  Info,
  Loader2,
  Radio,
  RotateCcw,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { Page } from '@/components/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { DeviceSelect } from '@/components/device-select'
/**
 * uPlot is a sizeable dependency and only needed once a stream is running, so it
 * loads on demand rather than in the initial bundle.
 */
const LiveChart = lazy(() =>
  import('@/components/live-chart').then((module) => ({ default: module.LiveChart })),
)
import { useSelectedDevice } from '@/lib/device/selected-device'
import type { DeviceSession } from '@/lib/device/session'
import type { Subscription } from '@/lib/gsp/client'
import { LiveStream } from '@/lib/stream/live'
import { MEASUREMENTS, measurementPath } from '@/lib/api/catalog'
import { seriesToCsv, csvFileName } from '@/lib/export/csv'
import { createZip } from '@/lib/export/zip'
import { formatBytes } from '@/lib/record/config'
import { useSettings } from '@/hooks/use-settings'
import { cn } from '@/lib/utils'

const WINDOW_OPTIONS = [5, 10, 30, 60] as const

export function Stream() {
  const { session } = useSelectedDevice()

  return (
    <Page
      title="Live stream"
      description="Subscribe to a measurement and watch it arrive in real time."
      actions={<DeviceSelect />}
    >
      {session ? (
        <StreamForDevice session={session} />
      ) : (
        <Alert>
          <Info className="size-4" />
          <AlertTitle>No connected sensor</AlertTitle>
          <AlertDescription>
            Connect a sensor on the dashboard to stream from it.
          </AlertDescription>
        </Alert>
      )}
    </Page>
  )
}

/** Streamable measurements, with a sensible default rate for each. */
const STREAMABLE = MEASUREMENTS.map((measurement) => ({
  id: measurement.id,
  label: measurement.label,
  path: measurementPath(measurement),
  rates: measurement.rates,
  defaultRate: measurement.defaultRate,
}))

function StreamForDevice({ session }: { session: DeviceSession }) {
  const settings = useSettings()
  const [measurementId, setMeasurementId] = useState('ecg')
  const [rate, setRate] = useState<number | undefined>(200)
  const [windowSeconds, setWindowSeconds] = useState<number>(10)
  const [stream, setStream] = useState<LiveStream | null>(null)
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [busy, setBusy] = useState(false)
  const subscriptionRef = useRef<Subscription | null>(null)

  subscriptionRef.current = subscription

  const measurement = STREAMABLE.find((m) => m.id === measurementId)!
  const spec = MEASUREMENTS.find((m) => m.id === measurementId)!
  const path = measurementPath(spec, rate)

  // A subscription must never outlive the page.
  useEffect(() => {
    return () => {
      void subscriptionRef.current?.close()
    }
  }, [])

  const start = async () => {
    setBusy(true)
    if (subscription) {
      const previous = subscription
      setSubscription(null)
      try {
        await previous.close()
      } catch {
        // Already gone.
      }
    }

    const live = new LiveStream(path, { maxSamples: settings.liveBufferSamples })
    setStream(live)
    try {
      const active = await session.subscribeResource(path, (payload) =>
        live.push(payload),
      )
      setSubscription(active)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setStream(null)
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    const active = subscription
    setSubscription(null)
    try {
      await active?.close()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subscription</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="measurement">Measurement</Label>
              <select
                id="measurement"
                className="bg-background h-9 rounded-md border px-2 text-sm"
                value={measurementId}
                disabled={subscription !== null}
                onChange={(event) => {
                  const next = event.target.value
                  setMeasurementId(next)
                  const chosen = MEASUREMENTS.find((m) => m.id === next)!
                  setRate(chosen.defaultRate ?? chosen.rates[0])
                }}
              >
                {STREAMABLE.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            {measurement.rates.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="rate">Rate</Label>
                <select
                  id="rate"
                  className="bg-background h-9 rounded-md border px-2 text-sm"
                  value={rate}
                  disabled={subscription !== null}
                  onChange={(event) => setRate(Number(event.target.value))}
                >
                  {measurement.rates.map((option) => (
                    <option key={option} value={option}>
                      {option} Hz
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="window">Window</Label>
              <select
                id="window"
                className="bg-background h-9 rounded-md border px-2 text-sm"
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
              >
                {WINDOW_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option} s
                  </option>
                ))}
              </select>
            </div>

            {subscription ? (
              <Button variant="destructive" onClick={() => void stop()}>
                <Square className="size-4" />
                Stop
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void start()}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Radio className="size-4" />
                )}
                Subscribe
              </Button>
            )}
          </div>

          <p className="text-muted-foreground font-mono text-xs">{path}</p>
        </CardContent>
      </Card>

      {stream ? (
        <StreamView
          stream={stream}
          live={subscription !== null}
          windowSeconds={windowSeconds}
          serial={session.getSnapshot().info?.serialNumber ?? session.id}
        />
      ) : null}
    </div>
  )
}

function StreamView({
  stream,
  live,
  windowSeconds,
  serial,
}: {
  stream: LiveStream
  live: boolean
  windowSeconds: number
  serial: string
}) {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => stream.subscribe(listener), [stream]),
    () => stream.getSnapshot(),
    () => stream.getSnapshot(),
  )

  const exportCsv = () => {
    const entries = state.channels.map((channel) => ({
      name: csvFileName(
        {
          key: channel.field,
          stream: state.path.replace(/^\//, '').replace(/\//g, '_'),
          channel: channel.label,
          columns: channel.columns,
          timestamps: channel.time,
          values: channel.values,
          estimatedRateHz: state.measuredHz,
          filledSamples: 0,
          scale: channel.unit.scale,
        },
        { serial, logId: 0 },
      ),
      data: new TextEncoder().encode(
        seriesToCsv({
          key: channel.field,
          stream: state.path,
          channel: channel.label,
          columns: channel.columns,
          timestamps: channel.time,
          values: channel.values,
          estimatedRateHz: state.measuredHz,
          filledSamples: 0,
          scale: channel.unit.scale,
        }),
      ),
    }))

    if (entries.length === 0) {
      toast.error('Nothing captured yet')
      return
    }

    const blob =
      entries.length === 1
        ? new Blob([entries[0]!.data as BlobPart], { type: 'text/csv' })
        : new Blob([createZip(entries).slice().buffer as BlobPart], {
            type: 'application/zip',
          })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download =
      entries.length === 1 ? entries[0]!.name : `Movesense_stream_${serial}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const lossPercent =
    state.samples + state.droppedSamples > 0
      ? (state.droppedSamples / (state.samples + state.droppedSamples)) * 100
      : 0

  return (
    <>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            {live ? (
              <>
                <span className="bg-recording size-2 animate-pulse rounded-full" />
                Streaming
              </>
            ) : (
              'Stopped'
            )}
          </CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={exportCsv}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
            <Button size="sm" variant="ghost" onClick={() => stream.reset()}>
              <RotateCcw className="size-3.5" />
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-5">
            <Stat label="Packets" value={state.packets.toLocaleString()} />
            <Stat label="Samples" value={state.samples.toLocaleString()} />
            <Stat
              label="Rate"
              value={
                state.measuredHz === null
                  ? '-'
                  : `${state.measuredHz.toFixed(1)} Hz`
              }
              hint={state.requestedHz ? `asked ${state.requestedHz} Hz` : 'sensor paced'}
            />
            <Stat
              label="Lost"
              value={
                state.requestedHz === null
                  ? 'n/a'
                  : `${state.droppedSamples.toLocaleString()}`
              }
              hint={
                state.requestedHz === null
                  ? 'no rate to compare'
                  : `${lossPercent.toFixed(2)}%`
              }
              warn={state.droppedSamples > 0}
            />
            <Stat label="Received" value={formatBytes(state.bytes)} />
          </dl>

          {state.undecodable > 0 ? (
            <Alert variant="destructive" className="mt-4">
              <AlertTriangle className="size-4" />
              <AlertTitle>
                {state.undecodable} packet
                {state.undecodable === 1 ? '' : 's'} could not be decoded
              </AlertTitle>
              <AlertDescription>
                No registered layout fits them exactly. Inspect the raw bytes in the
                API explorer - that is how the layouts we do trust were established.
              </AlertDescription>
            </Alert>
          ) : null}

          {state.requestedHz === null ? (
            <p className="text-muted-foreground mt-3 text-xs">
              This stream has no rate in its path, so the sensor sets the pace and
              lost packets cannot be counted.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {state.channels.map((channel) => (
        <Card key={channel.field}>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              {channel.label}
              {channel.unit.unit ? (
                <span className="text-muted-foreground ml-2 text-sm font-normal">
                  {channel.unit.unit}
                </span>
              ) : null}
            </CardTitle>
            <Badge variant="secondary" className="tabular text-xs">
              {channel.time.length.toLocaleString()} buffered
            </Badge>
          </CardHeader>
          <CardContent>
            <Suspense
              fallback={
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" />
                  Loading chart…
                </p>
              }
            >
              <LiveChart channel={channel} windowSeconds={windowSeconds} />
            </Suspense>
          </CardContent>
        </Card>
      ))}
    </>
  )
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string
  value: string
  hint?: string
  warn?: boolean
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('tabular mt-0.5 font-medium', warn && 'text-destructive')}>
        {value}
      </dd>
      {hint ? <dd className="text-muted-foreground text-xs">{hint}</dd> : null}
    </div>
  )
}
