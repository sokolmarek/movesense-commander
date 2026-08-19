/**
 * GSP frame encoding and decoding. See docs/gsp-protocol.md.
 *
 * Everything here is pure byte work - no transport, no state - so it is
 * exhaustively testable without hardware.
 */

import { GspCommand, GspResponse } from './constants'
import { GspDecodeError } from './errors'

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** `[command, reference, ...payload]` */
export function encodeCommand(
  command: number,
  reference: number,
  payload: ArrayLike<number> = [],
): Uint8Array {
  const frame = new Uint8Array(2 + payload.length)
  frame[0] = command
  frame[1] = reference
  frame.set(Array.from(payload), 2)
  return frame
}

const utf8 = new TextEncoder()

/** Resource paths go on the wire as NUL-terminated UTF-8. */
export function encodePath(path: string): Uint8Array {
  const bytes = utf8.encode(path)
  const out = new Uint8Array(bytes.length + 1)
  out.set(bytes)
  out[bytes.length] = 0
  return out
}

export function encodeGet(reference: number, path: string): Uint8Array {
  return encodeCommand(GspCommand.Get, reference, encodePath(path))
}

export function encodeSubscribe(reference: number, path: string): Uint8Array {
  return encodeCommand(GspCommand.Subscribe, reference, encodePath(path))
}

export function encodeUnsubscribe(reference: number): Uint8Array {
  return encodeCommand(GspCommand.Unsubscribe, reference)
}

export function encodeHello(reference: number): Uint8Array {
  return encodeCommand(GspCommand.Hello, reference)
}

export function encodeClearLogbook(reference: number): Uint8Array {
  return encodeCommand(GspCommand.ClearLogbook, reference)
}

export function encodeFetchLog(reference: number, logId: number): Uint8Array {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, logId, true)
  return encodeCommand(GspCommand.FetchLog, reference, payload)
}

/**
 * DataLogger config is just the resource paths, each NUL-terminated, one after
 * another. `/Time/Detailed` is not added here - callers decide, so the encoder
 * stays a pure function of its input.
 */
export function encodeDataLoggerConfig(
  reference: number,
  paths: readonly string[],
): Uint8Array {
  const encoded = paths.map(encodePath)
  const total = encoded.reduce((sum, p) => sum + p.length, 0)
  const payload = new Uint8Array(total)
  let offset = 0
  for (const part of encoded) {
    payload.set(part, offset)
    offset += part.length
  }
  return encodeCommand(GspCommand.PutDataLoggerConfig, reference, payload)
}

export function encodeDataLoggerState(
  reference: number,
  state: number,
): Uint8Array {
  return encodeCommand(GspCommand.PutDataLoggerState, reference, [state])
}

export function encodeSystemMode(reference: number, mode: number): Uint8Array {
  return encodeCommand(GspCommand.PutSystemMode, reference, [mode])
}

/** UTC time is microseconds since the epoch, as a little-endian uint64. */
export function encodeUtcTime(
  reference: number,
  microseconds: number | bigint,
): Uint8Array {
  const payload = new Uint8Array(8)
  new DataView(payload.buffer).setBigUint64(0, BigInt(microseconds), true)
  return encodeCommand(GspCommand.PutUtcTime, reference, payload)
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type GspFrame =
  | {
      kind: 'command-response'
      reference: number
      /** Everything after the 2-byte header. Status is *not* split off here. */
      payload: Uint8Array
      raw: Uint8Array
    }
  | {
      kind: 'data'
      reference: number
      /** True for DATA_PART2, the continuation code. */
      continuation: boolean
      payload: Uint8Array
      raw: Uint8Array
    }
  | {
      kind: 'unknown'
      reference: number
      responseCode: number
      payload: Uint8Array
      raw: Uint8Array
    }

/**
 * Split a notification into header and payload.
 *
 * The uint16 status is deliberately left inside `payload` rather than parsed
 * out here: HELLO responses have no status field, and only the caller knows
 * which command a reference belongs to. See `readStatus` below.
 */
export function parseFrame(raw: Uint8Array): GspFrame {
  if (raw.length < 2) {
    throw new GspDecodeError(
      `Notification too short: ${raw.length} byte(s), need at least 2`,
    )
  }

  const responseCode = raw[0]!
  const reference = raw[1]!
  const payload = raw.subarray(2)

  switch (responseCode) {
    case GspResponse.CommandResponse:
      return { kind: 'command-response', reference, payload, raw }
    case GspResponse.Data:
      return { kind: 'data', reference, continuation: false, payload, raw }
    case GspResponse.DataPart2:
      return { kind: 'data', reference, continuation: true, payload, raw }
    default:
      return { kind: 'unknown', reference, responseCode, payload, raw }
  }
}

/**
 * Read the uint16 status and the data that follows it, for every command
 * except HELLO.
 */
export function readStatus(payload: Uint8Array): {
  status: number
  data: Uint8Array
} {
  if (payload.length < 2) {
    throw new GspDecodeError(
      `Command response payload too short for a status: ${payload.length} byte(s)`,
    )
  }
  const status = payload[0]! | (payload[1]! << 8)
  return { status, data: payload.subarray(2) }
}

/** A `FETCH_LOG` data packet: uint32 offset, then the file bytes. */
export function readLogChunk(payload: Uint8Array): {
  offset: number
  bytes: Uint8Array
} {
  if (payload.length < 4) {
    throw new GspDecodeError(
      `Log data packet too short: ${payload.length} byte(s), need at least 4`,
    )
  }
  const offset = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0, true)
  return { offset, bytes: payload.subarray(4) }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const COMMAND_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(GspCommand).map(([name, code]) => [code, name]),
)

const RESPONSE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(GspResponse).map(([name, code]) => [code, name]),
)

export function commandName(code: number): string {
  return COMMAND_NAMES[code] ?? `Command(${code})`
}

export function responseName(code: number): string {
  return RESPONSE_NAMES[code] ?? `Response(${code})`
}

export function toHex(bytes: Uint8Array, separator = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    separator,
  )
}

/** Best-effort human summary of a raw frame, for the protocol trace. */
export function describeFrame(raw: Uint8Array): string {
  if (raw.length < 2) return `malformed (${raw.length} bytes)`
  const frame = parseFrame(raw)

  if (frame.kind === 'data') {
    const label = frame.continuation ? 'DataPart2' : 'Data'
    if (frame.payload.length >= 4) {
      const { offset, bytes } = readLogChunk(frame.payload)
      // A log chunk with no body is the end-of-log marker; a subscription
      // sample also lands here, so say what we can without guessing.
      return bytes.length === 0
        ? `${label} ref=${frame.reference} offset=${offset} (end of log)`
        : `${label} ref=${frame.reference} offset=${offset} +${bytes.length}B`
    }
    return `${label} ref=${frame.reference} ${frame.payload.length}B`
  }

  if (frame.kind === 'command-response') {
    if (frame.payload.length >= 2) {
      const { status, data } = readStatus(frame.payload)
      return `Response ref=${frame.reference} status=${status}${
        data.length ? ` +${data.length}B` : ''
      }`
    }
    return `Response ref=${frame.reference} ${frame.payload.length}B`
  }

  return `${responseName(frame.responseCode)} ref=${frame.reference} ${frame.payload.length}B`
}

/** Best-effort human summary of an outgoing command. */
export function describeCommand(raw: Uint8Array): string {
  if (raw.length < 2) return `malformed (${raw.length} bytes)`
  const name = commandName(raw[0]!)
  const reference = raw[1]!
  const payload = raw.subarray(2)

  switch (raw[0]) {
    case GspCommand.Get:
    case GspCommand.Subscribe:
      return `${name} ref=${reference} ${decodePaths(payload).join(', ')}`
    case GspCommand.PutDataLoggerConfig:
      return `${name} ref=${reference} ${decodePaths(payload).join(', ')}`
    case GspCommand.FetchLog:
      return payload.length >= 4
        ? `${name} ref=${reference} id=${new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true)}`
        : `${name} ref=${reference}`
    case GspCommand.PutDataLoggerState:
    case GspCommand.PutSystemMode:
      return `${name} ref=${reference} value=${payload[0] ?? '?'}`
    default:
      return payload.length
        ? `${name} ref=${reference} ${payload.length}B`
        : `${name} ref=${reference}`
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

/** Split a run of NUL-terminated UTF-8 strings, dropping the empty tail. */
export function decodePaths(payload: Uint8Array): string[] {
  return utf8Decoder
    .decode(payload)
    .split('\0')
    .filter((s) => s.length > 0)
}
