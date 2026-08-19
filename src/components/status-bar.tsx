import { Bluetooth, BluetoothConnected, BluetoothOff } from 'lucide-react'
import { checkBluetoothSupport } from '@/lib/bluetooth-support'
import type { DeviceSession } from '@/lib/device/session'
import { DataLoggerState } from '@/lib/gsp/constants'
import { useDeviceSessions, useDeviceSnapshot } from '@/hooks/use-devices'

/** Persistent footer: browser capability on the left, live device state on the right. */
export function StatusBar() {
  const support = checkBluetoothSupport()
  const sessions = useDeviceSessions()

  return (
    <footer className="bg-background/80 flex h-9 items-center gap-4 border-t px-4 text-xs backdrop-blur">
      <span className="text-muted-foreground flex items-center gap-1.5">
        {support.supported ? (
          <>
            <Bluetooth className="size-3.5" />
            Web Bluetooth ready
          </>
        ) : (
          <>
            <BluetoothOff className="text-destructive size-3.5" />
            Web Bluetooth unavailable
          </>
        )}
      </span>

      <div className="ml-auto flex items-center gap-4">
        {sessions.length === 0 ? (
          <span className="text-muted-foreground">No device connected</span>
        ) : (
          sessions.map((session) => (
            <DeviceStatus key={session.id} session={session} />
          ))
        )}
      </div>
    </footer>
  )
}

function DeviceStatus({ session }: { session: DeviceSession }) {
  const device = useDeviceSnapshot(session)
  const connected = device.status === 'connected'
  const logging = device.dataLoggerState === DataLoggerState.Logging

  return (
    <span className="flex items-center gap-1.5">
      {connected ? (
        <BluetoothConnected className="size-3.5" />
      ) : (
        <BluetoothOff className="text-muted-foreground size-3.5" />
      )}
      <span className="font-mono">
        {device.info?.serialNumber ?? device.name ?? device.id}
      </span>
      {connected ? (
        <>
          {device.battery !== null ? (
            <span className="text-muted-foreground tabular">{device.battery}%</span>
          ) : null}
          {logging ? (
            <span className="text-recording flex items-center gap-1">
              <span className="bg-recording size-1.5 animate-pulse rounded-full" />
              recording
            </span>
          ) : (
            <span className="text-muted-foreground">
              {device.dataLoggerStateLabel ?? 'ready'}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted-foreground">{device.status}</span>
      )}
    </span>
  )
}
