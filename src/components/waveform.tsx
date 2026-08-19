import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { decimate } from '@/lib/chart/decimate'
import type { SampleSeries } from '@/lib/sbem/samples'

/**
 * Waveform preview for one sample series.
 *
 * uPlot rather than a React charting library: an ECG trace is tens or hundreds of
 * thousands of points, and anything that builds a virtual DOM node per point
 * cannot keep up. Points are decimated to the pixel width first, keeping the
 * min and max of each bucket so peaks survive.
 */
export function Waveform({
  series,
  height = 220,
}: {
  series: SampleSeries
  height?: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const [width, setWidth] = useState(0)

  // Time in seconds from the start of the series reads better than raw
  // millisecond timestamps in the millions.
  const prepared = useMemo(() => {
    const origin = series.timestamps[0] ?? 0
    const seconds = series.timestamps.map((value) => (value - origin) / 1000)
    return decimate(seconds, series.values, Math.max(200, width * 2))
  }, [series, width])

  useEffect(() => {
    const element = container.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = container.current
    if (!element || width === 0) return

    const styles = getComputedStyle(element)
    const foreground = styles.getPropertyValue('--color-foreground').trim() || '#111'
    const muted = styles.getPropertyValue('--color-muted-foreground').trim() || '#888'
    const border = styles.getPropertyValue('--color-border').trim() || '#ddd'
    // Monochrome ramp, so multi-axis series stay inside the palette.
    const strokes = [foreground, muted, border]

    const options: uPlot.Options = {
      width,
      height,
      padding: [8, 8, 0, 0],
      cursor: { drag: { x: true, y: false } },
      legend: { live: true },
      scales: { x: { time: false } },
      axes: [
        {
          stroke: muted,
          grid: { stroke: border, width: 1 },
          ticks: { stroke: border },
          label: 'seconds',
          labelSize: 20,
        },
        {
          stroke: muted,
          grid: { stroke: border, width: 1 },
          ticks: { stroke: border },
        },
      ],
      series: [
        { label: 's' },
        ...series.columns.map((column, index) => ({
          label: column,
          stroke: strokes[index % strokes.length]!,
          width: 1.25,
          points: { show: false },
        })),
      ],
    }

    const data = [prepared.x, ...prepared.columns] as uPlot.AlignedData
    plot.current = new uPlot(options, data, element)

    return () => {
      plot.current?.destroy()
      plot.current = null
    }
  }, [prepared, series.columns, width, height])

  if (series.timestamps.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">This series has no samples.</p>
    )
  }

  return (
    <div className="space-y-2">
      <div ref={container} className="w-full" />
      <p className="text-muted-foreground text-xs tabular">
        {prepared.originalLength.toLocaleString()} samples
        {prepared.decimated
          ? ` · drawn as ${prepared.x.length.toLocaleString()} points, keeping the minimum and maximum of each bucket`
          : ''}
        {series.estimatedRateHz
          ? ` · ~${series.estimatedRateHz.toFixed(2)} Hz`
          : ' · sensor paced'}
        {series.filledSamples > 0
          ? ` · ${series.filledSamples} filled to bridge gaps`
          : ''}
      </p>
      <p className="text-muted-foreground text-xs">
        Drag left-to-right to zoom; double-click to reset.
      </p>
    </div>
  )
}
