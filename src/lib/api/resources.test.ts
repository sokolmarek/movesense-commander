import { describe, expect, it } from 'vitest'
import { RESOURCES, searchResources } from './resources'
import { layoutsFor } from '@/lib/gsp/layouts'

describe('resource catalog', () => {
  it('has unique paths, each starting with a slash', () => {
    const paths = RESOURCES.map((r) => r.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) expect(path.startsWith('/')).toBe(true)
  })

  it('gives every resource at least one operation GSP can perform', () => {
    for (const resource of RESOURCES) {
      expect(resource.operations.length).toBeGreaterThan(0)
      for (const operation of resource.operations) {
        // GSP has no generic PUT, so nothing else may appear here.
        expect(['GET', 'SUBSCRIBE']).toContain(operation)
      }
    }
  })

  it('marks writable only the four resources GSP can actually write', () => {
    const writable = RESOURCES.filter((r) => r.writable).map((r) => r.path)
    expect(writable.sort()).toEqual([
      '/Mem/DataLogger/Config',
      '/Mem/DataLogger/State',
      '/System/Mode',
      '/Time',
    ])
  })

  it('ranks an exact path above a substring match', () => {
    const results = searchResources('/Meas/Temp')
    expect(results[0]!.path).toBe('/Meas/Temp')
  })

  it('finds resources by summary text too', () => {
    const results = searchResources('battery')
    expect(results.map((r) => r.path)).toContain('/System/Energy/Level')
  })

  it('returns nothing for a path that does not exist', () => {
    expect(searchResources('/Nope/Nothing')).toEqual([])
  })

  it('has a decodable layout for the paths a user is most likely to try', () => {
    for (const path of ['/System/Energy/Level', '/Meas/Temp', '/Meas/HR', '/Time']) {
      expect(layoutsFor(path).length).toBeGreaterThan(0)
    }
  })

  it('leaves placeholder paths marked, so the UI can insist on a rate', () => {
    const templated = RESOURCES.filter((r) => r.path.includes('{n}'))
    expect(templated.length).toBeGreaterThan(0)
    for (const resource of templated) {
      expect(resource.operations).toContain('SUBSCRIBE')
    }
  })
})
