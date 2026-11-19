"use client";
import { AlertTriangle, BellRing, CheckCircle2, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ago, cn } from "@/lib/utils";
import { useLive, type AlertRow } from "./live";
import { Badge, Card, CardContent, CardHeader, CardTitle, severityTone } from "./ui";

const ICON = { critical: AlertTriangle, warning: AlertTriangle, info: Info } as const;

export function AlertsFeed({ limit = 12, title = "Alerts · live" }: { limit?: number; title?: string }) {
  const { data } = useLive<AlertRow[]>("/api/alerts", ["alerts"], 20_000);
  const seen = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!data) return;
    if (seen.current) {
      const n = new Set(data.filter((a) => !seen.current!.has(a.id)).map((a) => a.id));
      if (n.size) setFresh(n);
    }
    seen.current = new Set(data.map((a) => a.id));
  }, [data]);

  const rows = (data ?? []).slice(0, limit);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="h-4 w-4" /> {title}
        </CardTitle>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-ok" /> Supabase Realtime
        </span>
      </CardHeader>
      <CardContent className="space-y-2 p-3">
        {data && rows.length === 0 && (
          <div className="flex items-center gap-2 px-2 py-6 text-muted">
            <CheckCircle2 className="h-5 w-5 text-ok" /> No alerts. The log matches the chain.
          </div>
        )}
        {rows.map((a) => {
          const Icon = ICON[a.severity];
          return (
            <div
              key={a.id}
              className={cn(
                "rounded-lg border border-line bg-panel-2 px-3 py-2.5",
                a.severity === "critical" && "border-bad/40",
                fresh.has(a.id) && "flash-in",
              )}
            >
              <div className="flex items-start gap-2.5">
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", a.severity === "critical" ? "text-bad" : a.severity === "warning" ? "text-warn" : "text-brand")} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-snug">{a.title}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge tone={severityTone(a.severity)}>{a.kind}</Badge>
                    {typeof a.details?.layer === "string" && <span>{a.details.layer as string}</span>}
                    <span>{ago(a.created_at)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
