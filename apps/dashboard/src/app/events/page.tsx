"use client";
import { FileSearch, Radio } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLive } from "@/components/live";
import { Badge, Card, CardContent, CardHeader, CardTitle, Mono } from "@/components/ui";
import { ago, cn, short } from "@/lib/utils";

interface Ev {
  index: number;
  leafHash: string;
  capturedAt: string;
  sealedIn: { seq: number; tarVersion: number } | null;
  event: { source: string; sourceId: string; action: string; target: string | null; actor: string | null; occurredAt: string; data: unknown };
}

const FILTERS = [
  { key: "all", label: "All", query: "" },
  { key: "audit", label: "App audit", query: "?source=supabase.app_audit" },
  { key: "auth", label: "Supabase Auth", query: "?source=supabase.auth" },
  { key: "nohb", label: "Hide heartbeats", query: "?heartbeats=0" },
] as const;

const SOURCE_TONE: Record<string, "info" | "warn" | "muted" | "ok"> = {
  "supabase.app_audit": "info",
  "supabase.auth": "warn",
  "vula.heartbeat": "muted",
  "ci.release": "ok",
};

function summary(e: Ev["event"]): string {
  const d = e.data as { old?: { grade?: number } | null; new?: { grade?: number } | null } | null;
  if (e.action.startsWith("grade.") && d) {
    const o = d.old?.grade;
    const n = d.new?.grade;
    return o !== undefined && n !== undefined ? `grade ${o} → ${n}` : n !== undefined ? `grade ${n}` : o !== undefined ? `grade ${o} (deleted)` : "";
  }
  return "";
}

export default function EventsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(FILTERS[3]);
  const { data, error } = useLive<{ anchoredTreeSize: number; events: Ev[] }>(`/api/events${filter.query}`, ["leaves", "checkpoints"], 10_000);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Radio className="h-4 w-4" /> Live events · every one is a Merkle leaf</CardTitle>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-semibold text-muted ring-1 ring-inset ring-line hover:text-ink", filter.key === f.key && "bg-white/5 text-ink")}>
              {f.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {error && <p className="p-5 text-bad">{error}</p>}
        <div className="border-b border-line px-5 py-2 text-xs text-muted">
          leaf hash = SHA-256(0x00 ‖ JCS(event)) · {data ? `${data.anchoredTreeSize} leaves sealed on-chain` : "loading…"} · newest first
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted">
            <tr className="border-b border-line">
              {["Leaf", "Source", "Action", "Target / detail", "Actor", "Occurred", "Leaf hash", "Sealed", ""].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.events ?? []).map((r) => (
              <tr key={r.index} className="border-b border-line/60 hover:bg-white/[0.02]">
                <td className="px-4 py-2 font-semibold">#{r.index}</td>
                <td className="px-4 py-2"><Badge tone={SOURCE_TONE[r.event.source] ?? "muted"}>{r.event.source.replace("supabase.", "")}</Badge></td>
                <td className="px-4 py-2 font-medium">{r.event.action}</td>
                <td className="px-4 py-2 text-muted">
                  <span className="text-ink">{summary(r.event)}</span> <Mono className="text-muted">{short(r.event.target, 18, 6)}</Mono>
                </td>
                <td className="px-4 py-2"><Mono className="text-muted">{short(r.event.actor, 8, 4)}</Mono></td>
                <td className="px-4 py-2 text-muted" title={r.event.occurredAt}>{ago(r.event.occurredAt)}</td>
                <td className="px-4 py-2"><Mono>{short(r.leafHash, 10, 4)}</Mono></td>
                <td className="px-4 py-2">
                  {r.sealedIn ? <Badge tone="ok">TAR v{r.sealedIn.tarVersion}</Badge> : <Badge tone="warn">next checkpoint</Badge>}
                </td>
                <td className="px-4 py-2">
                  <Link href={`/verify?id=${r.index}`} className="inline-flex items-center gap-1 text-brand hover:underline">
                    <FileSearch className="h-3.5 w-3.5" /> prove
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
