"use client";
import { ExternalLink } from "lucide-react";
import { useLive } from "@/components/live";
import { Badge, Card, CardContent, CardHeader, CardTitle, Mono } from "@/components/ui";
import { ago, short } from "@/lib/utils";

interface Row {
  seq: number; tree_size: number; prev_tree_size: number; root: string; checksum: string; status: string; tar_version: number | null;
  tx_hash: string | null; anchored_at: string | null; attempts: number; last_error: string | null; issued_at: string; key_id: string; explorer: string | null;
}

export default function CheckpointsPage() {
  const { data, error } = useLive<Row[]>("/api/checkpoints", ["checkpoints"], 15_000);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Checkpoints timeline · one TAR version each</CardTitle>
        <span className="text-sm text-muted">signed Ed25519 · SHA-256(JCS(payload)) pushed on-chain via the Compellio Registry API</span>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {error && <p className="p-5 text-bad">{error}</p>}
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted">
            <tr className="border-b border-line">
              {["Seq", "TAR version", "Events", "New", "Root hash", "On-chain checksum", "Status", "Anchored", "Transaction"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.seq} className="border-b border-line/60 hover:bg-white/[0.02]">
                <td className="px-4 py-2.5 font-semibold">#{r.seq}</td>
                <td className="px-4 py-2.5">{r.tar_version ?? "—"}</td>
                <td className="px-4 py-2.5">{r.tree_size}</td>
                <td className="px-4 py-2.5 text-muted">+{r.tree_size - r.prev_tree_size}</td>
                <td className="px-4 py-2.5"><Mono>{short(r.root, 12, 6)}</Mono></td>
                <td className="px-4 py-2.5"><Mono>0x{short(r.checksum, 10, 6)}</Mono></td>
                <td className="px-4 py-2.5">
                  <Badge tone={r.status === "anchored" ? "ok" : r.status === "failed" ? "bad" : "warn"} title={r.last_error ?? undefined}>
                    {r.status}{r.attempts > 0 && r.status !== "anchored" ? ` ×${r.attempts}` : ""}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-muted">{ago(r.anchored_at)}</td>
                <td className="px-4 py-2.5">
                  {r.explorer ? (
                    <a href={r.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                      <Mono>{short(r.tx_hash, 10, 6)}</Mono><ExternalLink className="h-3 w-3" />
                    </a>
                  ) : <Mono className="text-muted">{short(r.tx_hash, 10, 6)}</Mono>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
