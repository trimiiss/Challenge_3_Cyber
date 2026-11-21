"use client";
import { ArrowUp, ExternalLink, FileSearch, Loader2, ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/auth";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Mono } from "@/components/ui";
import { api } from "@/lib/client";
import { cn, short } from "@/lib/utils";

interface Step { level: number; sibling: string; side: "left" | "right"; parent: string }
interface Report {
  ok: boolean;
  status: string;
  message: string;
  tarId: string;
  chainId: number;
  index: number | null;
  event: { source: string; sourceId: string; action: string; target: string | null; actor: string | null; occurredAt: string; data: unknown } | null;
  leafHash: string | null;
  anchor: { version: number; seq: number; treeSize: number; rootHash: string; issuedAt: string } | null;
  firstSealedIn: { version: number; issuedAt: string } | null;
  steps: Step[];
  computedRoot: string | null;
  changes?: { path: string; before: unknown; after: unknown }[];
  anchorTx: { txHash: string; explorer: string | null } | null;
  pinned: boolean;
}

export default function VerifyPage() {
  const session = useSession();
  const [id, setId] = useState("");
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState<Report | null>(null);

  async function run(body: { id?: string; event?: unknown }) {
    setBusy(true);
    setError(null);
    setR(null);
    try {
      setR(await api<Report>(session, "/api/verify-event", { method: "POST", body: JSON.stringify(body) }));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("id");
    if (q) {
      setId(q);
      void run({ id: q });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitJson() {
    try {
      void run({ event: JSON.parse(json) });
    } catch (e) {
      setError(`not valid JSON: ${(e as Error).message}`);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileSearch className="h-4 w-4" /> Verify one event · inclusion proof against the chain</CardTitle>
          <span className="text-sm text-muted">vula verify-event · RFC 9162 §2.1.3</span>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (id.trim()) void run({ id }); }}>
            <label className="text-xs uppercase tracking-wider text-muted">Leaf index or source id</label>
            <div className="flex gap-2">
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="37  ·  app_audit:123  ·  auth:<uuid>"
                className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-sm outline-none focus:border-brand" />
              <Button type="submit" disabled={busy || !id.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Prove
              </Button>
            </div>
            <p className="text-xs text-muted">The proof is computed from the stored log (untrusted) and must hash up to the root read from the TAR on-chain.</p>
          </form>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-muted">…or paste a copy of an event you hold</label>
            <textarea value={json} onChange={(e) => setJson(e.target.value)} rows={3} placeholder='{"v":1,"source":"supabase.app_audit",…}'
              className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-xs outline-none focus:border-brand" />
            <Button variant="outline" onClick={submitJson} disabled={busy || !json.trim()}>Prove this exact event</Button>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-bad">{error}</p>}
      {r && <Result r={r} />}
    </div>
  );
}

function Result({ r }: { r: Report }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_520px]">
      <Card className={r.ok ? "border-ok/40" : "border-bad/50"}>
        <CardContent className="space-y-4 py-5">
          <div className="flex items-start gap-3">
            {r.ok ? <ShieldCheck className="h-9 w-9 shrink-0 text-ok" /> : <ShieldX className="h-9 w-9 shrink-0 text-bad" />}
            <div>
              <div className={cn("text-2xl font-bold", r.ok ? "text-ok" : "text-bad")}>
                {r.ok ? "Included in the anchored log" : r.status === "not_anchored" ? "Captured, not sealed yet" : "Proof FAILED"}
              </div>
              <p className="mt-1 text-sm text-muted">{r.message}</p>
            </div>
          </div>
          {(r.changes ?? []).length > 0 && (
            <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 font-mono text-xs">
              {r.changes!.map((c, i) => (
                <div key={i}>{c.path}: <span className="text-ok">{JSON.stringify(c.before)}</span> → <span className="text-bad">{JSON.stringify(c.after)}</span></div>
              ))}
            </div>
          )}
          {r.event && (
            <dl className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2">
              <Field label="Leaf">#{r.index}  <Badge tone="info">{r.event.source}</Badge></Field>
              <Field label="Action">{r.event.action} <Mono className="text-muted">{r.event.target}</Mono></Field>
              <Field label="Occurred">{r.event.occurredAt}</Field>
              <Field label="Actor"><Mono>{r.event.actor ?? "—"}</Mono></Field>
              <Field label="Leaf hash = SHA-256(0x00 ‖ JCS(event))"><Mono>{r.leafHash}</Mono></Field>
              <Field label="Sealed since">{r.firstSealedIn ? `TAR version ${r.firstSealedIn.version} · ${r.firstSealedIn.issuedAt}` : "not yet"}</Field>
            </dl>
          )}
          {r.anchor && (
            <div className="rounded-lg border border-line bg-panel-2 p-4 text-sm">
              <div className="text-xs uppercase tracking-wider text-muted">Trust anchor · read from the chain</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <Field label="TAR">{r.tarId}{!r.pinned && <Badge tone="warn" className="ml-2">id not pinned</Badge>}</Field>
                <Field label="Checkpoint">TAR version {r.anchor.version} · {r.anchor.treeSize} events</Field>
                <Field label="Anchored root"><Mono>{r.anchor.rootHash}</Mono></Field>
                <Field label="Transaction">
                  {r.anchorTx?.explorer
                    ? <a href={r.anchorTx.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline"><Mono>{short(r.anchorTx.txHash, 14, 8)}</Mono><ExternalLink className="h-3 w-3" /></a>
                    : <Mono>{short(r.anchorTx?.txHash, 14, 8)}</Mono>}
                </Field>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      {r.leafHash && r.anchor && r.status !== "not_anchored" && r.status !== "mismatch" && <ProofPath r={r} />}
    </div>
  );
}

/** Leaf at the bottom, root at the top: each level hashes the current node with one sibling from the proof. */
function ProofPath({ r }: { r: Report }) {
  const levels = [...r.steps].reverse();
  const match = r.computedRoot === r.anchor?.rootHash;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Proof path · {r.steps.length} hashes</CardTitle>
        <span className="text-xs text-muted">node = SHA-256(0x01 ‖ left ‖ right)</span>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <div className={cn("rounded-lg border-2 px-3 py-2 text-center", match ? "border-ok bg-ok/10" : "border-bad bg-bad/10")}>
          <div className="text-xs font-semibold uppercase tracking-wider">{match ? "root = anchored on-chain ✅" : "root ≠ anchored on-chain ❌"}</div>
          <Mono className="text-xs">{short(r.computedRoot, 24, 12)}</Mono>
          {!match && <div className="mt-1 text-xs text-muted">chain: <Mono>{short(r.anchor?.rootHash, 24, 12)}</Mono></div>}
        </div>
        {levels.map((s) => (
          <div key={s.level}>
            <div className="flex justify-center text-muted"><ArrowUp className="h-4 w-4" /></div>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
              <Node label={s.side === "left" ? "sibling" : `level ${s.level - 1}`} hash={s.side === "left" ? s.sibling : (r.steps[s.level - 2]?.parent ?? r.leafHash!)} sib={s.side === "left"} />
              <span className="text-muted">+</span>
              <Node label={s.side === "right" ? "sibling" : `level ${s.level - 1}`} hash={s.side === "right" ? s.sibling : (r.steps[s.level - 2]?.parent ?? r.leafHash!)} sib={s.side === "right"} />
            </div>
          </div>
        ))}
        <div className="flex justify-center text-muted"><ArrowUp className="h-4 w-4" /></div>
        <div className="rounded-lg border border-brand/60 bg-brand/10 px-3 py-2 text-center text-xs">
          <div className="font-semibold uppercase tracking-wider text-brand">leaf #{r.index}</div>
          <Mono>{short(r.leafHash, 24, 12)}</Mono>
        </div>
      </CardContent>
    </Card>
  );
}

function Node({ label, hash, sib }: { label: string; hash: string; sib: boolean }) {
  return (
    <div className={cn("rounded-md border px-2 py-1.5", sib ? "border-line bg-panel-2" : "border-brand/50 bg-brand/5")}>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <Mono>{short(hash, 10, 6)}</Mono>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 break-all">{children}</dd>
    </div>
  );
}
