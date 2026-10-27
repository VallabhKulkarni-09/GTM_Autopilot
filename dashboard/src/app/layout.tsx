import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

// Self-hosted at build time by next/font; no runtime request to Google.
const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' })

export const metadata: Metadata = {
  title: 'GTM Autopilot',
  description: 'Every inbound lead qualified, routed and followed up, with a recorded reason for every decision.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased min-h-screen text-[14px] leading-[1.5]">
        {children}
      </body>
    </html>
  )
}
