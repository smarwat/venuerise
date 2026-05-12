'use client'

import { ReactNode } from 'react'
import { motion } from 'framer-motion'

type Props = {
  children: ReactNode
  className?: string
  enableHover?: boolean
}

export default function AnimatedBorderCard({ children, className = '', enableHover = true }: Props) {
  return (
    <motion.div
      whileHover={enableHover ? { y: -4 } : undefined}
      transition={{ type: 'spring', stiffness: 300, damping: 22 }}
      className={`group relative ${className}`}
    >
      <div className="border-animated p-[1.5px] rounded-2xl">
        <div className="bg-white rounded-[15px] h-full">{children}</div>
      </div>
    </motion.div>
  )
}
