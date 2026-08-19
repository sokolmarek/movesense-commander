/**
 * jsdom does not implement `matchMedia`, and anything that reacts to the
 * system colour scheme (next-themes with `enableSystem`, our own media
 * queries) calls it on mount. Stub it so component tests can run.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// Tells React 19 that `act(...)` is legitimate here, which quiets the
// "testing environment is not configured to support act(...)" warning.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
