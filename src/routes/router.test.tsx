// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { afterEach, describe, expect, it } from 'vitest'
import { router } from './router'

/**
 * A smoke test that the shell actually mounts. Cheap insurance: most breakage
 * in a scaffold like this is a bad import or a provider that needs a DOM, and
 * neither shows up in `tsc` or `vite build`.
 */

let container: HTMLDivElement | null = null

afterEach(() => {
  container?.remove()
  container = null
})

function mount() {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <RouterProvider router={router} />
      </ThemeProvider>,
    )
  })
  return container
}

describe('app shell', () => {
  it('renders the dashboard at the index route', () => {
    const el = mount()
    expect(el.textContent).toContain('Movesense Commander')
    expect(el.textContent).toContain('Dashboard')
    expect(el.textContent).toContain('Connect sensor')
  })

  it('reports Web Bluetooth as unavailable when the API is absent', () => {
    // jsdom has no navigator.bluetooth, which is exactly the unsupported-browser
    // case the dashboard must handle without throwing.
    const el = mount()
    expect(el.textContent).toContain('Web Bluetooth unavailable')
  })

  it('has a route for every sidebar destination', () => {
    const paths = router.routes[0]?.children?.map((child) => child.path)
    expect(paths).toEqual([
      undefined, // index route
      'record',
      'logs',
      'stream',
      'explorer',
      'settings',
      '*',
    ])
  })
})
