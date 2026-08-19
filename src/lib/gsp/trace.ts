import { describeCommand, describeFrame, toHex } from './framing'

/**
 * Protocol trace: every frame in and out, with a decoded summary.
 *
 * This is the debugging tool the rest of the project leans on. It is also how
 * hardware sessions become regression tests - export a trace, replay it through
 * the fake transport (see `testing/fake-transport.ts`).
 */

export type TraceDirection = 'out' | 'in' | 'note'

export interface TraceEntry {
  readonly id: number
  /** Milliseconds since the recorder was created. */
  readonly at: number
  readonly direction: TraceDirection
  readonly summary: string
  readonly bytes: Uint8Array | null
}

export class TraceRecorder {
  private entries: TraceEntry[] = []
  private readonly listeners = new Set<() => void>()
  private nextId = 1
  private readonly startedAt = Date.now()

  constructor(private readonly limit = 1000) {}

  /** Stable snapshot, safe for `useSyncExternalStore`. */
  getEntries(): readonly TraceEntry[] {
    return this.entries
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** An outgoing command. Bytes are copied so later reuse cannot mutate them. */
  command(bytes: Uint8Array): void {
    this.push('out', describeCommand(bytes), bytes)
  }

  /** An incoming notification. */
  notification(bytes: Uint8Array): void {
    let summary: string
    try {
      summary = describeFrame(bytes)
    } catch (error) {
      summary = `undecodable: ${error instanceof Error ? error.message : String(error)}`
    }
    this.push('in', summary, bytes)
  }

  /** A free-text event: connect, disconnect, timeout, warning. */
  note(summary: string): void {
    this.push('note', summary, null)
  }

  clear(): void {
    this.entries = []
    this.emit()
  }

  /** Plain-text export, for pasting into an issue or saving as a fixture. */
  toText(): string {
    return this.entries
      .map((entry) => {
        const arrow =
          entry.direction === 'out' ? '-->' : entry.direction === 'in' ? '<--' : '   '
        const hex = entry.bytes ? `  ${toHex(entry.bytes)}` : ''
        return `${entry.at.toString().padStart(7)}ms ${arrow} ${entry.summary}${hex}`
      })
      .join('\n')
  }

  private push(
    direction: TraceDirection,
    summary: string,
    bytes: Uint8Array | null,
  ): void {
    const entry: TraceEntry = {
      id: this.nextId++,
      at: Date.now() - this.startedAt,
      direction,
      summary,
      bytes: bytes ? new Uint8Array(bytes) : null,
    }
    // Replace the array rather than mutating it, so snapshot identity changes
    // exactly when the contents do.
    const next = [...this.entries, entry]
    this.entries = next.length > this.limit ? next.slice(next.length - this.limit) : next
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
