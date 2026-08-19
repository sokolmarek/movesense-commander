import { describe, expect, it } from 'vitest'
import { DataLoggerState, GspCommand } from '@/lib/gsp/constants'
import { decodePaths } from '@/lib/gsp/framing'
import {
  commandResponse,
  FakeTransport,
  helloResponse,
} from '@/lib/gsp/testing/fake-transport'
import { DeviceSession } from './session'

/** Answer the commands the connect sequence issues. */
function scriptHappyPath(transport: FakeTransport, battery = 91) {
  transport.onCommand((command, t) => {
    const ref = command[1]!
    switch (command[0]) {
      case GspCommand.Hello:
        t.emit(helloResponse(ref, { serialNumber: '174630000192' }))
        return
      case GspCommand.PutUtcTime:
        t.emit(commandResponse(ref, 200))
        return
      case GspCommand.Get: {
        const path = decodePaths(command.subarray(2))[0]
        if (path === '/System/Energy/Level') t.emit(commandResponse(ref, 200, [battery]))
        else if (path === '/Mem/DataLogger/State')
          t.emit(commandResponse(ref, 200, [DataLoggerState.Ready]))
        else t.emit(commandResponse(ref, 404))
        return
      }
      default:
        t.emit(commandResponse(ref, 200))
    }
  })
}

describe('DeviceSession', () => {
  it('starts idle with nothing known about the sensor', () => {
    const session = new DeviceSession(new FakeTransport())
    expect(session.getSnapshot()).toMatchObject({
      status: 'idle',
      info: null,
      battery: null,
      dataLoggerState: null,
      timeSyncedAt: null,
      busy: false,
    })
  })

  it('identifies, syncs the clock, then reads battery and logger state', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)

    await session.connect()

    // Identity comes first: a read-only command proves the protocol works
    // before we write anything to the sensor.
    expect(transport.writes.map((w) => w[0])).toEqual([
      GspCommand.Hello,
      GspCommand.PutUtcTime,
      GspCommand.Get,
      GspCommand.Get,
    ])

    const snapshot = session.getSnapshot()
    expect(snapshot.status).toBe('connected')
    expect(snapshot.info?.serialNumber).toBe('174630000192')
    expect(snapshot.battery).toBe(91)
    expect(snapshot.dataLoggerState).toBe(DataLoggerState.Ready)
    expect(snapshot.dataLoggerStateLabel).toBe('Ready')
    expect(snapshot.timeSyncedAt).not.toBeNull()
    expect(snapshot.busy).toBe(false)
  })

  it('can skip the clock sync', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport, { syncTimeOnConnect: false })

    await session.connect()

    expect(transport.writes.map((w) => w[0])).not.toContain(GspCommand.PutUtcTime)
    expect(session.getSnapshot().timeSyncedAt).toBeNull()
  })

  it('records the failure and tears down a half-open link when connect fails', async () => {
    const transport = new FakeTransport()
    transport.onCommand((command, t) => {
      // Sensor rejects HELLO - a firmware or pairing problem.
      t.emit(commandResponse(command[1]!, 500))
    })
    const session = new DeviceSession(transport)

    // HELLO has no status field, so a 500 response decodes as garbage rather
    // than a status error. Either way the session must not claim success.
    await session.connect().catch(() => {})

    expect(session.getSnapshot().status).not.toBe('connected')
    expect(transport.connected).toBe(false)
  })

  it('reflects an unexpected disconnect in the snapshot', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)
    await session.connect()

    transport.dropLink()

    const snapshot = session.getSnapshot()
    expect(snapshot.status).toBe('disconnected')
    expect(snapshot.battery).toBeNull()
    expect(snapshot.dataLoggerState).toBeNull()
    // Identity is kept: it is still the same sensor, just not connected.
    expect(snapshot.info?.serialNumber).toBe('174630000192')
  })

  it('notifies subscribers as state changes', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)

    let notifications = 0
    const unsubscribe = session.subscribe(() => notifications++)
    await session.connect()
    unsubscribe()
    const afterUnsubscribe = notifications

    await session.refresh()
    expect(notifications).toBeGreaterThan(0)
    expect(notifications).toBe(afterUnsubscribe)
  })

  it('surfaces a failed refresh without wedging busy', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)
    await session.connect()

    transport.onCommand((command, t) => t.emit(commandResponse(command[1]!, 503)))
    await expect(session.refresh()).rejects.toThrow()

    expect(session.getSnapshot().busy).toBe(false)
    expect(session.getSnapshot().error).toContain('503')
  })

  it('writes the configuration and remembers what was sent', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)
    await session.connect()

    await session.configure(['/Meas/ECG/200/mV', '/Time/Detailed'])

    const config = transport.writes.find(
      (w) => w[0] === GspCommand.PutDataLoggerConfig,
    )!
    expect(decodePaths(config.subarray(2))).toEqual([
      '/Meas/ECG/200/mV',
      '/Time/Detailed',
    ])
    expect(session.getSnapshot().configuredPaths).toEqual([
      '/Meas/ECG/200/mV',
      '/Time/Detailed',
    ])
  })

  it('records a start time when logging begins', async () => {
    const transport = new FakeTransport()
    transport.onCommand((command, t) => {
      const ref = command[1]!
      if (command[0] === GspCommand.Hello) t.emit(helloResponse(ref))
      else if (command[0] === GspCommand.Get) {
        const path = decodePaths(command.subarray(2))[0]
        t.emit(
          commandResponse(ref, 200, [
            path === '/System/Energy/Level' ? 90 : DataLoggerState.Logging,
          ]),
        )
      } else t.emit(commandResponse(ref, 200))
    })
    const session = new DeviceSession(transport)
    await session.connect()

    await session.startRecording()

    expect(session.getSnapshot().recordingStartedAt).not.toBeNull()
    expect(session.getSnapshot().dataLoggerState).toBe(DataLoggerState.Logging)

    // Logging state starts a background poll; disconnecting stops it so the
    // test does not leave an interval running.
    await session.disconnect()
  })

  it('stops, then reboots to roll the log over', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)
    await session.connect()
    const before = transport.writes.length

    await session.stopRecording({ rollOver: true })

    const after = transport.writes.slice(before).map((w) => w[0])
    expect(after).toEqual([
      GspCommand.PutDataLoggerState,
      GspCommand.PutSystemMode,
    ])
    expect(transport.writes.at(-2)![2]).toBe(DataLoggerState.Ready)
    expect(session.getSnapshot().recordingStartedAt).toBeNull()
  })

  it('can stop without rebooting, leaving the link up', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)
    await session.connect()
    const before = transport.writes.length

    await session.stopRecording({ rollOver: false })

    const after = transport.writes.slice(before).map((w) => w[0])
    expect(after).not.toContain(GspCommand.PutSystemMode)
    // Falls back to a state refresh so the UI sees the sensor is Ready again.
    expect(after).toContain(GspCommand.Get)
  })

  it('writes the trace, so a hardware session can be replayed later', async () => {
    const transport = new FakeTransport()
    scriptHappyPath(transport)
    const session = new DeviceSession(transport)
    await session.connect()

    const text = session.trace.toText()
    expect(text).toContain('Hello ref=')
    expect(text).toContain('Identified Movesense Flash 174630000192')
    expect(text).toContain('Sensor clock set from this machine')
  })
})
