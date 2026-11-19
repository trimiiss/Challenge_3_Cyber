"use client";
import type { Session } from "@supabase/supabase-js";
import { ShieldCheck } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/client";
import { Button, Card, CardContent } from "./ui";

const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

/** Everything behind Supabase Auth: the API routes additionally require the auditor role. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <div className="p-10 text-muted">Loading…</div>;
  if (!session) return <Login />;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

function Login() {
  const [email, setEmail] = useState(process.env.NEXT_PUBLIC_AUDITOR_EMAIL ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <div className="mx-auto mt-24 max-w-md px-4">
      <div className="mb-6 flex items-center gap-3">
        <ShieldCheck className="h-9 w-9 text-brand" />
        <div>
          <div className="text-2xl font-bold tracking-tight">Vula</div>
          <div className="text-sm text-muted">Tamper-evident audit trail · auditor sign-in</div>
        </div>
      </div>
      <Card>
        <CardContent className="py-6">
          <form onSubmit={submit} className="space-y-4">
            <label className="block text-sm">
              <span className="text-muted">Email</span>
              <input className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 outline-none focus:border-brand" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </label>
            <label className="block text-sm">
              <span className="text-muted">Password</span>
              <input className="mt-1 w-full rounded-lg border border-line bg-panel-2 px-3 py-2 outline-none focus:border-brand" value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
            </label>
            {error && <p className="text-sm text-bad">{error}</p>}
            <Button className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in with Supabase Auth"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
