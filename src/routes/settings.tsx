import { useEffect, useRef, useState } from 'react'
import { Download, HardDrive, RotateCcw, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Page } from '@/components/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ThemeToggle } from '@/components/theme-toggle'
import { presetStore } from '@/lib/record/presets'
import { settingsStore } from '@/lib/settings'
import { clearStoredLogs, storageUsage } from '@/lib/storage/db'
import { logStore } from '@/lib/storage/log-store'
import { formatBytes } from '@/lib/record/config'
import { findMeasurement, measurementPath } from '@/lib/api/catalog'
import { usePresets, useSettings } from '@/hooks/use-settings'

export function Settings() {
  return (
    <Page title="Settings" description="Appearance, defaults, presets and stored data.">
      <div className="space-y-6">
        <Appearance />
        <Behaviour />
        <Presets />
        <Storage />
      </div>
    </Page>
  )
}

function Appearance() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Theme</p>
          <p className="text-muted-foreground text-sm">
            Light, dark, or follow the system.
          </p>
        </div>
        <ThemeToggle />
      </CardContent>
    </Card>
  )
}

function Behaviour() {
  const settings = useSettings()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Behaviour</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <Toggle
          id="sync-time"
          label="Set the sensor clock on connect"
          description="Recordings need this to carry a UTC anchor. Without it a log's timestamps are only sensor uptime."
          checked={settings.syncTimeOnConnect}
          onChange={(value) => settingsStore.set('syncTimeOnConnect', value)}
        />
        <Separator />
        <Toggle
          id="reboot-after-stop"
          label="Reboot after stopping a recording"
          description="Rolls the sensor over to a fresh log id, which is how consecutive recordings stay separate. Drops the Bluetooth link."
          checked={settings.rebootAfterStop}
          onChange={(value) => settingsStore.set('rebootAfterStop', value)}
        />
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Temperature unit</p>
            <p className="text-muted-foreground text-sm">
              The sensor reports Kelvin; Celsius is Kelvin minus 273.15.
            </p>
          </div>
          <select
            aria-label="Temperature unit"
            className="bg-background h-9 rounded-md border px-2 text-sm"
            value={settings.temperatureUnit}
            onChange={(event) =>
              settingsStore.set(
                'temperatureUnit',
                event.target.value as 'K' | 'C',
              )
            }
          >
            <option value="C">Celsius</option>
            <option value="K">Kelvin</option>
          </select>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Live chart buffer</p>
            <p className="text-muted-foreground text-sm">
              Samples kept per channel while streaming. ECG at 512 Hz fills 20 000
              in about 40 seconds.
            </p>
          </div>
          <select
            aria-label="Live chart buffer"
            className="bg-background h-9 rounded-md border px-2 text-sm"
            value={settings.liveBufferSamples}
            onChange={(event) =>
              settingsStore.set('liveBufferSamples', Number(event.target.value))
            }
          >
            {[5_000, 20_000, 100_000].map((option) => (
              <option key={option} value={option}>
                {option.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <Separator />
        <div className="pt-3">
          <Button size="sm" variant="ghost" onClick={() => settingsStore.reset()}>
            <RotateCcw className="size-3.5" />
            Reset to defaults
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function Presets() {
  const presets = usePresets()
  const fileInput = useRef<HTMLInputElement>(null)

  const exportPresets = () => {
    const blob = new Blob([presetStore.toJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'movesense-presets.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const importPresets = async (file: File) => {
    try {
      const { imported, skipped } = presetStore.fromJson(await file.text())
      toast.success(
        `Imported ${imported} preset${imported === 1 ? '' : 's'}` +
          (skipped > 0 ? `, skipped ${skipped} malformed` : ''),
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Recording presets</CardTitle>
          <p className="text-muted-foreground mt-1 text-xs">
            Saved on the Record page. Exportable, so a configuration can travel with
            a study protocol.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={exportPresets}
            disabled={presets.length === 0}
          >
            <Download className="size-3.5" />
            Export
          </Button>
          <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
            <Upload className="size-3.5" />
            Import
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importPresets(file)
              event.target.value = ''
            }}
          />
        </div>
      </CardHeader>
      <CardContent>
        {presets.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No presets yet. Configure a recording and save it from the Record page.
          </p>
        ) : (
          <ul className="space-y-2">
            {presets.map((preset) => (
              <li
                key={preset.id}
                className="flex flex-wrap items-center gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{preset.name}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {preset.selections
                      .map((selection) => {
                        const spec = findMeasurement(selection.measurementId)
                        return spec
                          ? measurementPath(spec, selection.rate)
                          : selection.measurementId
                      })
                      .join(', ')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${preset.name}`}
                  onClick={() => presetStore.remove(preset.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Storage() {
  const [usage, setUsage] = useState<{
    logs: number
    bytes: number
    quota: number | null
  } | null>(null)
  const [confirming, setConfirming] = useState(false)

  const refresh = () => {
    void storageUsage().then(setUsage).catch(() => setUsage(null))
  }

  useEffect(refresh, [])

  const purge = async () => {
    try {
      await clearStoredLogs()
      await logStore.refresh()
      setConfirming(false)
      refresh()
      toast.success('Downloaded recordings deleted')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="size-4" />
          Stored data
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {usage === null
            ? 'Reading storage…'
            : `${usage.logs} recording${usage.logs === 1 ? '' : 's'}, ${formatBytes(usage.bytes)} in this browser` +
              (usage.quota ? ` of about ${formatBytes(usage.quota)} available` : '')}
        </p>

        <Alert>
          <AlertDescription>
            Recordings never leave this machine. They live in the browser&rsquo;s
            IndexedDB, so clearing site data removes them too - export anything
            you need to keep.
          </AlertDescription>
        </Alert>

        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="destructive" onClick={() => void purge()}>
              <Trash2 className="size-3.5" />
              Delete every downloaded recording
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={!usage || usage.logs === 0}
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="size-3.5" />
            Delete downloaded recordings
          </Button>
        )}
        {confirming ? (
          <p className="text-destructive text-xs">
            This removes the copies in this browser. It does not touch the sensor.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
