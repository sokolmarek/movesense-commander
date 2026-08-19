# GSP - GATT SensorData Protocol reference

Distilled from `examples/python-datalogger-tool/sensor_command.py` (a working
reference implementation) and the official
[GSP specification](https://www.movesense.com/docs/esw/gatt_sensordata_protocol/).

> **Authority rule:** where the official docs and the Python example disagree,
> the example wins - it is known to work against real hardware. Divergences we
> found are called out under [Quirks](#8-quirks--gotchas).

## 1. GATT layout

| Role | UUID | Properties |
| --- | --- | --- |
| GSP service | `34802252-7185-4d5d-b431-630e7050e8f0` | advertised by the sensor |
| Command channel (client to sensor) | `34800001-7185-4d5d-b431-630e7050e8f0` | Write (with response) |
| Response channel (sensor to client) | `34800002-7185-4d5d-b431-630e7050e8f0` | Notify |

A BLE scan of a Movesense Flash shows exactly this:

```
74:92:BA:10:F7:D3  'Movesense 250230002214'
  services: 0000fdf3-...  (member-assigned)
            0000180d-...  (standard Heart Rate Service)
```

**Do not filter a Web Bluetooth chooser on the service UUID alone.** A BLE
advertising packet carries 31 bytes; a 128-bit service UUID costs 18 of them and
the local name `Movesense 174630000192` costs 24, so the sensor cannot advertise
both - and it advertises the name. The upstream README claims devices advertise
the GSP service UUID, but the Python tool's own scanner never filters on it: it
scans unfiltered and matches `device.name.endswith(serial)`.

So filter on `namePrefix: 'Movesense'` (optionally OR-ed with the service UUID,
in case some firmware does advertise it) and list the service under
`optionalServices` so it stays reachable after connecting.

Advertised names end with the serial number, which is how the Python tool
identifies a specific sensor.

A sensor that the operating system has paired **and connected** stops
advertising, so no browser scan will find it. Movesense requires no pairing;
remove it from the OS device list.

## 2. Framing

### Command (write)

```
byte 0      : command code (uint8)
byte 1      : reference code (uint8, client-chosen)
byte 2..N   : command payload (little-endian; <= MTU-5)
```

The reference code ties a response back to its command. The sensor processes
commands asynchronously and responses may interleave, so **always demultiplex by
reference code** - never assume FIFO ordering.

### Response (notification)

```
byte 0      : response code (uint8)
byte 1      : reference code (uint8, echoes the command)
```

Then, by response code:

| Code | Name | Layout of byte 2.. |
| --- | --- | --- |
| `1` | `COMMAND_RESPONSE` | `status` (uint16 LE, HTTP-style) then response data |
| `2` | `DATA` | payload (subscription sample, or log chunk) |
| `3` | `DATA_PART2` | continuation payload when data exceeds one notification |

Status codes follow HTTP semantics: `200` OK, `202` Accepted (async, e.g. system
mode change), `404` not found (e.g. probing a non-existent log id), `409`
conflict (see the firmware <= 2.3.1 note in [section 6](#6-operational-sequences)).

## 3. Commands

| Code | Name | Payload | Response payload |
| --- | --- | --- | --- |
| `0` | `HELLO` | - | see [section 4](#4-hello-response) |
| `1` | `SUBSCRIBE` | NUL-terminated UTF-8 resource path | status; then `DATA`/`DATA_PART2` stream on the same ref |
| `2` | `UNSUBSCRIBE` | - (ref must match the SUBSCRIBE) | status |
| `3` | `FETCH_LOG` | log id (uint32 LE) | status; then `DATA` chunks, see [section 5](#5-fetch_log-data-stream) |
| `4` | `GET` | NUL-terminated UTF-8 resource path | status + GSP-encoded object |
| `5` | `CLEAR_LOGBOOK` | - | status |
| `6` | `PUT_DATALOGGER_CONFIG` | concatenated NUL-terminated UTF-8 paths | status |
| `7` | `PUT_SYSTEMMODE` | mode (uint8) | status (`202` on success) |
| `8` | `PUT_UTCTIME` | microseconds since 1970-01-01 UTC (uint64 LE) | status |
| `9` | `PUT_DATALOGGER_STATE` | state (uint8) | status |

### DataLogger states

`2` = READY (stops logging), `3` = LOGGING (starts logging). The Python tool also
maps `1` = Unknown for display. Read back with `GET /Mem/DataLogger/State`
(single uint8 in the response data).

### System modes

`1` = FullPowerOff, `5` = Application (reboot into the app), `12` =
FwUpdateMode. `PUT_SYSTEMMODE 5` is used as a soft reset; it answers `202` and
the sensor then drops the BLE link.

## 4. HELLO response

`HELLO` is the one command whose response has **no uint16 status field** - the
payload starts at byte 2:

```
byte 2      : protocol version (uint8)
byte 3..    : NUL-separated UTF-8 strings, in order:
              serial number, product name, DFU MAC, app name, app version
```

Treat it as status `200` if a notification arrives at all.

## 5. FETCH_LOG data stream

After a `200` on the `FETCH_LOG` command, the sensor pushes `DATA` (`2`) /
`DATA_PART2` (`3`) notifications on the same reference:

```
byte 2..5   : byte offset into the log file (uint32 LE)
byte 6..    : file bytes to write at that offset
```

* An **empty body** (payload length exactly 4, i.e. offset only) marks
  end-of-log.
* Because each packet carries its own offset, assemble into a sparse buffer
  keyed by offset rather than appending. The Python tool does
  `f.seek(offset); f.write(bytes)` for exactly this reason.
* There is no retransmission (notifications are unacknowledged). Detect gaps
  after EOF and re-fetch if a hole remains.
* Probing an unused log id returns `404`; the Python tool uses that to discover
  logs beyond the ones the logbook listing returned.

The assembled bytes are an [SBEM file](./sbem-format.md).

## 6. Operational sequences

**Connect**
1. Connect GATT, get the GSP service and both characteristics.
2. `startNotifications` on the notify characteristic **before** writing anything.
3. `HELLO` for identity.
4. `PUT_UTCTIME` with `Date.now() * 1000` (microseconds) - needed so recorded
   logs can be anchored to wall-clock time.
5. `GET /System/Energy/Level` and `GET /Mem/DataLogger/State`.

The Python tool sets the time before saying HELLO; we do it after. The order is
not significant to the sensor, and a read-only command first proves the protocol
works before we write anything.

**Record**
1. `PUT_DATALOGGER_CONFIG` with the desired paths, always including
   `/Time/Detailed` - that is what lets you map sensor timestamps to UTC.
2. `PUT_DATALOGGER_STATE 3` to start.
3. `PUT_DATALOGGER_STATE 2` to stop, then `PUT_SYSTEMMODE 5` to reboot. The
   reboot flushes the log and rolls over to a fresh log id. Allow ~4 s before
   reconnecting.

**Download**
1. `GET /Mem/Logbook/entries` for the listing (see quirk below).
2. `FETCH_LOG` per id; probe `maxId + 1`, `+2`, ... until `404`.
3. `PUT_SYSTEMMODE 5` afterwards - works around a `409` on firmware <= 2.3.1.

**Erase**: `CLEAR_LOGBOOK`. Destructive and irreversible.

### 429 means the request pool is gone, and only a reboot brings it back

The sensor keeps a small pool of Whiteboard request slots. Exhaust it and it
answers **429 to every request**, including trivial ones like
`GET /System/Energy/Level`. Two things make this worse than an ordinary rate
limit:

* **Disconnecting and reconnecting does not clear it.** The state outlives the
  BLE link.
* A request that never gets a response appears to leave its slot occupied. One
  `GET /Info` that times out is enough to start the slide.

`PUT /System/Mode = 5` clears it. So: cap in-flight commands (our client allows
two), treat 429 as its own error rather than a generic failure, and expect to
reboot after any timeout. `GspBusyError` carries this explanation.

### Resources that do not work over GSP

* `/Info` - never responds. The request times out and burns a slot, so avoid it.
* `/Info/App` - answers 200 with an empty payload.
* `/System/Memory/Heap` - answers **503**.
* `/Meas/HR` - subscribe-only; a GET answers **401** with an empty body.

### There is no generic write

Worth stating plainly, because the API reference invites the opposite conclusion:
GSP can `GET` and `SUBSCRIBE` any path, but it has exactly **four** writes -
DataLogger config, DataLogger state, system mode and UTC time. A resource the
reference documents as PUT-able (`/Meas/Acc/Config`, `/Component/Leds/0`, …) is
read-only over this protocol. Changing those needs a different transport
entirely.

## 7. GSP binary object encoding (GET / SUBSCRIBE payloads)

Fields are packed in the order they appear in the resource's API YAML
definition, little-endian, with no padding:

* scalars: `int8/uint8/int16/uint16/int32/uint32/int64/uint64/float32/float64/bool`
* strings: NUL-terminated UTF-8

### Arrays come in two forms

This is the part no published document states, and getting it wrong yields
plausible, silently wrong numbers.

**Info and config resources prefix each array with a `uint8` count.** Confirmed
against hardware - `GET /Meas/Acc/Info` returns 22 bytes:

```
08  0d00 1a00 3400 6800 d000 a001 4103 8206   count=8, rates 13..1666 Hz
04  02 04 08 16                               count=4, G ranges 2/4/8/16
```

**Measurement subscriptions have no count at all.** The element count is fixed by
the resource's `ArraySize` - readable from `GET /Meas/ECG/Info` - and the arrays
simply fill the packet. Where a packet carries several arrays they are
equal-length and stored **array-major**: every accelerometer sample, then every
gyroscope sample, then every magnetometer sample.

`SUBSCRIBE /Meas/IMU9/52` returns 148 bytes: `uint32` timestamp + 36 `float32`.
That is 4 + 144, and 144 / (3 sensors x 3 axes x 4 bytes) = **4 samples**. Three
`uint8` counts would have made it 151. Exactly the structure the SBEM descriptor
group for IMU9 describes.

`SUBSCRIBE /Meas/ECG/200` returns 36 bytes: `uint32` timestamp + 16 `int16`,
matching the `ArraySize` of 16 from `/Meas/ECG/Info`.

### Shapes verified against hardware

| Resource | Payload |
| --- | --- |
| `/System/Energy/Level` | `uint8` battery percent |
| `/Mem/DataLogger/State` | `uint8` state |
| `/Mem/Logbook/entries` | `uint8` entry count, then 16 bytes per entry: id `uint32`, lastModified `uint32`, size `uint64` |
| `/Meas/Acc/Info` | `uint16[]` sample rates, `uint8[]` G ranges - both count-prefixed |
| `/Meas/Gyro/Info`, `/Meas/Magn/Info` | `uint16[]` rates, **`uint16[]`** ranges. The range element width differs by sensor |
| `/Meas/HR` | `float32` average, then `uint16` RR intervals filling the packet. Subscribe-only: a GET answers `401` with an empty body |
| `/Time/Detailed` | `uint64` utcTime µs, `uint32` relativeTime **in ticks**, `uint32` tickRate Hz, `uint32` accuracy |
| `/Meas/ECG/Info` | `uint16[]` rates, `uint16` ArraySize, `uint16[]` low-pass Hz, `float32[]` high-pass Hz |
| `/Meas/IMU9/{rate}` | `uint32` timestamp, then acc / gyro / magn blocks of `float32` x,y,z filling the packet. Units m/s², dps, µT |
| `/Meas/ECG/{rate}` and `/{rate}/mV` | `uint32` timestamp, then `int16` samples filling the packet |
| `/Meas/Temp` | `uint32` timestamp, `float32` Kelvin |
| `/Meas/IMU/Info` | rates, then acc `uint8[]`, gyro `uint16[]`, magn `uint16[]` ranges |
| `/Meas/ECG/Config` | `uint16` low-pass Hz, `float32` high-pass Hz |
| `/Meas/Temp/Info` | `uint32` min K, `uint32` max K, `float32` accuracy - 233/398 K is -40 to +125 C |
| `/Meas/HR/Info` | `uint16`, `uint16`, `float32` - 200 / 2000 / 5.0; structure certain, names inferred |
| `/Meas/IMU6/{rate}` | `uint32` timestamp, then acc and gyro blocks filling the packet |

**`relativeTime` is in milliseconds, despite `tickRate`.** The record reports
`tickRate = 1024`, which invites the conclusion that `relativeTime` counts RTC
ticks. It does not. Measured over 21.432 s of `utcTime`, `relativeTime` advanced
by 21432 - exactly 1000 per second. `tickRate` describes the underlying clock, not
the unit of this field, and dividing by it would introduce a 2.4% error. A logged
`TimeDetailed` record corroborates this: it carries only `relativeTime` and
`utcTime`, no tick rate, and its `relativeTime` sits 3 ms from the first ECG
timestamp in the same file. A capture:

```
58 d8 97 e1 69 59 06 00   utcTime      1787161151527000 us -> 2026-08-19T17:39:11.527Z
d0 89 24 00               relativeTime 2394576 ticks
00 04 00 00               tickRate     1024 Hz  -> 2338.5 s uptime
14 00 00 00               accuracy     20
```

That the UTC field decodes to a correct, current date is strong corroboration of
the whole layout: a wrong offset would give a nonsense year.

**The sensor knows more than the reference does.** `/Meas/Gyro/Info` reports five
ranges - 125, 245, 500, 1000 and 2000 dps - where the API reference lists only
four. Read capabilities from the sensor, not from the documentation.

**The two ECG paths differ, and neither returns floats.** Measured by subscribing
to both at once and comparing samples that share a timestamp:

| Path | Packet | Samples | Unit |
| --- | --- | --- | --- |
| `/Meas/ECG/{rate}` | 68 B | 16 x `int32` | raw counts |
| `/Meas/ECG/{rate}/mV` | 36 B | 16 x `int16` | **microvolts**, despite the name |

```
ts=8617  raw = 20835 20488 20147 19833
         mV  =  7948  7816  7685  7566
         median ratio 0.38146975  vs  0.381469726563 uV per count
```

So the `/mV` path is pre-scaled and narrowed, not converted to millivolts. Divide
by 1000 for mV. A logged ECG stream says the same thing in its own descriptor:
`<MOD>x*0.001,...` - see [the SBEM reference](./sbem-format.md).

**Download throughput** measured 11.3 kB/s over BLE with no lost packets
(5272 bytes in 0.5 s), which is much better than the "few kB/s" the plan
assumed.

Because payload shapes are per-resource, the client keeps a layout registry keyed
by path pattern (`src/lib/gsp/layouts.ts`). A layout is applied only when it
consumes the payload **exactly**, and each records whether it was verified against
hardware, derived from SBEM descriptors, documented, or guessed. Anything else is
shown as raw hex - which is the correct output for a shape we do not know.

## 8. Quirks & gotchas

* **`/Mem/Logbook/entries` is MTU-truncated.** The listing arrives in a single
  notification, so only as many 16-byte entries as fit are returned (~4 at the
  default MTU). Always combine the listing with `404`-probing to enumerate logs.
  The 5-byte "header" the Python parser skips is really
  `respCode(1) + ref(1) + status(2) + arrayLength(1)`.
* **The Python example serialises everything through one response queue** and
  drains it before each write (`send_command`). That races with in-flight
  subscription data. Our client demultiplexes by reference code instead.
* **The example hardcodes reference codes** and reuses `101` for both
  `FETCH_LOG` and the `GET /Mem/DataLogger/State` inside `get_status`. Allocate
  refs dynamically and keep a subscription's ref reserved for its lifetime.
* **ECG raw to mV**: multiply raw int samples by `0.000381469726563`. Firmware
  >= 2.3 can do the conversion on-device via `/Meas/ECG/{rate}/mV`.
* **Practical path limit**: the reference GUI caps DataLogger config at 3 paths
  and warns above 200 Hz ECG / 104 Hz IMU, because higher combined throughput
  drops samples. Treat as a soft warning, not a protocol limit.
* **`PUT_SYSTEMMODE` returns `202`, not `200`.** Accept both.
