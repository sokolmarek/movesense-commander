import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Clock,
  Loader2,
  Plug,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { deviceManager } from '@/lib/device/manager'
import type { ConnectionStatus, DeviceSession } from '@/lib/device/session'
import { DataLoggerState } from '@/lib/gsp/constants'
import { useDeviceSnapshot } from '@/hooks/use-devices'

export function DeviceCard({ session }: { session: DeviceSession }) {
  const device = useDeviceSnapshot(session)
  const [pending, setPending] = useState<string | null>(null)

  const act = async (label: string, action: () => Promise<unknown>) => {
    setPending(label)
    try {
      await action()
    } catch {
      // The session records the failure in its snapshot and trace; nothing to
      // add here, and throwing would take down the render.
    } finally {
      setPending(null)
    }
  }

  const connected = device.status === 'connected'
  const logging = device.dataLoggerState === DataLoggerState.Logging
  const busy = device.busy || pending !== null

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate text-base">
            {device.info?.productName ?? device.name ?? 'Movesense sensor'}
          </CardTitle>
          <p className="text-muted-foreground mt-1 font-mono text-xs">
            {device.info?.serialNumber ?? device.name ?? device.id}
          </p>
        </div>
        <StatusBadge status={device.status} logging={logging} />
      </CardHeader>

      <CardContent className="space-y-4">
        {device.error ? (
          <p className="text-destructive flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{device.error}</span>
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <Field label="Battery">
            {device.battery === null ? (
              <Unknown />
            ) : (
              <span className="tabular flex items-center gap-1.5">
                <BatteryIcon level={device.battery} />
                {device.battery}%
              </span>
            )}
          </Field>
          <Field label="Logger">
            {device.dataLoggerStateLabel ?? <Unknown />}
          </Field>
          <Field label="App">
            {device.info ? (
              <span className="truncate">
                {device.info.appName} {device.info.appVersion}
              </span>
            ) : (
              <Unknown />
            )}
          </Field>
          <Field label="Clock">
            {device.timeSyncedAt ? (
              <Tooltip>
                <TooltipTrigger className="flex items-center gap-1.5">
                  <Clock className="size-3.5" />
                  synced
                </TooltipTrigger>
                <TooltipContent>
                  Set from this machine at{' '}
                  {new Date(device.timeSyncedAt).toLocaleTimeString()}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-muted-foreground">not synced</span>
            )}
          </Field>
        </dl>

        {device.info?.dfuMacAddress ? (
          <p className="text-muted-foreground font-mono text-xs">
            DFU {device.info.dfuMacAddress} · GSP protocol v
            {device.info.protocolVersion}
          </p>
        ) : null}

        <Separator />

        <div className="flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => act('refresh', () => session.refresh())}
              >
                {pending === 'refresh' ? <Spinner /> : <RefreshCw className="size-3.5" />}
                Refresh
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => act('sync', () => session.syncTime())}
              >
                {pending === 'sync' ? <Spinner /> : <Clock className="size-3.5" />}
                Sync clock
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => act('reboot', () => session.reboot())}
                  >
                    {pending === 'reboot' ? <Spinner /> : <RotateCcw className="size-3.5" />}
                    Reboot
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Restarts the sensor app. The connection will drop.
                </TooltipContent>
              </Tooltip>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={busy}
                onClick={() => act('disconnect', () => session.disconnect())}
              >
                <Plug className="size-3.5" />
                Disconnect
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => act('connect', () => session.connect())}
              >
                {pending === 'connect' ? <Spinner /> : <PlugZap className="size-3.5" />}
                Reconnect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={busy}
                onClick={() => act('remove', () => deviceManager.remove(device.id))}
              >
                <Trash2 className="size-3.5" />
                Remove
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({
  status,
  logging,
}: {
  status: ConnectionStatus
  logging: boolean
}) {
  if (status === 'connected') {
    return logging ? (
      <Badge className="bg-recording text-primary-foreground gap-1.5 shrink-0">
        <span className="bg-primary-foreground size-1.5 animate-pulse rounded-full" />
        Recording
      </Badge>
    ) : (
      <Badge variant="secondary" className="shrink-0">
        Connected
      </Badge>
    )
  }
  if (status === 'connecting') {
    return (
      <Badge variant="secondary" className="gap-1.5 shrink-0">
        <Spinner />
        Connecting
      </Badge>
    )
  }
  if (status === 'error') {
    return (
      <Badge variant="destructive" className="shrink-0">
        Error
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="shrink-0">
      Disconnected
    </Badge>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">{children}</dd>
    </div>
  )
}

function Unknown() {
  return <span className="text-muted-foreground">-</span>
}

function Spinner() {
  return <Loader2 className="size-3.5 animate-spin" />
}

function BatteryIcon({ level }: { level: number }) {
  const Icon =
    level > 70
      ? BatteryFull
      : level > 40
        ? BatteryMedium
        : level > 15
          ? BatteryLow
          : BatteryWarning
  return <Icon className={cn('size-4', level <= 15 && 'text-destructive')} />
}
