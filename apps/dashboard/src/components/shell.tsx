"use client";
import { LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { supabase } from "@/lib/client";
import { cn } from "@/lib/utils";
import { AuthGate, useSession } from "./auth";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/events", label: "Live events" },
  { href: "/checkpoints", label: "Checkpoints" },
  { href: "/verify", label: "Verify" },
  { href: "/alerts", label: "Alerts" },
  { href: "/attacks", label: "Attack lab" },
];

export function Shell({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <Header />
      <main className="mx-auto max-w-[1400px] px-6 py-6">{children}</main>
    </AuthGate>
  );
}

function Header() {
  const path = usePathname();
  const session = useSession();
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <ShieldCheck className="h-7 w-7 text-brand" />
          <span className="text-xl font-bold tracking-tight">Vula</span>
          <span className="hidden text-sm text-muted md:inline">tamper-evident audit trail · anchored on Compellio TARs</span>
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn("rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-ink", path === n.href && "bg-white/5 text-ink")}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm text-muted">
          <span className="hidden sm:inline">{session.user.email}</span>
          <button onClick={() => supabase().auth.signOut()} className="rounded-md p-1.5 hover:bg-white/5 hover:text-ink" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
