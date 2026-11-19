import { z } from "zod";
import { hashLeaf, type Hash } from "@vula/merkle";
import { jcs, jcsSha256 } from "./jcs";

/** CLAUDE.md §7.1. One event = one Merkle leaf. */
export const EVENT_SOURCES = ["supabase.auth", "supabase.app_audit", "vula.heartbeat", "ci.release"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s), "ISO-8601 date");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex chars");

export const eventSchema = z
  .object({
    v: z.literal(1),
    source: z.enum(EVENT_SOURCES),
    sourceId: z.string().min(1),
    /** Per-source sequence number assigned by the collector (gaps are visible). */
    seq: z.number().int().nonnegative(),
    occurredAt: isoDate,
    capturedAt: isoDate,
    actor: z.string().nullable(),
    action: z.string().min(1),
    target: z.string().nullable(),
    data: z.unknown(),
    dataSha256: hex64,
  })
  .strict()
  .refine((e) => e.data !== undefined, { message: "data is required", path: ["data"] })
  .refine((e) => e.data === undefined || jcsSha256(e.data) === e.dataSha256, {
    message: "dataSha256 does not match JCS(data)",
    path: ["dataSha256"],
  });

export type VulaEvent = z.infer<typeof eventSchema>;
export type EventInput = Omit<VulaEvent, "v" | "dataSha256">;

/** Builds a v1 event and fills in dataSha256 = SHA-256(JCS(data)). */
export function makeEvent(input: EventInput): VulaEvent {
  // Normalise data through JSON so what we hash is exactly what gets stored and re-read.
  const data = JSON.parse(jcs(input.data ?? null));
  return { v: 1, ...input, data, dataSha256: jcsSha256(data) };
}

/** Validates an untrusted event (throws a readable error). */
export function parseEvent(x: unknown): VulaEvent {
  const r = eventSchema.safeParse(x);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`invalid event: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return r.data;
}

/** Leaf bytes = UTF-8 of JCS(event). */
export function leafBytes(event: VulaEvent): Uint8Array {
  return new TextEncoder().encode(jcs(event));
}

/** Leaf hash = SHA-256(0x00 || JCS(event)), RFC 9162 §2.1.1. */
export function eventLeafHash(event: VulaEvent): Hash {
  return hashLeaf(leafBytes(event));
}
