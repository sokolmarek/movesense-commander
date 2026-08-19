import { useEffect, useMemo, useRef, useState } from 'react'
import { Info, Loader2, Radio, Send, Square, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { Page } from '@/components/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { DeviceSelect } from '@/components/device-select'
import { PayloadView } from '@/components/payload-view'
import { useSelectedDevice } from '@/lib/device/selected-device'
import type { DeviceSession } from '@/lib/device/session'
import type { Subscription } from '@/lib/gsp/client'
import { searchResources, type Resource } from '@/lib/api/resources'
import { cn } from '@/lib/utils'

export function Explorer() {
  const { session } = useSelectedDevice()

  return (
    <Page
      title="API explorer"
      description="Read any Movesense resource, or subscribe to it and watch the data arrive."
      actions={<DeviceSelect />}
    >
      {session ? (
        <ExplorerForDevice session={session} />
      ) : (
        <Alert>
          <Info className="size-4" />
          <AlertTitle>No connected sensor</AlertTitle>
          <AlertDescription>
            Connect a sensor on the dashboard to send requests.
          </AlertDescription>
        </Alert>
      )}
    </Page>
  )
}

interface GetResult {
  path: string
  status: number
  payload: Uint8Array
  at: number
}

interface StreamFrame {
  seq: number
  at: number
  payload: Uint8Array
}

function ExplorerForDevice({ session }: { session: DeviceSession }) {
  const [path, setPath] = useState('/Meas/Temp')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GetResult | null>(null)
  const [history, setHistory] = useState<string[]>([])

  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [frames, setFrames] = useState<StreamFrame[]>([])
  /**
   * The path the retained frames came from.
   *
   * Without this, stopping a stream and typing a different path left the old
   * frames on screen being decoded against the new path, which made it look as
   * though the new resource had returned them.
   */
  const [streamPath, setStreamPath] = useState<string | null>(null)
  const frameCount = useRef(0)
  const startedAt = useRef(0)

  const suggestions = useMemo(() => searchResources(path, 8), [path])
  const incomplete = path.includes('{')

  /** Every way of changing the path goes through here. */
  const selectPath = (next: string) => {
    setPath(next)
    // Retained frames belong to the previous path; do not relabel them.
    if (!subscription && frames.length > 0) {
      setFrames([])
      setStreamPath(null)
    }
  }

  // A subscription outlives a render, so make sure it cannot outlive the page.
  useEffect(() => {
    return () => {
      void subscription?.close()
    }
  }, [subscription])

  const runGet = async () => {
    setBusy(true)
    try {
      const response = await session.client.get(path)
      setResult({
        path,
        status: response.status,
        payload: response.data,
        at: Date.now(),
      })
      setHistory((current) => [path, ...current.filter((p) => p !== path)].slice(0, 12))
      if (response.status !== 200) {
        toast.warning(`${path} answered ${response.status}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const startStream = async () => {
    setBusy(true)

    // Close whatever is already running: two live subscriptions would both feed
    // this single piece of state, and the faster one would win.
    if (subscription) {
      const previous = subscription
      setSubscription(null)
      try {
        await previous.close()
      } catch {
        // Already gone; nothing to do.
      }
    }

    setFrames([])
    setStreamPath(path)
    frameCount.current = 0
    startedAt.current = Date.now()

    try {
      const active = await session.subscribeResource(path, (payload) => {
        frameCount.current += 1
        const frame: StreamFrame = {
          seq: frameCount.current,
          at: Date.now(),
          payload,
        }
        // Keep only the most recent frames: a 200 Hz stream would otherwise grow
        // without bound and take the page down with it.
        setFrames((current) => [frame, ...current].slice(0, 12))
      })
      setSubscription(active)
      setHistory((current) => [path, ...current.filter((p) => p !== path)].slice(0, 12))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const stopStream = async () => {
    const active = subscription
    setSubscription(null)
    try {
      await active?.close()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const elapsedSeconds = frames.length
    ? (Date.now() - startedAt.current) / 1000
    : 0

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="size-4" />
            Request
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="path">Resource path</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="path"
                value={path}
                spellCheck={false}
                onChange={(event) => selectPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !incomplete) void runGet()
                }}
                className="min-w-64 flex-1 font-mono"
                placeholder="/Meas/Temp"
              />
              <Button
                disabled={busy || incomplete || subscription !== null}
                onClick={() => void runGet()}
              >
                {busy && !subscription ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                GET
              </Button>
              {subscription ? (
                <Button variant="destructive" onClick={() => void stopStream()}>
                  <Square className="size-4" />
                  Stop
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  disabled={busy || incomplete}
                  onClick={() => void startStream()}
                >
                  <Radio className="size-4" />
                  Subscribe
                </Button>
              )}
            </div>
            {incomplete ? (
              <p className="text-warning text-xs">
                Replace <span className="font-mono">{'{n}'}</span> with a sample
                rate before sending.
              </p>
            ) : null}
          </div>

          {suggestions.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">Suggestions</p>
              <div className="flex flex-wrap gap-1">
                {suggestions.map((resource) => (
                  <SuggestionButton
                    key={resource.path}
                    resource={resource}
                    onPick={() => selectPath(resource.path)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">Recent</p>
              <div className="flex flex-wrap gap-1">
                {history.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => selectPath(entry)}
                    className="text-muted-foreground hover:bg-muted rounded-md px-2 py-1 font-mono text-xs"
                  >
                    {entry}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <Separator />

          <Alert>
            <Info className="size-4" />
            <AlertTitle>There is no generic write</AlertTitle>
            <AlertDescription>
              GSP offers GET and SUBSCRIBE for any path, but only four writes in
              total: DataLogger config, DataLogger state, system mode and UTC time.
              A resource the API reference lists as PUT-able is still read-only
              over this protocol. The writes we do support live on the Record page
              and the device card.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Response</CardTitle>
              <p className="text-muted-foreground mt-1 font-mono text-xs">
                GET {result.path}
              </p>
            </div>
            <Badge variant={result.status === 200 ? 'secondary' : 'destructive'}>
              {result.status}
            </Badge>
          </CardHeader>
          <CardContent>
            <PayloadView
              path={result.path}
              payload={result.payload}
              status={result.status}
            />
          </CardContent>
        </Card>
      ) : null}

      {subscription || frames.length > 0 ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Stream</CardTitle>
              <p className="text-muted-foreground mt-1 font-mono text-xs">
                {streamPath ?? path}
                {subscription ? ` · reference ${subscription.reference}` : ' · stopped'}
              </p>
            </div>
            <div className="text-muted-foreground text-right text-xs tabular">
              <div>{frameCount.current} frames</div>
              {elapsedSeconds > 0.5 ? (
                <div>{(frameCount.current / elapsedSeconds).toFixed(1)} /s</div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {frames.length === 0 ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                Subscribed. Waiting for the first frame…
              </p>
            ) : (
              <>
                <PayloadView
                  path={streamPath ?? path}
                  payload={frames[0]!.payload}
                />
                <p className="text-muted-foreground text-xs">
                  Showing the most recent frame. Earlier frames are discarded - a
                  high-rate stream would otherwise fill memory.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function SuggestionButton({
  resource,
  onPick,
}: {
  resource: Resource
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={resource.summary}
      className={cn(
        'hover:bg-muted rounded-md border px-2 py-1 text-left font-mono text-xs',
        'text-muted-foreground hover:text-foreground',
      )}
    >
      {resource.path}
      <span className="ml-1.5 font-sans opacity-60">
        {resource.operations.join('/')}
      </span>
    </button>
  )
}
