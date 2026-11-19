// shadcn/ui-style primitives (copied pattern: cva + tailwind-merge), kept in one file for the hackathon.
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-line bg-panel shadow-lg shadow-black/20", className)} {...p} />;
}

export function CardHeader({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-3 border-b border-line px-5 py-3", className)} {...p} />;
}

export function CardTitle({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-semibold uppercase tracking-wider text-muted", className)} {...p} />;
}

export function CardContent({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...p} />;
}

const badge = cva("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset", {
  variants: {
    tone: {
      ok: "bg-ok/10 text-ok ring-ok/30",
      warn: "bg-warn/10 text-warn ring-warn/30",
      bad: "bg-bad/10 text-bad ring-bad/30",
      info: "bg-brand/10 text-brand ring-brand/30",
      muted: "bg-white/5 text-muted ring-white/10",
    },
  },
  defaultVariants: { tone: "muted" },
});

export function Badge({ className, tone, ...p }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...p} />;
}

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-brand text-bg hover:bg-brand/90",
        danger: "bg-bad/15 text-bad ring-1 ring-inset ring-bad/40 hover:bg-bad/25",
        ghost: "text-muted hover:bg-white/5 hover:text-ink",
        outline: "ring-1 ring-inset ring-line text-ink hover:bg-white/5",
      },
    },
    defaultVariants: { variant: "primary" },
  },
);

export function Button({ className, variant, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant }), className)} {...p} />;
}

export function Mono({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-mono text-[0.85em] text-ink/90", className)} {...p} />;
}

export function severityTone(s: string): "bad" | "warn" | "info" {
  return s === "critical" ? "bad" : s === "warning" ? "warn" : "info";
}
