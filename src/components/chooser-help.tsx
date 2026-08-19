import { HelpCircle, Loader2, ScanSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * What to try when the sensor is visible to the operating system but not in the
 * browser's chooser. Every item here is a distinct cause, not a restatement.
 */
export function ChooserHelp({
  onShowAllDevices,
  scanning,
}: {
  onShowAllDevices: () => void
  scanning: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="size-4" />
          Sensor not in the chooser?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          The browser runs its own Bluetooth scan, separate from the one in
          Windows settings, and only lists what matches our filter. In order of
          likelihood:
        </p>

        <ol className="text-muted-foreground list-decimal space-y-2 pl-5">
          <li>
            <strong className="text-foreground">
              It is paired in the operating system.
            </strong>{' '}
            A paired sensor that the OS has connected to stops advertising, so no
            browser scan can find it. Movesense needs no pairing - remove it
            from the system Bluetooth device list and try again.
          </li>
          <li>
            <strong className="text-foreground">Another app holds it.</strong> The
            Python datalogger tool, a phone app or a second browser tab will keep
            the sensor occupied. Close them.
          </li>
          <li>
            <strong className="text-foreground">It went to sleep.</strong>{' '}
            Movesense stops advertising after a period of stillness. Move or tap
            the sensor, or reseat the battery, then click connect within a few
            seconds.
          </li>
          <li>
            <strong className="text-foreground">
              It advertises an unexpected name.
            </strong>{' '}
            We filter on names beginning &ldquo;Movesense&rdquo;. Custom firmware
            may use something else - use the button below to list every
            Bluetooth device in range.
          </li>
        </ol>

        <Button variant="secondary" onClick={onShowAllDevices} disabled={scanning}>
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ScanSearch className="size-4" />
          )}
          Show all Bluetooth devices
        </Button>

        <p className="text-muted-foreground text-xs">
          Listing all devices is a diagnostic: picking something that is not a
          Movesense sensor will connect and then fail when the GSP service is
          missing. The failure message will say so.
        </p>
      </CardContent>
    </Card>
  )
}
