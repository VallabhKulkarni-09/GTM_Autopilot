import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[5px] px-1.5 py-[3px] text-[11px] font-medium leading-none border",
  {
    variants: {
      variant: {
        default:     "bg-[color:var(--tint-blue)] text-[color:var(--apple-blue)] border-[#D7E0F4]",
        secondary:   "bg-[#F4F4F3] text-[color:var(--apple-text-secondary)] border-[color:var(--apple-separator)]",
        destructive: "bg-[color:var(--tint-red)] text-[color:var(--apple-red)] border-[#F6D5D2]",
        outline:     "bg-white text-[color:var(--apple-text-secondary)] border-[color:var(--border-strong)]",
        success:     "bg-[color:var(--tint-green)] text-[color:var(--apple-green)] border-[#CFE8D7]",
        warning:     "bg-[color:var(--tint-orange)] text-[color:var(--apple-orange)] border-[#F5DCC4]",
      },
    },
    defaultVariants: { variant: "default" },
  }
)
export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
