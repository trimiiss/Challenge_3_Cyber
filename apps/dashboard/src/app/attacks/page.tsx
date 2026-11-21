"use client";
import { AlertTriangle, Loader2, ShieldAlert, Skull } from "lucide-react";
import { useEffect, useState } from "react";
import { FindingList, type AttackInfo, type AttackResult } from "@/components/attack-panel";
import { useSession } from "@/components/auth";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { api, DEMO_MODE } from "@/lib/client";
import { cn } from "@/lib/utils";

const LAYER: Record<string, string> = {
  "vula reconcile": "Layer 1 · source vs log",
  "vula verify-log": "Layer 2 · log vs chain",
  "log-server watchdog": "Heartbeat watchdog",
};

/** Every scripted insider attack (CLAUDE.md §7.6): run it against the demo DB, then the matching verifier. */
export default function AttackLabPage() {
  const session = useSession();
  const [attacks, setAttacks] = useState<AttackInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AttackResult | { error: string }>>({});
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) api<AttackInfo[]>(session, "/api/attack").then(setAttacks).catch(() => setAttacks([]));
  }, [session]);

  async function run(a: AttackInfo) {
    if (a.destructive && confirm !== a.id) return setConfirm(a.id);
    setConfirm(null);
    setBusy(a.id);
    try {
      const r = await api<AttackResult>(session, "/api/attack", { method: "POST", body: JSON.stringify({ id: a.id }) });
      setResults((x) => ({ ...x, [a.id]: r }));
    } catch (e) {
      setResults((x) => ({ ...x, [a.id]: { error: (e as Error).message } }));
    }
    setBusy(null);
  }

  if (!DEMO_MODE) return <p className="text-muted">The attack lab is only available in demo mode (NEXT_PUBLIC_DEMO_MODE=1).</p>;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm text-muted">
          <Skull className="h-5 w-5 text-bad" />
          <span>
            The attacker is <b className="text-ink">uibm_admin</b>, a DBA with full rights on the app, audit and Vula tables (what the postgres
            password gives). Each button runs the real attack against the demo database, then the verifier that must catch it; findings
            also arrive as live alerts. Reset afterwards with <code className="text-ink">pnpm demo:reset</code>.
          </span>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {attacks.map((a) => {
          const r = results[a.id];
          return (
            <Card key={a.id} className={cn(r && "ok" in r && r.ok === false && "border-bad/50")}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 normal-case tracking-normal text-ink">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-bad/15 text-xs text-bad">{a.id}</span>
                  {a.title}
                </CardTitle>
                <div className="flex gap-1.5">
                  <Badge tone="info">{LAYER[a.detectedBy] ?? a.detectedBy}</Badge>
                  {a.destructive && <Badge tone="warn">forks the demo TAR</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted">{a.story}</p>
                {a.requires && <p className="flex gap-1.5 text-xs text-warn"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> needs: {a.requires}</p>}
                <pre className="whitespace-pre-wrap rounded-md bg-panel-2 px-3 py-2 font-mono text-xs text-muted">expected ({a.detectedBy}):{"\n"}{a.expected}</pre>
                <Button variant="danger" onClick={() => run(a)} disabled={!!busy}>
                  {busy === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                  {confirm === a.id ? "Click again: this writes a forged version to the chain" : `Run attack ${a.id}`}
                </Button>
                {r && "error" in r && <p className="text-bad">{r.error}</p>}
                {r && "done" in r && (
                  <div className="space-y-2 rounded-lg border border-line bg-panel-2 p-3">
                    <div className="text-muted"><span className="font-semibold text-ink">☠ done:</span> {r.done}</div>
                    {r.note && <div className="text-warn">⏳ {r.note}</div>}
                    {r.ok !== undefined && (
                      <div className={r.ok ? "text-ok" : "text-lg font-semibold text-bad"}>
                        {r.ok ? "✅ nothing detected (unexpected!)" : `❌ ${r.detection} detected it`}
                        {r.firstBroken && <span className="ml-2 text-sm font-normal text-muted">first broken: TAR version {r.firstBroken.version}</span>}
                      </div>
                    )}
                    <FindingList findings={r.findings ?? []} max={5} />
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
