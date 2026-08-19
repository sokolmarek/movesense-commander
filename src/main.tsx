import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SelectedDeviceProvider } from '@/components/selected-device-provider'
import { Toaster } from '@/components/ui/sonner'
import { router } from '@/routes/router'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <TooltipProvider delayDuration={300}>
        <SelectedDeviceProvider>
          <RouterProvider router={router} />
          <Toaster />
        </SelectedDeviceProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
