import { GspRefExhaustedError } from './errors'

/**
 * Reference-code allocator.
 *
 * GSP reference codes are a single byte and tie a response back to its command.
 * The Python reference tool hardcodes them and reuses `101` for two different
 * commands, which is a latent mix-up; we allocate dynamically instead.
 *
 * Allocation rotates rather than always taking the lowest free code. GSP
 * notifications are unacknowledged, so a response can arrive after its command
 * has already timed out. Rotating means a freed code is not reused immediately,
 * so a late straggler is far less likely to be mistaken for the answer to a
 * brand-new request.
 *
 * Code 0 is never allocated, so callers can use 0 as "no reference".
 */
export class ReferenceAllocator {
  static readonly MIN = 1
  static readonly MAX = 255

  private readonly inUse = new Set<number>()
  private next = ReferenceAllocator.MIN

  get size(): number {
    return this.inUse.size
  }

  get capacity(): number {
    return ReferenceAllocator.MAX - ReferenceAllocator.MIN + 1
  }

  allocate(): number {
    const span = this.capacity
    for (let i = 0; i < span; i++) {
      const candidate = this.next
      this.next = candidate >= ReferenceAllocator.MAX ? ReferenceAllocator.MIN : candidate + 1
      if (!this.inUse.has(candidate)) {
        this.inUse.add(candidate)
        return candidate
      }
    }
    throw new GspRefExhaustedError()
  }

  release(reference: number): void {
    this.inUse.delete(reference)
  }

  has(reference: number): boolean {
    return this.inUse.has(reference)
  }

  releaseAll(): void {
    this.inUse.clear()
  }
}
