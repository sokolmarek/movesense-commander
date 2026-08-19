import { describe, expect, it } from 'vitest'
import { GspCommand, GspResponse } from './constants'
import { GspDecodeError } from './errors'
import {
  decodePaths,
  describeCommand,
  describeFrame,
  encodeClearLogbook,
  encodeDataLoggerConfig,
  encodeDataLoggerState,
  encodeFetchLog,
  encodeGet,
  encodeHello,
  encodePath,
  encodeSubscribe,
  encodeSystemMode,
  encodeUnsubscribe,
  encodeUtcTime,
  parseFrame,
  readLogChunk,
  readStatus,
  toHex,
} from './framing'

describe('command encoding', () => {
  it('encodes HELLO as just the header', () => {
    expect([...encodeHello(100)]).toEqual([GspCommand.Hello, 100])
  })

  it('NUL-terminates resource paths', () => {
    expect([...encodePath('/Meas/Temp')]).toEqual([
      ...new TextEncoder().encode('/Meas/Temp'),
      0,
    ])
  })

  it('encodes GET and SUBSCRIBE with a terminated path', () => {
    const get = encodeGet(7, '/Meas/Temp')
    expect(get[0]).toBe(GspCommand.Get)
    expect(get[1]).toBe(7)
    expect(get.at(-1)).toBe(0)
    expect(decodePaths(get.subarray(2))).toEqual(['/Meas/Temp'])

    const sub = encodeSubscribe(8, '/Meas/ECG/200')
    expect(sub[0]).toBe(GspCommand.Subscribe)
    expect(decodePaths(sub.subarray(2))).toEqual(['/Meas/ECG/200'])
  })

  it('encodes UNSUBSCRIBE and CLEAR_LOGBOOK without a payload', () => {
    expect([...encodeUnsubscribe(9)]).toEqual([GspCommand.Unsubscribe, 9])
    expect([...encodeClearLogbook(10)]).toEqual([GspCommand.ClearLogbook, 10])
  })

  it('encodes the log id as little-endian uint32', () => {
    const frame = encodeFetchLog(11, 0x01020304)
    expect([...frame]).toEqual([GspCommand.FetchLog, 11, 0x04, 0x03, 0x02, 0x01])
  })

  it('encodes several DataLogger paths back to back, each terminated', () => {
    const frame = encodeDataLoggerConfig(12, ['/Meas/ECG/200/mV', '/Time/Detailed'])
    expect(frame[0]).toBe(GspCommand.PutDataLoggerConfig)
    expect(frame[1]).toBe(12)
    expect(decodePaths(frame.subarray(2))).toEqual([
      '/Meas/ECG/200/mV',
      '/Time/Detailed',
    ])
    expect(frame.at(-1)).toBe(0)
  })

  it('encodes single-byte state and mode payloads', () => {
    expect([...encodeDataLoggerState(13, 3)]).toEqual([
      GspCommand.PutDataLoggerState,
      13,
      3,
    ])
    expect([...encodeSystemMode(14, 5)]).toEqual([GspCommand.PutSystemMode, 14, 5])
  })

  it('encodes UTC time as little-endian uint64 microseconds', () => {
    const micros = 1_700_000_000_000_000
    const frame = encodeUtcTime(15, micros)
    expect(frame[0]).toBe(GspCommand.PutUtcTime)
    expect(frame[1]).toBe(15)
    const view = new DataView(frame.buffer, frame.byteOffset + 2, 8)
    expect(view.getBigUint64(0, true)).toBe(BigInt(micros))
  })

  it('handles microsecond values beyond 32 bits without truncating', () => {
    // Date.now() * 1000 is ~1.7e15, which needs more than 32 bits.
    const frame = encodeUtcTime(1, 0x0123456789abcdefn)
    const view = new DataView(frame.buffer, frame.byteOffset + 2, 8)
    expect(view.getBigUint64(0, true)).toBe(0x0123456789abcdefn)
  })
})

describe('frame parsing', () => {
  it('rejects frames shorter than the header', () => {
    expect(() => parseFrame(new Uint8Array([1]))).toThrow(GspDecodeError)
  })

  it('splits a command response into reference and payload', () => {
    const frame = parseFrame(
      new Uint8Array([GspResponse.CommandResponse, 42, 0xc8, 0x00, 0xaa]),
    )
    expect(frame.kind).toBe('command-response')
    expect(frame.reference).toBe(42)
    expect([...frame.payload]).toEqual([0xc8, 0x00, 0xaa])
  })

  it('leaves the status inside the payload, because HELLO has none', () => {
    // A HELLO response is [1, ref, version, ...strings] - reading a status here
    // would consume the version byte and the first string byte.
    const hello = parseFrame(new Uint8Array([GspResponse.CommandResponse, 5, 2, 65, 0]))
    expect(hello.kind).toBe('command-response')
    expect(hello.payload[0]).toBe(2)
  })

  it('reads a little-endian uint16 status', () => {
    expect(readStatus(new Uint8Array([0xc8, 0x00])).status).toBe(200)
    expect(readStatus(new Uint8Array([0x94, 0x01])).status).toBe(404)
    expect(readStatus(new Uint8Array([0xca, 0x00, 1, 2])).status).toBe(202)
    expect([...readStatus(new Uint8Array([0xc8, 0x00, 1, 2])).data]).toEqual([1, 2])
  })

  it('rejects a command response too short to hold a status', () => {
    expect(() => readStatus(new Uint8Array([0xc8]))).toThrow(GspDecodeError)
  })

  it('distinguishes DATA from DATA_PART2', () => {
    const first = parseFrame(new Uint8Array([GspResponse.Data, 3, 1]))
    const second = parseFrame(new Uint8Array([GspResponse.DataPart2, 3, 1]))
    expect(first.kind === 'data' && first.continuation).toBe(false)
    expect(second.kind === 'data' && second.continuation).toBe(true)
  })

  it('reports an unrecognised response code instead of throwing', () => {
    const frame = parseFrame(new Uint8Array([99, 4, 1, 2]))
    expect(frame.kind).toBe('unknown')
    expect(frame.kind === 'unknown' && frame.responseCode).toBe(99)
  })
})

describe('log chunks', () => {
  it('reads the offset and body', () => {
    const { offset, bytes } = readLogChunk(
      new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xde, 0xad]),
    )
    expect(offset).toBe(256)
    expect([...bytes]).toEqual([0xde, 0xad])
  })

  it('treats an offset-only packet as an empty body', () => {
    const { offset, bytes } = readLogChunk(new Uint8Array([4, 0, 0, 0]))
    expect(offset).toBe(4)
    expect(bytes.length).toBe(0)
  })

  it('rejects a packet with no room for an offset', () => {
    expect(() => readLogChunk(new Uint8Array([1, 2, 3]))).toThrow(GspDecodeError)
  })

  it('reads offsets above 2^31 without sign trouble', () => {
    const payload = new Uint8Array(4)
    new DataView(payload.buffer).setUint32(0, 0xfffffff0, true)
    expect(readLogChunk(payload).offset).toBe(0xfffffff0)
  })
})

describe('diagnostics', () => {
  it('formats hex', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('00 0f ff')
  })

  it('summarises outgoing commands', () => {
    expect(describeCommand(encodeGet(4, '/Meas/Temp'))).toBe(
      'Get ref=4 /Meas/Temp',
    )
    expect(describeCommand(encodeFetchLog(5, 7))).toBe('FetchLog ref=5 id=7')
    expect(describeCommand(encodeDataLoggerState(6, 3))).toBe(
      'PutDataLoggerState ref=6 value=3',
    )
    expect(describeCommand(encodeHello(1))).toBe('Hello ref=1')
  })

  it('summarises incoming frames', () => {
    expect(
      describeFrame(new Uint8Array([GspResponse.CommandResponse, 4, 0xc8, 0x00])),
    ).toBe('Response ref=4 status=200')
    expect(
      describeFrame(new Uint8Array([GspResponse.Data, 4, 0, 0, 0, 0, 1, 2, 3])),
    ).toBe('Data ref=4 offset=0 +3B')
    expect(describeFrame(new Uint8Array([GspResponse.Data, 4, 8, 0, 0, 0]))).toBe(
      'Data ref=4 offset=8 (end of log)',
    )
  })
})
