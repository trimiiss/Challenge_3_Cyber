"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, supabase } from "@/lib/client";
import { useSession } from "./auth";

/** Fetches an API route and re-fetches on Realtime changes of the given vula tables (+ a slow poll fallback). */
export function useLive<T>(path: string, tables: string[], pollMs = 15_000) {
  const session = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<T>(session, path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session, path]);

  useEffect(() => {
    void load();
    const sb = supabase();
    const channel = sb.channel(`live:${path}`);
    for (const table of tables) {
      channel.on("postgres_changes", { event: "*", schema: "vula", table }, () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 300);
      });
    }
    channel.subscribe();
    const poll = setInterval(() => void load(), pollMs);
    return () => {
      clearInterval(poll);
      void sb.removeChannel(channel);
    };
  }, [load, path, pollMs, tables.join(",")]);

  return { data, error, reload: load };
}

export interface AlertRow {
  id: number;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  details: Record<string, unknown>;
  created_at: string;
}
