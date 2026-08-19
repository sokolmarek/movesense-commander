# SBEM format reference

SBEM is Suunto's binary recording container. A log downloaded from a Movesense
sensor via `FETCH_LOG` is a complete SBEM file.

Distilled from `examples/sbem-tools/src/sbem_tools/parse_sbem.py` and
`sbem2json.py`, and verified against `examples/sbem-tools/tests/*.sbem`.

## 1. File layout

```
bytes 0..7  : ASCII header, "SBEM0112" in the test fixtures
then        : a sequence of chunks, until EOF
```

Each chunk is `id`, `length`, `payload`:

```
id     : 1 byte if the byte < ESCAPE, else ESCAPE followed by uint16 LE
length : 1 byte if the byte < ESCAPE, else ESCAPE followed by uint32 LE
payload: `length` bytes
```

### The ESCAPE value - a trap

The Python reference writes the sentinel as `ReservedSbemId_e_Escape = b"\255"`.
In Python, `\255` is an **octal** escape, so that constant is `0xAD` (173), not
`0xFF` (255) as the name suggests.

We verified both readings against all three test fixtures: no id or length in
`173..254` occurs as a single byte, so **both interpretations parse the fixtures
identically** and the fixtures cannot settle it.

Our TypeScript parser uses `0xFF` (matching the evident intent and the "255"
in the name) and **warns when it sees a single-byte id or length in `173..254`**,
which is exactly the range where the two readings diverge. If that warning ever
fires on real hardware output, we have a decision to make with real evidence.

## 2. Chunk ids

* `id == 0` - **descriptor chunk** (`ReservedSbemId_e_Descriptor`). Describes how
  to decode data chunks.
* any other id - **data chunk**, where the id selects the descriptor to use.

Logs downloaded from a Movesense **Flash** sensor carry their descriptors inline
(id `0` chunks interleaved with data), so no separate descriptor file is needed.
HR2/HR+/MD recordings need a companion descriptor file, which is why
`sbem2json` has an optional `-d` flag.

Observed ids in the fixtures: `test_1.sbem` uses `0`, `69`, `94`;
`test2_data.bin` uses `101`, `102`, `104`.

## 3. Descriptor chunks

```
bytes 0..1  : data id this descriptor defines (uint16 LE)
bytes 2..   : UTF-8 text, newline-separated lines, optional trailing NUL
```

Lines are tagged:

| Tag | Meaning |
| --- | --- |
| `<PTH>` | dotted path of the value inside the output object |
| `<FRM>` | binary format name, optionally `name,modifier` |
| `<MOD>` | modifier (units, scaling hints) |
| `<GRP>` | comma-separated list of child data ids - this id is a group |

`<FRM>` format names map 1:1 onto fixed-width little-endian types: `int8`,
`uint8`, `int16`, `uint16`, `int32`, `uint32`, `int64`, `uint64`, `float32`,
`float64`, `bool`. `utf8` is variable-width and has no fixed size.

### Path syntax

Paths are split on `.` and `+`. A `+` marks the **preceding** element as an
array and starts a new array element on the next value. So
`Samples+Array.MeasIMU9.Timestamp` means: `Samples` is a repeated array, each
element has `MeasIMU9.Timestamp`.

Suunto-tooling workarounds that the parser strips:

* a leading `+` on a path means "dummy descriptor" - ignore the whole descriptor
* `Samples+Array.` collapses to `Samples+`
* `Samples.Array.` collapses to `Samples.`
* bare `[` / `]` paths are repetition markers - see below. They carry no bytes,
  but they are **not** meaningless: skipping them, as `sbem2json` does, loses the
  sample boundaries.

A real descriptor from `test_1.sbem`:

```
<PTH>Samples+Array.MeasIMU9.Timestamp
<FRM>uint32
```

### The `[` and `]` markers

Two descriptors have a `<PTH>` of exactly `[` or `]`. They carry no bytes; their
job is to appear *inside* a `<GRP>` list and bracket a repeated element. From a
real Movesense Flash IMU9 log:

```
id 13: <PTH>Samples+Array.MeasIMU9.Timestamp   <FRM>uint32
id 39: <PTH>Samples.Array.MeasIMU9.ArrayAcc+x  <FRM>float32
id 40: <PTH>Samples.Array.MeasIMU9.ArrayAcc.y  <FRM>float32
id 41: <PTH>Samples.Array.MeasIMU9.ArrayAcc.z  <FRM>float32
id 89: <GRP>39,40,41
id 54: <PTH>[
id 55: <PTH>]
id 94: <GRP>13,54,89,89,89,89,55,54,90,90,90,90,55,54,91,91,91,91,55
```

Group 94 reads as `Timestamp, [Acc x4], [Gyro x4], [Magn x4]` - a four-sample
chunk. That is 4 + 4x9x4 = 148 bytes, which is exactly the size of every id-94
chunk in the file. Groups 92, 93 and 95 are the one-, two- and eight-sample
variants; the sensor picks whichever matches the chunk it is writing.

`sbem2json` treats `[` and `]` as paths to skip, so it loses the repetition
boundaries and emits `ArrayAcc: [{x: [4 values], y: [...], z: [...]}]` instead of
four `{x, y, z}` samples. The values and their order are the same either way.

### Array marking is inconsistent between siblings

Note above that only `ArrayAcc+x` carries the `+`; `.y` and `.z` do not. So the
`+` cannot be read per-descriptor - the marking has to be pooled across the whole
descriptor set, and any path sharing a prefix that was *ever* marked is an array
too. The Python reference does this with a module-level set; we do it with an
explicit prefix set built as descriptors arrive.

## 4. Decoding data chunks

1. Resolve the descriptor for the chunk id, expanding `<GRP>` recursively into a
   **flat, ordered** list of leaf descriptors.
2. Concatenate their `<FRM>` types into a little-endian struct layout.
3. If the computed fixed size does not equal the chunk payload length, **skip the
   chunk** - that is how the reference tool handles variable-length and
   unrecognised records.
4. Unpack values in order and place each at its `<PTH>` inside the output object,
   honouring array markers.

## 4a. `<MOD>` states the unit

A `<MOD>` line carries the conversion from the stored integer to the physical
value, and it is worth parsing rather than guessing units from a table. From a
real Movesense Flash ECG log:

```
<PTH>Samples.MeasECGmV.Samples
<FRM>int16
<MOD>x*0.001,roundf(MIN(+32.767f,MAX(y,-32.767f))*1000.0f)
```

The first clause is the decode expression: multiply by `0.001`. So the stored
`int16` is **microvolts** and the physical unit is millivolts, clamped to
+/-32.767 mV by the encode expression that follows. This matches what a live
`/Meas/ECG/{rate}/mV` subscription sends, measured independently.

We parse the leading `x*<factor>` into `SbemLeafDescriptor.scale` and expose it on
the document as `scales`, keyed by the path below the root
(`MeasECGmV.Samples` -> `0.001`). Decoded `records` stay **unscaled**, so they can
still be compared against `sbem2json` byte for byte; `extractSamples` applies the
factor, which is where charts, CSV and EDF need physical units.

## 5. Output shape and downstream conversion

`sbem2json` emits `{"Samples": [ ... ]}` - one object per data chunk, each keyed
by its stream name, e.g.

```json
{"Samples": [
  {"TimeDetailed": {"utcTime": 1730000000000000, "relativeTime": 12345}},
  {"MeasIMU9": {"Timestamp": 1000, "ArrayAcc": [{"x": 0.1, "y": 9.8, "z": 0.2}]}},
  {"MeasECG": {"Timestamp": 1000, "Samples": [12, 15, 9]}}
]}
```

`jsonl` mode emits one object per line instead, which is the right choice for
large logs.

Notes taken from `ms_json2csv.py`, useful for our own exporters:

* A `TimeDetailed` record supplies `utcTime` (microseconds) and `relativeTime`
  (milliseconds) - the anchor for converting sensor timestamps to wall clock. In a
  log these are the only two fields, and their order is `relativeTime` then
  `utcTime` - the reverse of the GSP resource, so read them by name rather than
  position. `relativeTime` really is milliseconds: in a verified recording it sat
  3 ms from the first ECG timestamp in the same file.
* Chunk timestamps are per-chunk, not per-sample. Per-sample time is
  interpolated: `dt = (nextChunkTs - chunkTs) / samplesInChunk`.
* `MeasIMU6` / `MeasIMU9` carry several arrays (`ArrayAcc`, `ArrayGyro`,
  `ArrayMagn`) that must be split into separate outputs. All arrays in one chunk
  have equal length.
* `MeasHR` carries `average` plus an `rrData` array; its time base is the
  cumulative sum of RR intervals, not a sample rate.
* The reference tool gap-fills missing ECG chunks with `-1.5` mV so downstream
  EDF/analysis tools keep a constant sample rate. Detect gaps by comparing
  chunk-to-chunk timestamp deltas against the established interval.
