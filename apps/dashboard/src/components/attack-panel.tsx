"use client";
import { Loader2, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
import { useEffect, useState } from "react";
import { api, DEMO_MODE } from "@/lib/client";
import { useSession } from "./auth";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, severityTone } from "./ui";

export interface AttackInfo { id: string; title: string; story: string; detectedBy: string; expected: string; destructive?: boolean; requires?: string | null }
export interface Finding { code: string; severity: string; message: string; layer: string; details?: { changes?: { path: string; before: unknown; after: unknown }[] } }
export interface AttackResult { attack: { id: string; title: string }; done: string; detection: string; ok?: boolean; note?: string; findings?: Finding[]; firstBroken?: { version: number; reason: string } | null }
interface VerifyResult { verifyLog: { ok: boolean; totalVersions: number; anchoredTreeSize: number; findings: Finding[] }; reconcile: { ok: boolean; capturedEvents: number; findings: Finding[] } }

/** Demo mode only: one click = run the insider attack against the demo DB, then the verifier. */
export function AttackPanel() {
  const session = useSession();
  const [attacks, setAttacks] = useState<AttackInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<AttackResult | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) api<AttackInfo[]>(session, "/api/attack").then(setAttacks).catch(() => setAttacks([]));
  }, [session]);

  async function run(id: string) {
    setBusy(id);
    setError(null);
    setVerify(null);
    try {
      setResult(await api<AttackResult>(session, "/api/attack", { method: "POST", body: JSON.stringify({ id }) }));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  async function verifyNow() {
    setBusy("verify");
    setError(null);
    setResult(null);
    try {
      setVerify(await api<VerifyResult>(session, "/api/verify", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Skull className="h-4 w-4" /> Insider attack lab {DEMO_MODE && <Badge tone="warn">demo mode</Badge>}
        </CardTitle>
        <Button variant="outline" onClick={verifyNow} disabled={!!busy}>
          {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Run verifier now
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {DEMO_MODE && (
          <div className="flex flex-wrap gap-2">
            {attacks.filter((a) => ["1", "2", "4", "5", "8"].includes(a.id)).map((a) => (
              <Button key={a.id} variant="danger" onClick={() => run(a.id)} disabled={!!busy} title={a.story}>
                {busy === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                {a.id}. {a.title}
              </Button>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-bad">{error}</p>}
        {result && (
          <div className="space-y-3 rounded-lg border border-line bg-panel-2 p-4">
            <div className="text-sm text-muted">
              <span className="font-semibold text-ink">☠ {result.attack.title}:</span> {result.done}
            </div>
            {result.note && <div className="text-sm text-warn">⏳ {result.note}</div>}
            {result.ok !== undefined && (
              <div className={result.ok ? "text-ok" : "text-lg font-semibold text-bad"}>
                {result.ok ? "✅ nothing detected (unexpected!)" : `❌ ${result.detection} detected the tampering`}
                {result.firstBroken && <span className="ml-2 text-sm font-normal text-muted">first broken checkpoint: TAR version {result.firstBroken.version}</span>}
              </div>
            )}
            <FindingList findings={result.findings ?? []} />
          </div>
        )}
        {verify && (
          <div className="grid gap-3 md:grid-cols-2">
            <Verdict title="verify-log · log vs chain" ok={verify.verifyLog.ok} sub={`${verify.verifyLog.totalVersions} anchored checkpoints · ${verify.verifyLog.anchoredTreeSize} events`} findings={verify.verifyLog.findings} />
            <Verdict title="reconcile · source vs log" ok={verify.reconcile.ok} sub={`${verify.reconcile.capturedEvents} captured events`} findings={verify.reconcile.findings} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Verdict({ title, ok, sub, findings }: { title: string; ok: boolean; sub: string; findings: Finding[] }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 p-4">
      <div className="text-xs uppercase tracking-wider text-muted">{title}</div>
      <div className={ok ? "mt-1 text-2xl font-bold text-ok" : "mt-1 text-2xl font-bold text-bad"}>{ok ? "✅ verified" : "❌ tampering"}</div>
      <div className="text-sm text-muted">{sub}</div>
      <FindingList findings={findings.filter((f) => f.severity !== "info")} max={5} />
    </div>
  );
}

export function FindingList({ findings, max = 8 }: { findings: Finding[]; max?: number }) {
  if (findings.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {findings.slice(0, max).map((f, i) => (
        <li key={i} className="text-sm">
          <Badge tone={severityTone(f.severity)} className="mr-2">{f.code}</Badge>
          {f.message}
          {(f.details?.changes ?? []).slice(0, 3).map((c, j) => (
            <div key={j} className="ml-6 font-mono text-xs text-muted">
              {c.path}: <span className="text-ok">{JSON.stringify(c.before)}</span> → <span className="text-bad">{JSON.stringify(c.after)}</span>
            </div>
          ))}
        </li>
      ))}
      {findings.length > max && <li className="text-xs text-muted">+{findings.length - max} more</li>}
    </ul>
  );
}
