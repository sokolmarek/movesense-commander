import { useDeviceSessions, useDeviceSnapshot } from '@/hooks/use-devices'
import {
  useSelectedDevice,
  useSelectedDeviceContext,
} from '@/lib/device/selected-device'
import type { DeviceSession } from '@/lib/device/session'

/** Row of buttons to switch sensors. Renders nothing unless there are several. */
export function DeviceSelect() {
  const sessions = useDeviceSessions()
  const context = useSelectedDeviceContext()
  const { session } = useSelectedDevice()

  if (sessions.length < 2) return null

  return (
    <div className="flex flex-wrap gap-1">
      {sessions.map((candidate) => (
        <DeviceSelectButton
          key={candidate.id}
          session={candidate}
          active={candidate.id === session?.id}
          onSelect={() => context?.select(candidate.id)}
        />
      ))}
    </div>
  )
}

function DeviceSelectButton({
  session,
  active,
  onSelect,
}: {
  session: DeviceSession
  active: boolean
  onSelect: () => void
}) {
  const device = useDeviceSnapshot(session)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={
        active
          ? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 font-mono text-xs'
          : 'text-muted-foreground hover:bg-muted rounded-md px-3 py-1.5 font-mono text-xs'
      }
    >
      {device.info?.serialNumber ?? device.name ?? device.id}
      {device.status !== 'connected' ? ' (offline)' : ''}
    </button>
  )
}
