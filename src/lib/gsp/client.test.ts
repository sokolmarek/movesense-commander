import { afterEach, describe, expect, it, vi } from 'vitest'
import { GspClient } from './client'
import { DataLoggerState, GspCommand, SystemMode } from './constants'
import {
  GspAbortedError,
  GspDisconnectedError,
  GspStatusError,
  GspTimeoutError,
} from './errors'
import { decodePaths } from './framing'
import { TraceRecorder } from './trace'
import {
  commandResponse,
  dataFrame,
  endOfLogFrame,
  FakeTransport,
  helloResponse,
  logbookEntriesPayload,
  subscriptionFrame,
} from './testing/fake-transport'

async function makeClient(
  options: { trace?: TraceRecorder; maxConcurrent?: number } = {},
) {
  const transport = new FakeTransport()
  await transport.connect()
  const client = new GspClient(transport, {
    ...(options.trace ? { trace: options.trace } : {}),
    ...(options.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: options.maxConcurrent }),
  })
  client.start()
  return { transport, client }
}

/** The reference code the client chose for the nth command it wrote. */
function refOf(transport: FakeTransport, index = 0): number {
  const write = transport.writes[index]
  if (!write) throw new Error(`No write at index ${index}`)
  return write[1]!
}

afterEach(() => {
  vi.useRealTimers()
})

describe('identity', () => {
  it('decodes a HELLO response, which carries no status field', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      t.emit(
        helloResponse(command[1]!, {
          protocolVersion: 2,
          serialNumber: '174630000192',
          productName: 'Movesense Flash',
          appName: 'DataLogger',
          appVersion: '2.3.1',
        }),
      )
    })

    const info = await client.hello()

    expect(info).toEqual({
      protocolVersion: 2,
      serialNumber: '174630000192',
      productName: 'Movesense Flash',
      dfuMacAddress: 'AA:BB:CC:DD:EE:FF',
      appName: 'DataLogger',
      appVersion: '2.3.1',
    })
    expect(transport.writes[0]![0]).toBe(GspCommand.Hello)
  })
})

describe('GET', () => {
  it('returns the status rather than throwing, so callers can show a 404', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      t.emit(commandResponse(command[1]!, 404))
    })

    await expect(client.get('/Nope')).resolves.toEqual({
      status: 404,
      data: new Uint8Array(0),
    })
  })

  it('throws GspStatusError from the strict helpers', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      t.emit(commandResponse(command[1]!, 404))
    })

    await expect(client.getBatteryLevel()).rejects.toBeInstanceOf(GspStatusError)
  })

  it('decodes single-byte payloads', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const path = decodePaths(command.subarray(2))[0]
      const value = path === '/System/Energy/Level' ? 87 : DataLoggerState.Logging
      t.emit(commandResponse(command[1]!, 200, [value]))
    })

    await expect(client.getBatteryLevel()).resolves.toBe(87)
    await expect(client.getDataLoggerState()).resolves.toBe(DataLoggerState.Logging)
  })
})

describe('reference demultiplexing', () => {
  it('matches responses to commands even when they come back out of order', async () => {
    // This is the whole reason for reference codes, and exactly what the Python
    // reference tool's single drained queue gets wrong.
    const { transport, client } = await makeClient()
    const held: number[] = []
    transport.onCommand((command) => {
      held.push(command[1]!)
    })

    const first = client.get('/A')
    const second = client.get('/B')
    await vi.waitFor(() => expect(held).toHaveLength(2))

    // Answer in reverse, with distinguishable payloads.
    transport.emit(commandResponse(held[1]!, 200, [0xbb]))
    transport.emit(commandResponse(held[0]!, 200, [0xaa]))

    expect([...(await first).data]).toEqual([0xaa])
    expect([...(await second).data]).toEqual([0xbb])
  })

  it('uses a different reference for each in-flight command', async () => {
    const { transport, client } = await makeClient({ maxConcurrent: 8 })
    transport.onCommand(() => {})

    void client.get('/A')
    void client.get('/B')
    void client.get('/C')
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3))

    const refs = transport.writes.map((w) => w[1])
    expect(new Set(refs).size).toBe(3)
  })

  it('routes subscription data to its own handler, not to pending requests', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      t.emit(commandResponse(command[1]!, 200))
    })

    const samples: number[][] = []
    const subscription = await client.subscribe('/Meas/Temp', (payload) => {
      samples.push([...payload])
    })

    transport.emit(subscriptionFrame(subscription.reference, [1, 2, 3]))
    transport.emit(subscriptionFrame(subscription.reference, [4, 5, 6]))

    expect(samples).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])

    await subscription.close()
    expect(transport.writes.at(-1)![0]).toBe(GspCommand.Unsubscribe)
    expect(transport.writes.at(-1)![1]).toBe(subscription.reference)
  })

  it('keeps a subscription reference reserved while it is open', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      t.emit(commandResponse(command[1]!, 200))
    })

    const subscription = await client.subscribe('/Meas/Temp', () => {})
    await client.get('/Something')
    await client.get('/Else')

    const otherRefs = transport.writes.slice(1).map((w) => w[1])
    expect(otherRefs).not.toContain(subscription.reference)
  })

  it('holds commands back rather than exhausting the sensor request pool', async () => {
    // The sensor has a small pool of Whiteboard request slots and answers 429 when
    // it runs out - a state that survives reconnection and needs a reboot. So the
    // client caps how many commands are in flight.
    const { transport, client } = await makeClient({ maxConcurrent: 2 })
    const answered: number[] = []
    transport.onCommand((command) => {
      answered.push(command[1]!)
    })

    void client.get('/A')
    void client.get('/B')
    void client.get('/C')
    await vi.waitFor(() => expect(transport.writes).toHaveLength(2))

    // The third is queued, not written.
    expect(transport.writes).toHaveLength(2)

    // Answering one frees a slot, and the queued command goes out.
    transport.emit(commandResponse(answered[0]!, 200, [1]))
    await vi.waitFor(() => expect(transport.writes).toHaveLength(3))
  })

  it('drops a response that arrives for an unknown reference', async () => {
    const trace = new TraceRecorder()
    const { transport } = await makeClient({ trace })

    transport.emit(commandResponse(200, 200))

    expect(trace.toText()).toContain('Response for unknown reference 200')
  })
})

describe('writes', () => {
  it('appends /Time/Detailed to a DataLogger config', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 200)))

    await client.putDataLoggerConfig(['/Meas/ECG/200/mV'])

    expect(decodePaths(transport.writes[0]!.subarray(2))).toEqual([
      '/Meas/ECG/200/mV',
      '/Time/Detailed',
    ])
  })

  it('does not duplicate /Time/Detailed when the caller already included it', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 200)))

    await client.putDataLoggerConfig(['/Time/Detailed', '/Meas/Temp'])

    expect(decodePaths(transport.writes[0]!.subarray(2))).toEqual([
      '/Time/Detailed',
      '/Meas/Temp',
    ])
  })

  it('accepts 202 from a system mode change, since that is what a reboot returns', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 202)))

    await expect(client.reboot()).resolves.toBeUndefined()
    expect(transport.writes[0]![2]).toBe(SystemMode.Application)
  })

  it('rejects an unexpected status from a system mode change', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 409)))

    await expect(client.reboot()).rejects.toBeInstanceOf(GspStatusError)
  })

  it('maps start and stop onto the documented DataLogger states', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 200)))

    await client.startLogging()
    await client.stopLogging()

    expect(transport.writes[0]![2]).toBe(3)
    expect(transport.writes[1]![2]).toBe(2)
  })
})

describe('logbook listing', () => {
  it('decodes entries and flags an MTU-truncated listing', async () => {
    const trace = new TraceRecorder()
    const { transport, client } = await makeClient({ trace })
    transport.onCommand((command, t) => {
      t.emit(
        commandResponse(
          command[1]!,
          200,
          // The sensor claims 9 entries but only 2 fit in the notification.
          logbookEntriesPayload(
            [
              { id: 1, size: 1024, lastModified: 5 },
              { id: 2, size: 2048 },
            ],
            9,
          ),
        ),
      )
    })

    const result = await client.listLogbookEntries()

    expect(result.declaredCount).toBe(9)
    expect(result.truncated).toBe(true)
    expect(result.entries).toEqual([
      { id: 1, lastModified: 5, size: 1024, fromListing: true },
      { id: 2, lastModified: 0, size: 2048, fromListing: true },
    ])
    expect(trace.toText()).toContain('Logbook listing truncated')
  })
})

describe('fetchLog', () => {
  it('assembles packets by offset, including out of order', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 4, [5, 6, 7, 8]))
      t.emit(dataFrame(ref, 0, [1, 2, 3, 4]))
      t.emit(endOfLogFrame(ref, 8))
    })

    const result = await client.fetchLog(1)

    expect([...result.data]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(result.gaps).toEqual([])
  })

  it('reports missing ranges instead of returning a silently corrupt file', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2, 3, 4]))
      // Packet at offset 4 is lost - GSP has no retransmission.
      t.emit(dataFrame(ref, 8, [9, 10, 11, 12]))
      t.emit(endOfLogFrame(ref, 12))
    })

    const result = await client.fetchLog(1)

    expect(result.data.length).toBe(12)
    expect(result.gaps).toEqual([[4, 8]])
    expect([...result.data.subarray(4, 8)]).toEqual([0, 0, 0, 0])
  })

  it('reports progress against the expected size', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2]))
      t.emit(dataFrame(ref, 2, [3, 4]))
      t.emit(endOfLogFrame(ref, 4))
    })

    const progress: Array<[number, number, number | null]> = []
    await client.fetchLog(1, {
      expectedSize: 4,
      onProgress: ({ position, deliveredBytes, total }) =>
        progress.push([position, deliveredBytes, total]),
    })

    expect(progress).toEqual([
      [2, 2, 4],
      [4, 4, 4],
    ])
  })

  it('reports position, not a running total, so the bar cannot overshoot', async () => {
    // The sensor resends a range it already sent. Summing deliveries would report
    // 6 of a 4-byte file; the position stays at 4.
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2]))
      t.emit(dataFrame(ref, 2, [3, 4]))
      t.emit(dataFrame(ref, 2, [3, 4])) // resent
      t.emit(endOfLogFrame(ref, 4))
    })

    const seen: number[] = []
    const result = await client.fetchLog(1, {
      expectedSize: 4,
      onProgress: ({ position, overrun }) => {
        seen.push(position)
        expect(overrun).toBe(false)
      },
    })

    expect(seen).toEqual([2, 4, 4])
    expect(result.data.length).toBe(4)
    expect(result.deliveredBytes).toBe(6)
  })

  it('never steps position backwards when packets arrive out of order', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 4, [5, 6, 7, 8]))
      t.emit(dataFrame(ref, 0, [1, 2, 3, 4]))
      t.emit(endOfLogFrame(ref, 8))
    })

    const seen: number[] = []
    await client.fetchLog(1, {
      expectedSize: 8,
      onProgress: ({ position }) => seen.push(position),
    })

    expect(seen).toEqual([8, 8])
  })

  it('flags an overrun rather than hiding it', async () => {
    // The logbook said 2 bytes; the sensor sent 4.
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2, 3, 4]))
      t.emit(endOfLogFrame(ref, 4))
    })

    const overruns: boolean[] = []
    await client.fetchLog(1, {
      expectedSize: 2,
      onProgress: ({ overrun }) => overruns.push(overrun),
    })
    expect(overruns).toEqual([true])
  })

  it('streams chunks to a sink instead of buffering, when asked', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2]))
      t.emit(dataFrame(ref, 2, [3, 4]))
      t.emit(endOfLogFrame(ref, 4))
    })

    const chunks: Array<[number, number[]]> = []
    const result = await client.fetchLog(1, {
      onChunk: (offset, bytes) => chunks.push([offset, [...bytes]]),
    })

    expect(chunks).toEqual([
      [0, [1, 2]],
      [2, [3, 4]],
    ])
    // Nothing buffered: the caller took the bytes.
    expect(result.data.length).toBe(0)
    expect(result.deliveredBytes).toBe(4)
  })

  it('fails on a 404 without waiting for data', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 404)))

    await expect(client.fetchLog(99)).rejects.toMatchObject({
      name: 'GspStatusError',
      status: 404,
    })
  })

  it('can be cancelled mid-download', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2, 3, 4]))
      // No end-of-log marker: the transfer stalls until the caller aborts.
    })

    const controller = new AbortController()
    const pending = client.fetchLog(1, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(GspAbortedError)
  })

  it('times out when data stops arriving', async () => {
    vi.useFakeTimers()
    const { transport, client } = await makeClient()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      t.emit(commandResponse(ref, 200))
      t.emit(dataFrame(ref, 0, [1, 2, 3, 4]))
    })

    const pending = client.fetchLog(1, { dataTimeoutMs: 5000 })
    const assertion = expect(pending).rejects.toBeInstanceOf(GspTimeoutError)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })
})

describe('failure handling', () => {
  it('times out a command that is never answered', async () => {
    vi.useFakeTimers()
    const { transport, client } = await makeClient()
    transport.onCommand(() => {})

    const pending = client.get('/Silent')
    const assertion = expect(pending).rejects.toBeInstanceOf(GspTimeoutError)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('survives a response that arrives after its command timed out', async () => {
    vi.useFakeTimers()
    const trace = new TraceRecorder()
    const { transport, client } = await makeClient({ trace })
    transport.onCommand(() => {})

    const pending = client.get('/Late')
    const assertion = expect(pending).rejects.toBeInstanceOf(GspTimeoutError)
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion

    // The straggler must be dropped, not matched to something else.
    expect(() => transport.emit(commandResponse(refOf(transport), 200, [1]))).not.toThrow()
    expect(trace.toText()).toContain('Response for unknown reference')
  })

  it('rejects everything in flight when the link drops', async () => {
    const { transport, client } = await makeClient()
    transport.onCommand(() => {})

    const pending = client.get('/Whatever')
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1))
    transport.dropLink()

    await expect(pending).rejects.toBeInstanceOf(GspDisconnectedError)
  })

  it('refuses to send once stopped', async () => {
    const { client } = await makeClient()
    client.stop()
    await expect(client.get('/Anything')).rejects.toBeInstanceOf(GspDisconnectedError)
  })

  it('does not leak a reference when the write itself fails', async () => {
    const { transport, client } = await makeClient()
    await transport.disconnect()

    await expect(client.get('/Nope')).rejects.toBeInstanceOf(GspDisconnectedError)

    // With the reference released, a subsequent successful command still works.
    await transport.connect()
    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 200, [1])))
    await expect(client.get('/Fine')).resolves.toMatchObject({ status: 200 })
  })
})
