"use client";
import { Activity, Anchor, Database, ExternalLink, HeartPulse, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { AlertsFeed } from "@/components/alerts-feed";
import { AttackPanel } from "@/components/attack-panel";
import { useLive } from "@/components/live";
import { Badge, Card, CardContent, CardHeader, CardTitle, Mono } from "@/components/ui";
import { ago, short } from "@/lib/utils";

interface Overview {
  counts: { leaves: number; audit: number; auth: number; heartbeats: number; last_captured: string | null };
  checkpoints: { total: number; anchored: number; pending: number };
  lastAnchored: { seq: number; tree_size: number; root: string; tar_version: number; tx_hash: string; anchored_at: string; explorer: string | null } | null;
  tar: { tarId: string; chainId: number; address: string; explorer: string | null; createdAt: string } | null;
  profile: { tarId: string; rootSchemaTarId: string; address: string; explorer: string | null } | null;
  alerts: { critical: number; warning: number };
  logServer: { treeSize: number; unanchoredLeaves: number; halted: string | null; pending: { seq: number; attempts: number; error: string } | null; heartbeat: { gapOpen: boolean; lastHeartbeatAt: string | null } } | null;
  chainRpc: string;
  registryMode: string;
}

const CHAINS: Record<number, string> = { 31337: "Hardhat (local)", 127823: "Etherlink Shadownet" };

export default function OverviewPage() {
  const { data, error } = useLive<Overview>("/api/overview", ["checkpoints", "alerts"], 10_000);
  if (error) return <p className="text-bad">{error}</p>;
  if (!data) return <p className="text-muted">Loading…</p>;
  const ls = data.logServer;
  const healthy = !!ls && !ls.halted && !ls.heartbeat.gapOpen && !ls.pending;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Database className="h-5 w-5" />} label="Events sealed" value={data.counts.leaves.toLocaleString()}
          sub={`${data.counts.audit} audit · ${data.counts.auth} auth · ${data.counts.heartbeats} heartbeats`} />
        <Kpi icon={<Activity className="h-5 w-5" />} label="Merkle tree size" value={(ls?.treeSize ?? data.counts.leaves).toLocaleString()}
          sub={ls ? `${ls.unanchoredLeaves} waiting for next checkpoint` : "log server offline"} />
        <Kpi icon={<Anchor className="h-5 w-5" />} label="Last anchored checkpoint"
          value={data.lastAnchored ? `#${data.lastAnchored.seq}` : "—"}
          sub={data.lastAnchored ? `TAR v${data.lastAnchored.tar_version} · ${data.lastAnchored.tree_size} events · ${ago(data.lastAnchored.anchored_at)}` : "none yet"}
          link={data.lastAnchored?.explorer ?? undefined} />
        <Kpi icon={<HeartPulse className="h-5 w-5" />} label="Health"
          value={healthy ? "Healthy" : ls?.heartbeat.gapOpen ? "Collector silent" : ls?.halted ? "Halted" : ls?.pending ? "Anchor retrying" : "Log server offline"}
          tone={healthy ? "ok" : "bad"}
          sub={ls ? `heartbeat ${ago(ls.heartbeat.lastHeartbeatAt)} · ${data.alerts.critical} critical alerts (24 h)` : "start the log server"} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Compellio TAR (trust anchor)</CardTitle>
              <Badge tone="info">Registry API: {data.registryMode}</Badge>
            </CardHeader>
            <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
              <Field label="TAR id"><Mono>{data.tar?.tarId ?? "created at first checkpoint"}</Mono></Field>
              <Field label="Chain">{data.tar ? `${CHAINS[data.tar.chainId] ?? "EVM"} (EIP-155 ${data.tar.chainId})` : "—"}</Field>
              <Field label="TAR contract">
                {data.tar?.explorer ? <a className="inline-flex items-center gap-1 text-brand hover:underline" href={data.tar.explorer} target="_blank" rel="noreferrer"><Mono>{data.tar.address}</Mono><ExternalLink className="h-3 w-3" /></a> : <Mono>{data.tar?.address ?? "—"}</Mono>}
              </Field>
              <Field label="Versions anchored">{data.checkpoints.anchored} {data.checkpoints.pending > 0 && <Badge tone="warn">{data.checkpoints.pending} pending</Badge>}</Field>
              <Field label="Latest root"><Mono>{short(data.lastAnchored?.root, 24, 8)}</Mono></Field>
              <Field label="Latest tx">
                {data.lastAnchored?.explorer ? <a className="text-brand hover:underline" href={data.lastAnchored.explorer} target="_blank" rel="noreferrer"><Mono>{short(data.lastAnchored.tx_hash, 14, 8)}</Mono></a> : <Mono>{short(data.lastAnchored?.tx_hash, 14, 8)}</Mono>}
              </Field>
              <Field label="TAR profile (@context)">
                {data.profile?.explorer ? <a className="inline-flex items-center gap-1 text-brand hover:underline" href={data.profile.explorer} target="_blank" rel="noreferrer" title={data.profile.tarId}><Mono>VulaCheckpoint · {short(data.profile.address, 10, 6)}</Mono><ExternalLink className="h-3 w-3" /></a> : <Mono>{data.profile ? `VulaCheckpoint · ${short(data.profile.address, 10, 6)}` : "registered before the first checkpoint"}</Mono>}
              </Field>
              <Field label="Profile root schema"><Mono>{short(data.profile?.rootSchemaTarId, 24, 8)}</Mono></Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Two independent detection layers</CardTitle></CardHeader>
            <CardContent className="grid gap-4 text-sm md:grid-cols-2">
              <Layer n="1" title="Source vs log · vula reconcile" text="Events Vula captured that are now missing or changed in Supabase: evidence tampering in the source system." />
              <Layer n="2" title="Log vs chain · vula verify-log" text="Vula's own stored leaves no longer reproduce the roots anchored on-chain: the log itself was tampered with. The chain is the only trust anchor." />
            </CardContent>
          </Card>

          <AttackPanel />
        </div>
        <AlertsFeed />
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone, link }: { icon: ReactNode; label: string; value: string; sub: string; tone?: "ok" | "bad"; link?: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center gap-2 text-sm text-muted">{icon} {label}</div>
        <div className={`mt-1 text-3xl font-bold tracking-tight ${tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : ""}`}>{value}</div>
        <div className="mt-1 flex items-center gap-1 text-sm text-muted">
          {sub}
          {link && <a href={link} target="_blank" rel="noreferrer" className="text-brand" title="Block explorer"><ExternalLink className="h-3.5 w-3.5" /></a>}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 break-all">{children}</div>
    </div>
  );
}

function Layer({ n, title, text }: { n: string; title: string; text: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-4">
      <div className="flex items-center gap-2 font-semibold"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand/15 text-xs text-brand">{n}</span>{title}</div>
      <p className="mt-2 text-muted">{text}</p>
    </div>
  );
}
