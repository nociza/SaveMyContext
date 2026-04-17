import type { HTMLAttributes } from "react";

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--color-paper-sunken)] text-[var(--color-ink-soft)]",
        success: "bg-[rgba(15,138,132,0.12)] text-[#076b66]",
        warning: "bg-[rgba(209,132,37,0.14)] text-[#8b561a]",
        danger: "bg-[rgba(193,90,64,0.14)] text-[#963c24]",
        info: "bg-[rgba(73,104,171,0.14)] text-[#3b558d]"
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
