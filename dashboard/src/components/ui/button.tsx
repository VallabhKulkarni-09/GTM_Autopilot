import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[7px]",
    "text-[13px] font-medium leading-none",
    "transition-colors duration-100",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--apple-blue)]",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Primary: ink, not blue. Colour is reserved for meaning.
        default: "bg-[#18181B] text-white shadow-[0_1px_1px_rgba(0,0,0,0.12)] hover:bg-[#27272A] active:bg-[#3F3F46]",
        destructive: "bg-[#B42318] text-white hover:bg-[#9B1F15] active:bg-[#7F1D14]",
        outline: "border border-[color:var(--border-strong)] bg-white text-[color:var(--apple-text-primary)] shadow-[0_1px_1px_rgba(0,0,0,0.04)] hover:bg-[#FAFAF9] active:bg-[#F4F4F3]",
        secondary: "bg-[#F4F4F3] text-[color:var(--apple-text-primary)] hover:bg-[#EDEDEC] active:bg-[#E7E5E4]",
        ghost: "text-[color:var(--apple-text-secondary)] hover:bg-[#F4F4F3] hover:text-[color:var(--apple-text-primary)]",
        link: "text-[color:var(--apple-blue)] underline-offset-4 hover:underline rounded-none px-0 h-auto",
      },
      size: {
        default: "h-9 px-3.5",
        sm:      "h-8 px-3 text-[12px]",
        lg:      "h-10 px-5 text-[14px]",
        icon:    "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
