import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * `base` only applies to production builds, where it must match the GitHub
 * Pages path for this repo. Dev stays at `/` so localhost URLs are plain.
 * Deep links survive on Pages because the app uses hash routing
 * (see src/routes/router.tsx).
 */
const PAGES_BASE = process.env.VITE_BASE ?? '/movesense-commander/'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? PAGES_BASE : '/',
  plugins: [react(), tailwindcss()],
  build: {
    // The main chunk is ~500 kB raw / ~160 kB gzipped, nearly all of it React,
    // Radix and the router - a floor we cannot split below. The parts that do
    // grow with features (uPlot, the exporters) are already lazy-loaded, so the
    // default 500 kB warning fires on the baseline rather than on anything
    // actionable. Budget set deliberately above it.
    chunkSizeWarningLimit: 600,
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
}))
