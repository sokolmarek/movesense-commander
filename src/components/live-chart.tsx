import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { decimate } from '@/lib/chart/decimate'
import type { LiveChannel } from '@/lib/stream/live'

/**
 * A continuously updating chart for one live channel.
 *
 * Unlike the static `Waveform`, the uPlot instance is created once and fed with
 * `setData` - rebuilding it per frame would drop frames at any real sample rate.
 * Redraws are also throttled to a fixed cadence rather than running on every
 * packet: a 512 Hz ECG stream delivers 32 packets a second, and repainting that
 * often buys nothing a person can see.
 */
const REDRAW_INTERVAL_MS = 100

export function LiveChart({
  channel,
  windowSeconds,
  height = 200,
}: {
  channel: LiveChannel
  /** How much recent history to show. */
  windowSeconds: number
  height?: number
}) {
  const container = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const latest = useRef(channel)
  const [width, setWidth] = useState(0)

  latest.current = channel

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

  // Build the plot once per shape change, not per data change.
  useEffect(() => {
    const element = container.current
    if (!element || width === 0) return

    const styles = getComputedStyle(element)
    const foreground = styles.getPropertyValue('--color-foreground').trim() || '#111'
    const muted = styles.getPropertyValue('--color-muted-foreground').trim() || '#888'
    const border = styles.getPropertyValue('--color-border').trim() || '#ddd'
    const strokes = [foreground, muted, border]

    const instance = new uPlot(
      {
        width,
        height,
        padding: [8, 8, 0, 0],
        cursor: { drag: { x: false, y: false } },
        legend: { live: true },
        scales: { x: { time: false } },
        axes: [
          { stroke: muted, grid: { stroke: border, width: 1 }, label: 'seconds' },
          {
            stroke: muted,
            grid: { stroke: border, width: 1 },
            label: channel.unit.unit || undefined,
          },
        ],
        series: [
          { label: 's' },
          ...channel.columns.map((column, index) => ({
            label: column,
            stroke: strokes[index % strokes.length]!,
            width: 1.25,
            points: { show: false },
          })),
        ],
      },
      [[], ...channel.columns.map(() => [])] as uPlot.AlignedData,
      element,
    )
    plot.current = instance

    const timer = setInterval(() => {
      const current = latest.current
      const time = current.time
      if (time.length === 0) return

      // Keep only the trailing window, then decimate to the pixel width so the
      // work per frame stays flat however long the stream has been running.
      const cutoff = time[time.length - 1]! - windowSeconds * 1000
      let from = 0
      while (from < time.length && time[from]! < cutoff) from++

      const origin = time[from] ?? 0
      const seconds = time.slice(from).map((value) => (value - origin) / 1000)
      const columns = current.values.map((column) => column.slice(from))
      const reduced = decimate(seconds, columns, Math.max(200, width * 2))

      instance.setData([reduced.x, ...reduced.columns] as uPlot.AlignedData)
    }, REDRAW_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      instance.destroy()
      plot.current = null
    }
    // Rebuild only when the shape or geometry changes, never on new samples.
  }, [width, height, windowSeconds, channel.columns, channel.unit.unit])

  return <div ref={container} className="w-full" />
}
