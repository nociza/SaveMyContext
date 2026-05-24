import type { HTMLAttributes } from "react";

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10.5px] font-medium tracking-[-0.005em]",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--color-paper-sunken)] text-[var(--color-ink-soft)] ring-1 ring-inset ring-[var(--color-line)]",
        success: "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-inset ring-[var(--color-success-line)]",
        warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-inset ring-[var(--color-warning-line)]",
        danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-1 ring-inset ring-[var(--color-danger-line)]",
        info: "bg-[var(--color-info-bg)] text-[var(--color-info-text)] ring-1 ring-inset ring-[var(--color-info-line)]"
      }
    },
    defaultVariants: {
      tone: "neutral"
    }
  }
);

type BadgeProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ tone }), className)} {...props} />;
}
