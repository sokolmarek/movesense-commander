import { beforeEach, describe, expect, it } from 'vitest'
import { presetStore } from './presets'
import { DEFAULT_SETTINGS, settingsStore } from '@/lib/settings'

/**
 * These stores back onto localStorage, which does not exist in the node test
 * environment. Both fall back to memory, so the logic is still exercised.
 */
beforeEach(() => {
  for (const preset of [...presetStore.getSnapshot()]) presetStore.remove(preset.id)
  settingsStore.reset()
})

describe('presets', () => {
  it('saves a preset with a slug id derived from its name', () => {
    const preset = presetStore.save('ECG at 200 Hz', [
      { measurementId: 'ecg', rate: 200 },
    ])
    expect(preset.id).toBe('ecg-at-200-hz')
    expect(preset.name).toBe('ECG at 200 Hz')
    expect(presetStore.getSnapshot()).toHaveLength(1)
  })

  it('does not collide when two presets share a name', () => {
    presetStore.save('Study A', [{ measurementId: 'ecg' }])
    presetStore.save('Study A', [{ measurementId: 'acc' }])
    const ids = presetStore.getSnapshot().map((preset) => preset.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual(['study-a', 'study-a-2'])
  })

  it('falls back to a usable name and id for empty input', () => {
    const preset = presetStore.save('   ', [{ measurementId: 'ecg' }])
    expect(preset.name).toBe('Untitled')
    expect(preset.id).toBe('preset')
  })

  it('removes by id', () => {
    presetStore.save('Keep', [{ measurementId: 'ecg' }])
    const drop = presetStore.save('Drop', [{ measurementId: 'acc' }])
    presetStore.remove(drop.id)
    expect(presetStore.getSnapshot().map((p) => p.name)).toEqual(['Keep'])
  })

  it('round-trips through JSON', () => {
    presetStore.save('Round trip', [{ measurementId: 'imu9', rate: 52 }])
    const json = presetStore.toJson()

    presetStore.remove('round-trip')
    expect(presetStore.getSnapshot()).toHaveLength(0)

    const result = presetStore.fromJson(json)
    expect(result).toEqual({ imported: 1, skipped: 0 })
    expect(presetStore.getSnapshot()[0]!.selections).toEqual([
      { measurementId: 'imu9', rate: 52 },
    ])
  })

  it('rejects a file that is not JSON, with a readable message', () => {
    expect(() => presetStore.fromJson('not json at all')).toThrow(/not valid JSON/)
  })

  it('rejects JSON without a presets array', () => {
    expect(() => presetStore.fromJson('{"other":1}')).toThrow(/presets" array/)
  })

  it('skips malformed entries instead of importing garbage', () => {
    // Someone else's file should not be able to corrupt the list.
    const result = presetStore.fromJson(
      JSON.stringify({
        presets: [
          { name: 'Good', selections: [{ measurementId: 'ecg' }] },
          { name: 'No selections' },
          { selections: [{ measurementId: 'ecg' }] },
          { name: 'Bad selection', selections: [{ nope: true }] },
        ],
      }),
    )
    expect(result).toEqual({ imported: 1, skipped: 3 })
    expect(presetStore.getSnapshot().map((p) => p.name)).toEqual(['Good'])
  })
})

describe('settings', () => {
  it('starts at the documented defaults', () => {
    expect(settingsStore.getSnapshot()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.syncTimeOnConnect).toBe(true)
  })

  it('updates one key without disturbing the others', () => {
    settingsStore.set('temperatureUnit', 'K')
    expect(settingsStore.getSnapshot()).toEqual({
      ...DEFAULT_SETTINGS,
      temperatureUnit: 'K',
    })
  })

  it('notifies subscribers on change', () => {
    let notifications = 0
    const unsubscribe = settingsStore.subscribe(() => notifications++)
    settingsStore.set('syncTimeOnConnect', false)
    expect(notifications).toBe(1)
    unsubscribe()
    settingsStore.set('syncTimeOnConnect', true)
    expect(notifications).toBe(1)
  })

  it('resets to defaults', () => {
    settingsStore.set('rebootAfterStop', false)
    settingsStore.reset()
    expect(settingsStore.getSnapshot()).toEqual(DEFAULT_SETTINGS)
  })
})
