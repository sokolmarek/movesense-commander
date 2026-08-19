# Movesense Commander

A control station for [Movesense](https://www.movesense.com) sensors that runs
entirely in your browser. Configure recordings, download and decode logs, watch
live data, and read any resource on the sensor API, all over Web Bluetooth.

**[Open the app](https://sokolmarek.github.io/movesense-commander/)**

No installation, no drivers, no account, and no server. The page talks to the
sensor directly, and anything you download stays on your own machine.

## What it does

**Connect.** Pick a sensor from the browser's Bluetooth chooser and see its
serial number, product, firmware, battery level and logger state. Several sensors
can be connected at once. The sensor clock is set from your computer on connect,
which is what lets a recording carry a real wall-clock time.

**Record.** Choose which measurements the sensor logs to its own memory and at
what sample rate, with a running estimate of the resulting data rate and a warning
when a combination is likely to drop samples. Save configurations as presets and
apply one to every connected sensor at once.

**Download.** List the recordings on the sensor, download them with progress and
cancellation, and keep them in the browser for later. Large recordings can stream
straight to a file on disk instead. Downloads report any byte ranges that went
missing, because the protocol has no retransmission.

**Inspect and export.** Recordings decode in the browser to per-channel sample
series with a timestamp per sample. Export:

| Format | Notes |
| --- | --- |
| `.sbem` | The raw file, exactly as the sensor sent it |
| JSON, JSONL | Values as stored, matching Movesense's own `sbem2json` |
| CSV | One file per channel, in physical units, optionally with a UTC column |
| EDF+ | Standard biosignal format, readable by clinical and research tools |

**Stream live.** Subscribe to ECG, accelerometer, gyroscope, magnetometer, IMU6,
IMU9, heart rate or temperature and watch it arrive on a live chart in physical
units, with the measured sample rate and an exact count of any samples lost in
transit.

**Explore the API.** Send a `GET` or `SUBSCRIBE` to any resource path and see the
decoded result beside the raw bytes. Where the field layout of a response is not
known with confidence, the bytes are shown as hex rather than decoded into numbers
that might be wrong.

## Requirements

A Movesense sensor, and a browser that implements Web Bluetooth. That means
Chromium:

| Browser | Supported |
| --- | --- |
| Chrome, Edge, Opera on Windows, macOS, Linux, Android | Yes |
| Firefox | No |
| Safari | No |
| Any browser on iOS | No, because they all use WebKit |

The page must also be served over HTTPS, which the hosted link is.

## If the sensor does not appear

The browser runs its own Bluetooth scan, separate from the one in your operating
system's settings, so a sensor listed there may still be missing from the chooser.
In order of likelihood:

1. **It is paired in the operating system.** A paired sensor that the OS has
   connected to stops advertising, and then no browser can find it. Movesense
   needs no pairing, so remove it from the system Bluetooth device list.
2. **Another application has it.** Only one program can hold a Movesense sensor
   at a time. Close any phone app, desktop tool or second browser tab.
3. **It went to sleep.** The sensor stops advertising when left still. Move it,
   then connect within a few seconds.
4. **It advertises an unexpected name.** The app has a button to list every
   Bluetooth device in range, for sensors running custom firmware.

## Your data

Everything happens in the browser. Recordings are stored locally, in the
browser's own storage, and are never uploaded anywhere. Clearing the site's data
deletes them, so export anything worth keeping. The Settings page shows how much
space they occupy and can delete them all.

## Documentation

The Movesense protocol and recording format are only partly documented upstream,
so this repository includes references written from measurements against real
hardware:

| Document | What it covers |
| --- | --- |
| [docs/gsp-protocol.md](./docs/gsp-protocol.md) | The GATT SensorData Protocol: framing, commands, payload layouts, and the places the published documentation disagrees with the hardware |
| [docs/sbem-format.md](./docs/sbem-format.md) | The SBEM recording container: chunk framing, descriptors, and how a stream declares its own units |

## Building from source

```bash
npm install
npm run dev      # development server
npm run test     # unit tests
npm run lint
npm run build    # typecheck and production bundle into dist/
```

## Acknowledgements

Built against Movesense's open [GATT SensorData
Protocol](https://www.movesense.com/docs/esw/gatt_sensordata_protocol/) and
[API reference](https://www.movesense.com/docs/esw/api_reference/).

Two upstream Movesense projects, both MIT licensed, informed the protocol and
format work: `python-datalogger-tool` and `sbem-tools`. The SBEM test fixture at
`src/lib/sbem/__fixtures__/imu9-prefix.sbem` is derived from test data in
`sbem-tools`, and the expected output beside it was produced by that project's
`sbem2json`. Their licence notice sits alongside those files in
[`src/lib/sbem/__fixtures__/LICENSE-sbem-tools`](./src/lib/sbem/__fixtures__/LICENSE-sbem-tools).

Movesense is a trademark of Suunto Oy. This is an independent project, not
affiliated with or endorsed by Suunto.

## Licence

[MIT](./LICENSE), copyright 2026 Marek Sokol.
