import { Badge } from '@/components/ui/badge'
import { toHex } from '@/lib/gsp/framing'
import { decodePayload, type Provenance } from '@/lib/gsp/layouts'
import { cn } from '@/lib/utils'

const PROVENANCE_LABEL: Record<Provenance, string> = {
  verified: 'confirmed against hardware',
  derived: 'read off real log descriptors',
  documented: 'from the API reference',
  guess: 'inferred - verify against hardware',
}

/**
 * A GSP payload, decoded where we can be sure and shown as hex where we cannot.
 *
 * Hex is the honest answer for an unknown shape. A layout is only applied when it
 * consumes the payload exactly, and the badge always says where the layout came
 * from - a guess is labelled a guess.
 */
export function PayloadView({
  path,
  payload,
  status,
}: {
  path: string
  payload: Uint8Array
  /** HTTP-style status, when this payload came from a GET. */
  status?: number
}) {
  const result = decodePayload(path, payload)

  // An empty body is not a decoding failure. It is what a resource returns when
  // the request itself did not succeed - a 401 from a subscribe-only resource,
  // for instance - and saying "the layout does not fit" there is just wrong.
  if (payload.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {status !== undefined && status !== 200
          ? `No payload: the sensor answered ${status}. Some resources are subscribe-only and refuse a GET.`
          : 'The response carried no payload.'}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {result.best ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{result.best.layout.name}</span>
            <Badge
              variant={result.best.layout.provenance === 'guess' ? 'outline' : 'secondary'}
              className={cn(
                'text-xs',
                result.best.layout.provenance === 'guess' && 'border-warning text-warning',
              )}
            >
              {PROVENANCE_LABEL[result.best.layout.provenance]}
            </Badge>
          </div>
          <pre className="bg-muted/40 max-h-64 overflow-auto rounded-md p-3 font-mono text-xs">
            {JSON.stringify(result.best.value, null, 2)}
          </pre>
          <p className="text-muted-foreground text-xs">
            {result.best.layout.note}
          </p>
        </div>
      ) : (
        <UndecodedNotice
          path={path}
          candidatesTried={result.candidatesTried}
          partial={result.attempts.map((attempt) => ({
            name: attempt.layout.name,
            consumed: attempt.consumed,
          }))}
          total={payload.length}
        />
      )}

      <div>
        <p className="text-muted-foreground mb-1 text-xs">
          Raw payload, {payload.length} byte{payload.length === 1 ? '' : 's'}
        </p>
        <pre className="bg-muted/40 max-h-40 overflow-auto rounded-md p-3 font-mono text-xs break-all whitespace-pre-wrap">
          {payload.length === 0 ? '(empty)' : toHex(payload)}
        </pre>
      </div>
    </div>
  )
}

function UndecodedNotice({
  path,
  candidatesTried,
  partial,
  total,
}: {
  path: string
  candidatesTried: number
  partial: Array<{ name: string; consumed: number }>
  total: number
}) {
  if (candidatesTried === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No layout is registered for <span className="font-mono">{path}</span>, so
        the bytes are shown as they arrived. The field order for this resource is
        not in the published API reference; adding a layout means reading it off
        real hardware first.
      </p>
    )
  }

  return (
    <div className="space-y-1 text-sm">
      <p className="text-warning">
        The known layout does not fit this payload, so nothing is decoded.
      </p>
      <ul className="text-muted-foreground space-y-0.5 text-xs">
        {partial.map((attempt) => (
          <li key={attempt.name}>
            {attempt.name}: consumed {attempt.consumed} of {total} bytes
          </li>
        ))}
        {partial.length === 0 ? (
          <li>Every candidate ran out of bytes before finishing.</li>
        ) : null}
      </ul>
      <p className="text-muted-foreground text-xs">
        Leftover or missing bytes mean the field order is wrong, however plausible
        the numbers would look. This is the evidence needed to fix the layout.
      </p>
    </div>
  )
}
