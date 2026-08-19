import { NavLink, Outlet } from 'react-router-dom'
import {
  Activity,
  CircleDot,
  Download,
  LayoutDashboard,
  Radio,
  Settings,
  Terminal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemeToggle } from '@/components/theme-toggle'
import { StatusBar } from '@/components/status-bar'

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/record', label: 'Record', icon: CircleDot, end: false },
  { to: '/logs', label: 'Logs', icon: Download, end: false },
  { to: '/stream', label: 'Live stream', icon: Radio, end: false },
  { to: '/explorer', label: 'API explorer', icon: Terminal, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
] as const

export function AppShell() {
  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex flex-1">
        <aside className="bg-sidebar border-sidebar-border hidden w-60 shrink-0 flex-col border-r md:flex">
          <div className="flex h-14 items-center gap-2 px-4">
            <Activity className="size-5" strokeWidth={2.5} />
            <span className="text-sm font-semibold tracking-tight">
              Movesense Commander
            </span>
          </div>

          <nav className="flex flex-1 flex-col gap-0.5 p-2">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center justify-between px-3 py-3">
            <span className="text-muted-foreground text-xs">Theme</span>
            <ThemeToggle />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <StatusBar />
    </div>
  )
}
