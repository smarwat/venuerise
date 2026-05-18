'use client'

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { Database } from '@/types/database'

type Venue = Database['public']['Tables']['venues']['Row']

interface DashboardContextValue {
  venue: Venue | null
  setVenue: (venue: Venue | null) => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

export function DashboardProvider({
  children,
  initialVenue,
}: {
  children: ReactNode
  initialVenue: Venue | null
}) {
  const [venue, setVenue] = useState<Venue | null>(initialVenue)

  return (
    <DashboardContext.Provider value={{ venue, setVenue }}>
      {children}
    </DashboardContext.Provider>
  )
}

export function useDashboard() {
  const ctx = useContext(DashboardContext)
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider')
  return ctx
}
