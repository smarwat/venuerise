'use client'

import { useRef, ReactNode } from 'react'
import { motion, useMotionValue, useSpring, useReducedMotion } from 'framer-motion'

type Props = {
  href?: string
  onClick?: () => void
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'invert'
  size?: 'md' | 'lg'
  className?: string
  type?: 'button' | 'submit'
  ariaLabel?: string
}

export default function CTAButton({
  href,
  onClick,
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ariaLabel,
}: Props) {
  const ref = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()

  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const springX = useSpring(x, { stiffness: 200, damping: 18, mass: 0.4 })
  const springY = useSpring(y, { stiffness: 200, damping: 18, mass: 0.4 })

  const handleMove = (e: React.MouseEvent) => {
    if (reduced) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const relX = e.clientX - rect.left - rect.width / 2
    const relY = e.clientY - rect.top - rect.height / 2
    x.set(relX * 0.18)
    y.set(relY * 0.25)
  }

  const handleLeave = () => {
    x.set(0)
    y.set(0)
  }

  const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-xl select-none transition-colors duration-200 will-change-transform'
  const sizing = size === 'lg' ? 'px-8 py-4 text-[15px] min-h-[52px]' : 'px-6 py-3 text-[14px] min-h-[44px]'

  const variants = {
    primary:
      'bg-[#1A6FFF] text-white hover:bg-[#1058D6] shadow-[0_8px_24px_-8px_rgba(26,111,255,0.5)] hover:shadow-[0_14px_36px_-10px_rgba(26,111,255,0.6)]',
    secondary:
      'border-[1.5px] border-[#1A6FFF]/30 text-[#1A6FFF] hover:border-[#1A6FFF]/60 hover:bg-[#1A6FFF]/5',
    invert:
      'bg-white text-[#1A6FFF] hover:bg-white/95 shadow-[0_8px_30px_rgba(0,0,0,0.18)]',
  }

  const inner = (
    <motion.span
      ref={ref as React.RefObject<HTMLSpanElement>}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={{ x: springX, y: springY }}
      className={`${base} ${sizing} ${variants[variant]} ${className}`}
    >
      {children}
    </motion.span>
  )

  if (href) {
    return (
      <a href={href} aria-label={ariaLabel} className="inline-block">
        {inner}
      </a>
    )
  }
  return (
    <button type={type} onClick={onClick} aria-label={ariaLabel} className="inline-block bg-transparent border-0 p-0">
      {inner}
    </button>
  )
}
