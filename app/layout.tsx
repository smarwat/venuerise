import type { Metadata } from 'next'
import { Inter, Playfair_Display } from 'next/font/google'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
})

export const metadata: Metadata = {
  title: 'VenueRise — AI Revenue Operations for Wedding Venues',
  description:
    'VenueRise helps wedding venues respond instantly, follow up automatically, and recover lost leads with an AI-powered revenue operations system built for venues.',
  keywords: [
    'wedding venue software',
    'venue automation',
    'AI revenue operations',
    'wedding venue CRM',
    'venue lead management',
    'tour booking automation',
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable} scroll-smooth`}>
      <body className="bg-white text-[#0A0A1A] antialiased font-sans overflow-x-hidden">
        {children}
      </body>
    </html>
  )
}
