import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CircleDot,
  Info,
  Loader2,
  Save,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { Page } from '@/components/page'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { DeviceSelect } from '@/components/device-select'
import { Input } from '@/components/ui/input'
import { useSelectedDevice } from '@/lib/device/selected-device'
import { presetStore } from '@/lib/record/presets'
import { usePresets, useSettings } from '@/hooks/use-settings'
import { MEASUREMENTS } from '@/lib/api/catalog'
import { DataLoggerState } from '@/lib/gsp/constants'
import {
  buildRecordingPlan,
  formatDataRate,
  formatDuration,
  type Selection,
} from '@/lib/record/config'
import { useDeviceSnapshot } from '@/hooks/use-devices'
import type { DeviceSession } from '@/lib/device/session'
import { cn } from '@/lib/utils'

export function Record() {
  const { session, sessions, connected } = useSelectedDevice()

  return (
    <Page
      title="Record"
      description="Choose what the sensor logs to its own memory, then start and stop recording."
      actions={<DeviceSelect />}
    >
      {session ? (
        <RecordForDevice session={session} connected={connected} />
      ) : (
        <Alert>
          <Info className="size-4" />
          <AlertTitle>No connected sensor</AlertTitle>
          <AlertDescription>
            {sessions.length
              ? 'Reconnect a sensor on the dashboard to configure a recording.'
              : 'Connect a sensor on the dashboard first.'}
          </AlertDescription>
        </Alert>
      )}
    </Page>
  )
}

function RecordForDevice({
  session,
  connected,
}: {
  session: DeviceSession
  connected: readonly DeviceSession[]
}) {
  const device = useDeviceSnapshot(session)
  const settings = useSettings()
  const presets = usePresets()
  const [selections, setSelections] = useState<Selection[]>([
    { measurementId: 'ecg', rate: 200 },
  ])
  const [rollOver, setRollOver] = useState(settings.rebootAfterStop)
  const [applyToAll, setApplyToAll] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  // Which sensors an action touches. With one connected there is no difference.
  const targets = applyToAll && connected.length > 1 ? connected : [session]

  /** Run an action against every target, collecting failures rather than stopping. */
  const forEachTarget = async (
    action: (target: DeviceSession) => Promise<void>,
  ): Promise<void> => {
    const failures: string[] = []
    for (const target of targets) {
      try {
        await action(target)
      } catch (error) {
        const serial = target.getSnapshot().info?.serialNumber ?? target.id
        failures.push(`${serial}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '))
  }

  const plan = useMemo(() => buildRecordingPlan(selections), [selections])
  const recording = device.dataLoggerState === DataLoggerState.Logging
  const busy = device.busy || pending !== null

  const toggle = (id: string) => {
    setSelections((current) => {
      const existing = current.find((s) => s.measurementId === id)
      if (existing) return current.filter((s) => s.measurementId !== id)
      const spec = MEASUREMENTS.find((m) => m.id === id)
      const rate = spec?.defaultRate ?? spec?.rates[0]
      return [...current, rate === undefined ? { measurementId: id } : { measurementId: id, rate }]
    })
  }

  const setRate = (id: string, rate: number) => {
    setSelections((current) =>
      current.map((s) => (s.measurementId === id ? { ...s, rate } : s)),
    )
  }

  const act = async (label: string, action: () => Promise<void>, success: string) => {
    setPending(label)
    try {
      await action()
      toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-6">
      {recording ? <RecordingBanner session={session} /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Measurements</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {MEASUREMENTS.map((measurement) => {
            const selection = selections.find(
              (s) => s.measurementId === measurement.id,
            )
            const selected = selection !== undefined
            return (
              <div
                key={measurement.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 rounded-md px-2 py-2 transition-colors',
                  selected && 'bg-muted/50',
                )}
              >
                <Switch
                  id={`meas-${measurement.id}`}
                  checked={selected}
                  disabled={recording}
                  onCheckedChange={() => toggle(measurement.id)}
                />
                <Label
                  htmlFor={`meas-${measurement.id}`}
                  className="w-48 shrink-0 font-normal"
                >
                  {measurement.label}
                </Label>

                {measurement.rates.length > 0 ? (
                  <select
                    aria-label={`${measurement.label} sample rate`}
                    className="bg-background h-8 rounded-md border px-2 text-sm disabled:opacity-50"
                    value={selection?.rate ?? measurement.defaultRate ?? measurement.rates[0]}
                    disabled={!selected || recording}
                    onChange={(event) =>
                      setRate(measurement.id, Number(event.target.value))
                    }
                  >
                    {measurement.rates.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate} Hz
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-muted-foreground w-20 text-xs">
                    sensor paced
                  </span>
                )}

                {measurement.note ? (
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs">
                    {measurement.note}
                  </span>
                ) : null}
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Presets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={presetName}
              placeholder="Preset name"
              className="h-9 w-48"
              disabled={recording}
              onChange={(event) => setPresetName(event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!plan.valid || recording || presetName.trim().length === 0}
              onClick={() => {
                presetStore.save(presetName, selections)
                setPresetName('')
                toast.success('Preset saved')
              }}
            >
              <Save className="size-3.5" />
              Save current
            </Button>
          </div>

          {presets.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              None saved yet. Presets are stored in this browser and can be exported
              from Settings.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  disabled={recording}
                  onClick={() => setSelections([...preset.selections])}
                  className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
                >
                  {preset.name}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration to write</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {plan.paths.length ? (
            <ul className="space-y-1 font-mono text-sm">
              {plan.paths.map((path) => (
                <li key={path} className="flex items-center gap-2">
                  <span>{path}</span>
                  {path === '/Time/Detailed' ? (
                    <Badge variant="outline" className="text-xs font-sans">
                      always added
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              Nothing selected. Pick at least one measurement.
            </p>
          )}

          <div className="text-muted-foreground flex items-center gap-4 text-sm">
            <span className="tabular">
              Estimated {formatDataRate(plan.throughput.bytesPerSecond)}
            </span>
            {plan.throughput.bytesPerSecond > 0 ? (
              <span className="tabular">
                {formatDataRate(plan.throughput.bytesPerSecond * 60).replace(
                  '/s',
                  '/min',
                )}
              </span>
            ) : null}
          </div>

          {plan.warnings.map((warning) => (
            <Alert
              key={warning.message}
              variant={warning.level === 'warning' ? 'destructive' : 'default'}
            >
              {warning.level === 'warning' ? (
                <AlertTriangle className="size-4" />
              ) : (
                <Info className="size-4" />
              )}
              <AlertDescription>{warning.message}</AlertDescription>
            </Alert>
          ))}

          <p className="text-muted-foreground text-xs">
            The data rate is an estimate from the selected rates and our own guess
            at record sizes, plus 10% for SBEM framing. It is not read from the
            sensor. Time until memory fills is not shown because we do not read
            the sensor&rsquo;s capacity yet.
          </p>

          <Separator />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={!plan.valid || busy || recording}
              onClick={() =>
                void act(
                  'configure',
                  () => forEachTarget((target) => target.configure(plan.paths)),
                  `Configuration written to ${targets.length} sensor${targets.length === 1 ? '' : 's'}`,
                )
              }
            >
              {pending === 'configure' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Write configuration
            </Button>

            {recording ? (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void act(
                    'stop',
                    () => forEachTarget((target) => target.stopRecording({ rollOver })),
                    rollOver
                      ? 'Recording stopped; sensor rebooting to start a new log'
                      : 'Recording stopped',
                  )
                }
              >
                {pending === 'stop' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Square className="size-4" />
                )}
                Stop recording
              </Button>
            ) : (
              <Button
                disabled={busy || device.configuredPaths === null}
                onClick={() =>
                  void act(
                    'start',
                    () => forEachTarget((target) => target.startRecording()),
                    `Recording started on ${targets.length} sensor${targets.length === 1 ? '' : 's'}`,
                  )
                }
              >
                {pending === 'start' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CircleDot className="size-4" />
                )}
                Start recording
              </Button>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-4">
              {connected.length > 1 ? (
                <div className="flex items-center gap-2">
                  <Switch
                    id="apply-all"
                    checked={applyToAll}
                    onCheckedChange={setApplyToAll}
                  />
                  <Label htmlFor="apply-all" className="text-xs font-normal">
                    All {connected.length} sensors
                  </Label>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Switch
                  id="roll-over"
                  checked={rollOver}
                  onCheckedChange={setRollOver}
                />
                <Label htmlFor="roll-over" className="text-xs font-normal">
                  Reboot on stop
                </Label>
              </div>
            </div>
          </div>

          {device.configuredPaths === null && !recording ? (
            <p className="text-muted-foreground text-xs">
              Write the configuration before starting, so the sensor records the
              streams you picked rather than whatever it held before.
            </p>
          ) : null}

          <p className="text-muted-foreground text-xs">
            Stopping flushes the log. Rebooting afterwards is what rolls the sensor
            over to a fresh log id, which is how the upstream tool keeps recordings
            separate - it drops the Bluetooth link, so you will need to
            reconnect.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function RecordingBanner({ session }: { session: DeviceSession }) {
  const device = useDeviceSnapshot(session)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (device.recordingStartedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [device.recordingStartedAt])

  const elapsed =
    device.recordingStartedAt === null ? null : now - device.recordingStartedAt

  return (
    <Alert>
      <span className="bg-recording mt-1 inline-block size-2 animate-pulse rounded-full" />
      <AlertTitle>Recording</AlertTitle>
      <AlertDescription className="tabular">
        {elapsed === null
          ? 'This sensor was already logging when we connected, so the elapsed time is unknown.'
          : `Elapsed ${formatDuration(elapsed)}. Measurements cannot be changed while recording.`}
      </AlertDescription>
    </Alert>
  )
}
