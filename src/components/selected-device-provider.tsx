import { useMemo, useState, type ReactNode } from 'react'
import { SelectedDeviceContext } from '@/lib/device/selected-device'

export function SelectedDeviceProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const value = useMemo(
    () => ({ selectedId, select: setSelectedId }),
    [selectedId],
  )

  return (
    <SelectedDeviceContext.Provider value={value}>
      {children}
    </SelectedDeviceContext.Provider>
  )
}
