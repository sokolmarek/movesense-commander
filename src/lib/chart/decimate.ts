/**
 * Downsample a series for display while keeping its shape.
 *
 * ECG at 512 Hz over ten minutes is 300k points. Handing that to a chart that is
 * 800 pixels wide wastes most of the work, but plain "every Nth sample" hides
 * spikes - exactly the features an ECG trace is read for. So each output bucket
 * keeps the minimum and the maximum, which preserves the envelope: an R-peak
 * survives even at 1000:1.
 */

export interface DecimatedSeries {
  readonly x: number[]
  /** One array per input column, aligned with `x`. */
  readonly columns: number[][]
  readonly originalLength: number
  readonly decimated: boolean
}

export function decimate(
  x: readonly number[],
  columns: readonly number[][],
  targetPoints: number,
): DecimatedSeries {
  const length = x.length
  // Two output points per bucket, so ask for half as many buckets.
  const buckets = Math.max(1, Math.floor(targetPoints / 2))

  if (length <= targetPoints || buckets >= length) {
    return {
      x: [...x],
      columns: columns.map((column) => [...column]),
      originalLength: length,
      decimated: false,
    }
  }

  const outX: number[] = []
  const outColumns: number[][] = columns.map(() => [])
  const bucketSize = length / buckets

  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * bucketSize)
    const end = Math.min(length, Math.floor((bucket + 1) * bucketSize))
    if (end <= start) continue

    // The first column drives which samples are picked, so every column stays
    // aligned to the same two source indices.
    let minIndex = start
    let maxIndex = start
    const driver = columns[0]
    if (driver) {
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY
      for (let i = start; i < end; i++) {
        const value = driver[i]!
        if (!Number.isFinite(value)) continue
        if (value < min) {
          min = value
          minIndex = i
        }
        if (value > max) {
          max = value
          maxIndex = i
        }
      }
    }

    const [first, second] =
      minIndex <= maxIndex ? [minIndex, maxIndex] : [maxIndex, minIndex]

    for (const index of first === second ? [first] : [first, second]) {
      outX.push(x[index]!)
      columns.forEach((column, c) => outColumns[c]!.push(column[index]!))
    }
  }

  return {
    x: outX,
    columns: outColumns,
    originalLength: length,
    decimated: true,
  }
}
