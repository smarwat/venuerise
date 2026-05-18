import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full rounded-xl bg-white border border-[#E2E8F0] px-3.5 py-2 text-sm text-[#0F172A] placeholder:text-[#94A3B8]',
          'transition-all duration-200',
          'hover:border-[#CBD5E1]',
          'focus:outline-none focus:border-[#1D4ED8] focus:ring-[3px] focus:ring-[#3B82F6]/15',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-[#F8FAFC]',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
