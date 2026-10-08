import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'DocuForge - Enterprise Documentation Lifecycle & Governance',
  description: 'Intelligent technical documentation maintenance, review pipelines, and audit trails',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  )
}
