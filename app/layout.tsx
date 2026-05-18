import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'VenueRise — AI Revenue Operations for Wedding Venues',
  description:
    'VenueRise helps wedding venues respond instantly, follow up automatically, and recover lost leads with an AI-powered revenue operations system built for venues.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  )
}
