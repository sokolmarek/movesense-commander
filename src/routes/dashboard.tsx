import { useState } from 'react'
import { Bluetooth, BluetoothOff, Loader2, PlugZap, Radar } from 'lucide-react'
import { Page } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ChooserHelp } from '@/components/chooser-help'
import { DeviceCard } from '@/components/device-card'
import { TracePanel } from '@/components/trace-panel'
import {
  useConnect,
  useDeviceSessions,
  useReconnectable,
} from '@/hooks/use-devices'
import { deviceManager } from '@/lib/device/manager'
import { checkBluetoothSupport } from '@/lib/bluetooth-support'

export function Dashboard() {
  const support = checkBluetoothSupport()
  const sessions = useDeviceSessions()
  const { connect, connecting, error } = useConnect()

  return (
    <Page
      title="Dashboard"
      description="Connect a Movesense sensor and see its state at a glance."
      actions={
        <Button disabled={!support.supported || connecting} onClick={() => void connect()}>
          {connecting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Bluetooth className="size-4" />
          )}
          {sessions.length ? 'Add sensor' : 'Connect sensor'}
        </Button>
      }
    >
      <div className="space-y-6">
        {!support.supported ? (
          <Alert variant="destructive">
            <BluetoothOff className="size-4" />
            <AlertTitle>Web Bluetooth unavailable</AlertTitle>
            <AlertDescription>{support.detail}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <BluetoothOff className="size-4" />
            <AlertTitle>Could not connect</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {sessions.map((session) => (
          <DeviceCard key={session.id} session={session} />
        ))}

        {sessions.length === 0 && support.supported ? (
          <>
            <EmptyState />
            <ChooserHelp
              scanning={connecting}
              onShowAllDevices={() => void connect('all')}
            />
          </>
        ) : null}

        {sessions.map((session) => (
          <TracePanel key={`${session.id}-trace`} recorder={session.trace} />
        ))}
      </div>
    </Page>
  )
}

function EmptyState() {
  const { devices, refresh } = useReconnectable()
  const [reconnecting, setReconnecting] = useState<string | null>(null)

  const reconnect = async (id: string) => {
    setReconnecting(id)
    try {
      await deviceManager.reconnect(id)
    } catch {
      // The session surfaces the failure once it exists.
    } finally {
      setReconnecting(null)
      refresh()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="size-4" />
          No sensor connected
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          Use <strong className="text-foreground">Connect sensor</strong> to open
          the browser&rsquo;s device chooser. It lists devices advertising a name
          beginning &ldquo;Movesense&rdquo;, and the sensor must not already be
          connected to another app, a phone, or Windows itself.
        </p>

        {devices.length > 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs">
              Previously allowed on this machine - reconnect without the
              chooser:
            </p>
            <div className="flex flex-wrap gap-2">
              {devices.map((device) => (
                <Button
                  key={device.id}
                  size="sm"
                  variant="secondary"
                  disabled={reconnecting !== null}
                  onClick={() => void reconnect(device.id)}
                >
                  {reconnecting === device.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <PlugZap className="size-3.5" />
                  )}
                  {device.name ?? device.id}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="text-muted-foreground">
          Everything runs in this browser. Recordings you download stay on this
          machine until you export them - there is no server.
        </p>
      </CardContent>
    </Card>
  )
}
