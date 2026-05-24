import * as React from "react";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium tracking-[-0.005em] transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-soft)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-paper)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-[14px] [&_svg]:shrink-0 select-none",
  {
    variants: {
      variant: {
        primary:
          "rounded-md bg-[var(--color-action)] text-[var(--color-action-ink)] hover:bg-[var(--color-action-hover)]",
        accent:
          "rounded-md bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[inset_0_1px_0_var(--color-action-border)] hover:bg-[var(--color-accent-strong)]",
        secondary:
          "rounded-md border border-[var(--color-line)] bg-[var(--color-paper-raised)] text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]",
        subtle:
          "rounded-md bg-[var(--color-paper-sunken)] text-[var(--color-ink)] hover:bg-[var(--color-line)]",
        ghost:
          "rounded-md text-[var(--color-ink-soft)] hover:bg-[var(--color-paper-sunken)] hover:text-[var(--color-ink)]"
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        sm: "h-7 px-2.5 text-[12.5px]",
        lg: "h-9 px-4 text-[13.5px]",
        icon: "h-8 w-8"
      }
    },
    defaultVariants: {
      variant: "secondary",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
