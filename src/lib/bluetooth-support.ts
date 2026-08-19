/**
 * Web Bluetooth availability. Chromium-only: Chrome, Edge, Opera on desktop
 * and Android. Safari and Firefox do not implement it at all, and iOS cannot
 * (every iOS browser uses WebKit).
 */

export type BluetoothSupport =
  | { supported: true }
  | { supported: false; reason: 'insecure-context' | 'no-api'; detail: string }

export function checkBluetoothSupport(): BluetoothSupport {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'no-api', detail: 'Not running in a browser.' }
  }

  // Web Bluetooth requires a secure context. localhost counts as secure, so
  // this only bites when serving over plain HTTP from a LAN address.
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'insecure-context',
      detail:
        'Web Bluetooth needs a secure context. Open this page over HTTPS, or from localhost during development.',
    }
  }

  if (!('bluetooth' in navigator)) {
    return {
      supported: false,
      reason: 'no-api',
      detail:
        'This browser has no Web Bluetooth support. Use Chrome, Edge or Opera on Windows, macOS, Linux or Android. Safari and Firefox do not implement Web Bluetooth, and no browser on iOS can.',
    }
  }

  return { supported: true }
}

/** Whether the browser can re-open previously permitted devices without the chooser. */
export function supportsPersistentDevices(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'bluetooth' in navigator &&
    typeof navigator.bluetooth.getDevices === 'function'
  )
}
