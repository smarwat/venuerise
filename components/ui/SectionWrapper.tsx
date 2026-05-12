import { ReactNode } from 'react'

type Props = {
  id?: string
  children: ReactNode
  className?: string
  surface?: 'white' | 'alt'
  divider?: boolean
}

export default function SectionWrapper({
  id,
  children,
  className = '',
  surface = 'white',
  divider = true,
}: Props) {
  return (
    <section
      id={id}
      className={`relative py-24 lg:py-32 overflow-hidden ${
        surface === 'alt' ? 'surface-alt' : 'bg-white'
      } ${className}`}
    >
      {divider && (
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-black/[0.06] to-transparent" />
      )}
      <div className="noise-layer" aria-hidden="true" />
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">{children}</div>
    </section>
  )
}
