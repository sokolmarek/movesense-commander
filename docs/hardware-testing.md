# Hardware test checklist

CI has no sensor, so anything that touches BLE has to be checked by hand. Run
the relevant section before each release, on Chrome or Edge, with a charged
sensor that is not connected to anything else.

Record the sensor's firmware/app version from HELLO in your notes - several
behaviours are version-dependent (see `docs/gsp-protocol.md`).

## Setup

- [ ] Sensor powered, in range, not paired to a phone or another app
- [ ] Page served over HTTPS or from `localhost`
- [ ] Protocol trace panel open, so every frame is captured

## Phase 1 - connect and identify

- [ ] Chooser lists the sensor with the default name filter
- [ ] If it does not: the sensor is not paired in the OS, no other app holds it,
      and it has been moved recently enough to still be advertising
- [ ] HELLO returns serial, product name, DFU MAC, app name, app version
- [ ] Serial matches the number printed on the sensor
- [ ] Battery level is plausible (`GET /System/Energy/Level`)
- [ ] DataLogger state reads Ready or Logging, not Unknown
- [ ] UTC time sync on connect succeeds
- [ ] Walking the sensor out of range raises a disconnect, not a hang
- [ ] Reconnect works, without a page reload

## Phase 2 - record

- [ ] `/Meas/*/Info` returns sample rates matching the API reference
- [ ] A single-path config (`/Meas/Temp`) starts and stops cleanly
- [ ] A three-path config including ECG at 200 Hz starts and stops cleanly
- [ ] `/Time/Detailed` is present in every written config
- [ ] Stop then `PUT_SYSTEMMODE 5` rolls over to a new log id
- [ ] State polling reflects Logging while recording

## Phase 3 - download

- [ ] `/Mem/Logbook/entries` lists logs; note how many entries fit in one frame
- [ ] Probing past the last id returns `404` and stops enumeration
- [ ] Download progress advances monotonically and completes
- [ ] Cancelling mid-download leaves the app usable
- [ ] No gaps remain after EOF (or gaps are detected and re-fetched)
- [ ] **Downloaded bytes are identical to `datalogger_tool.py fetch` output**
- [ ] Erase memory empties the logbook, and only after confirmation

## Phase 4 - decode and export

- [ ] SBEM decode produces the same streams as `sbem2json`
- [ ] The `173..254` escape-byte warning does **not** fire (see
      `docs/sbem-format.md`); if it does, capture the file and investigate
- [ ] CSV matches `ms_json2csv.py` output for the same log
- [ ] EDF+ opens in an external viewer with the right sample rate
- [ ] Waveform preview matches the exported data

## Phase 5 - live stream

The decoding, channel splitting, unit conversion and loss counting are covered by
`src/lib/stream/live.hardware.test.ts`, which replays real captured packets. What
still needs a sensor is the part a replay cannot show: whether the chart keeps up,
and how much real BLE jitter and loss occurs over minutes rather than seconds.


- [ ] ECG at 200 Hz renders smoothly, measured rate is within 1 % of requested
- [ ] Acc/Gyro/Magn/IMU6/IMU9 axis values are plausible under motion
- [ ] HR and Temp update at the expected cadence
- [ ] Unsubscribe stops the stream and frees its reference code
- [ ] Subscribing while a download is running does not corrupt either

## Payload layouts

Any `GET` or `SUBSCRIBE` whose response the explorer cannot decode is useful
evidence. Capture the hex and add it to
`src/lib/gsp/layouts.hardware.test.ts`, which holds real captured payloads as
fixtures - the strongest tests in the project, because they check our decoder
against what the sensor actually sent rather than against our own assumptions.

Resolved and captured as fixtures: `/Meas/Acc/Info`, `/Meas/Gyro/Info`,
`/Meas/Magn/Info`, `/Meas/IMU/Info`, `/Meas/ECG/Info`, `/Meas/ECG/Config`,
`/Meas/Temp/Info`, `/Meas/HR/Info`, `/Meas/IMU9/{rate}`, `/Meas/IMU6/{rate}`,
`/Meas/ECG/{rate}` (both paths), `/Meas/HR`, `/Meas/Temp`, `/Time/Detailed`.

Also verified end to end: configure, record, stop, reboot-to-roll-over, list the
logbook, download, and decode. `src/lib/sbem/__fixtures__/ecg-flash-log.sbem` is a
real 5272-byte recording, checked sample-for-sample against `sbem2json`.

**Before any batch of requests, reboot the sensor.** A request that times out
leaves a Whiteboard slot occupied, and once the pool is exhausted the sensor
answers 429 to everything until rebooted - reconnecting does not help.

Still unresolved:

- [ ] An ECG recording **on a person**, to confirm a real QRS complex looks right
      end to end and that the millivolt scaling gives sensible amplitudes. The
      unit itself is settled; this is about the whole pipeline on a real signal.
- [ ] `/Meas/Acc/Config`, `/Meas/Gyro/Config`, `/Meas/Magn/Config` - 429'd before
      they could be read. Retry after a reboot.
- [ ] `/Component/Leds`, `/Comm/Ble/Addr`, `/Mem/Logbook/IsFull`,
      `/Mem/DataLogger/Config` - same, still uncaptured.
- [ ] `/System/States/*` - untested.
- [ ] A log large enough to span the MTU-truncated logbook listing, to exercise
      the "find more" enumeration path.
- [ ] Multi-day: whether a 429 can be provoked purely by request rate, rather than
      by a timeout leaving a slot behind.

## Regressions

Export the protocol trace for anything that misbehaves and add it as a fake
transport fixture, so the bug becomes a headless test.
