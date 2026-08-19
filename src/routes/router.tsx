import { createHashRouter } from 'react-router-dom'
import { AppShell } from '@/components/app-shell'
import { Dashboard } from '@/routes/dashboard'
import { Record } from '@/routes/record'
import { Logs } from '@/routes/logs'
import { Stream } from '@/routes/stream'
import { Explorer } from '@/routes/explorer'
import { Settings } from '@/routes/settings'
import { NotFound } from '@/routes/not-found'

// Hash routing so deep links work on GitHub Pages without SPA rewrites.
export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'record', element: <Record /> },
      { path: 'logs', element: <Logs /> },
      { path: 'stream', element: <Stream /> },
      { path: 'explorer', element: <Explorer /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])
