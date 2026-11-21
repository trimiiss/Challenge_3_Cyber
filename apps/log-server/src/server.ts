import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { toHex } from "@vula/merkle";
import { parseEvent } from "@vula/core";
import { explorerAddressUrl, explorerTxUrl, parseTarId } from "@vula/compellio";
import type { LogService } from "./log";
import type { Anchorer } from "./anchor";
import type { CheckpointRow } from "./store";

const ingestBody = z.object({ events: z.array(z.unknown()).min(1).max(1000) }).strict();
const inclusionQuery = z.object({ index: z.coerce.number().int().nonnegative(), size: z.coerce.number().int().positive().optional() });
const consistencyQuery = z.object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive().optional() });

export function buildServer(deps: {
  log: LogService;
  anchorer: Anchorer;
  ingestToken: string;
  logId: string;
  watchdog: () => { gapOpen: boolean; lastHeartbeatAt: string | null };
  loadCheckpoints: () => Promise<CheckpointRow[]>;
}): FastifyInstance {
  const { log, anchorer } = deps;
  const app = Fastify({ logger: { level: "warn" }, bodyLimit: 5 * 1024 * 1024 });

  app.get("/health", async () => ({ ok: true }));

  // ------------------------------------------------------------- ingest
  app.post("/v1/events", async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${deps.ingestToken}`) return reply.code(401).send({ error: "unauthorized" });
    const body = ingestBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    let events;
    try {
      events = body.data.events.map((e) => parseEvent(e));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const indexes = await log.append(events);
    return { indexes, treeSize: log.size };
  });

  // -------------------------------------------------------------- proofs
  app.get("/v1/tree", async () => ({ logId: deps.logId, size: log.size, root: toHex(log.tree.root()) }));

  app.get("/v1/proof/inclusion", async (req, reply) => {
    const q = inclusionQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message });
    const size = q.data.size ?? log.size;
    if (size > log.size || q.data.index >= size) return reply.code(404).send({ error: "index/size out of range" });
    return {
      index: q.data.index,
      size,
      leafHash: toHex(log.tree.leafHash(q.data.index)),
      proof: log.tree.inclusionProof(q.data.index, size).map(toHex),
      root: toHex(log.tree.root(size)),
      event: log.events[q.data.index],
    };
  });

  app.get("/v1/proof/consistency", async (req, reply) => {
    const q = consistencyQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message });
    const to = q.data.to ?? log.size;
    if (to > log.size || q.data.from > to) return reply.code(404).send({ error: "sizes out of range" });
    return {
      from: q.data.from,
      to,
      proof: log.tree.consistencyProof(q.data.from, to).map(toHex),
      fromRoot: toHex(log.tree.root(q.data.from)),
      toRoot: toHex(log.tree.root(to)),
    };
  });

  // -------------------------------------------------------------- status
  app.get("/v1/status", async () => {
    const last = anchorer.lastAnchored;
    const tar = anchorer.tar;
    return {
      logId: deps.logId,
      treeSize: log.size,
      root: toHex(log.tree.root()),
      tar: tar && {
        ...tar,
        explorer: explorerAddressUrl(tar.chainId, parseTarId(tar.tarId).address),
      },
      lastAnchored: last && {
        seq: last.seq,
        treeSize: last.tree_size,
        tarVersion: last.tar_version,
        txHash: last.tx_hash,
        anchoredAt: last.anchored_at,
        explorer: tar && last.tx_hash ? explorerTxUrl(tar.chainId, last.tx_hash) : null,
      },
      unanchoredLeaves: log.size - (last?.tree_size ?? 0),
      pending: anchorer.pending && { seq: anchorer.pending.seq, attempts: anchorer.pending.attempts, error: anchorer.pending.last_error },
      halted: anchorer.halted,
      heartbeat: deps.watchdog(),
    };
  });

  // ------------------------------------------- TAR payload resolution
  // The TAR contract's dataUri(v) = {DCAP__UriPrefix}0x{address} for every version, so this one URL serves
  // all anchored payloads, straight from the checkpoint store (vula.checkpoints). Whoever controls that table
  // controls what is served here: verifiers treat it as untrusted and re-hash every payload against the chain.
  app.get<{ Params: { address: string } }>("/tar/:address", async (req, reply) => {
    const tar = anchorer.tar;
    if (!tar || parseTarId(tar.tarId).address !== req.params.address.toLowerCase()) {
      return reply.code(404).send({ error: "unknown TAR" });
    }
    const rows = await deps.loadCheckpoints();
    return {
      tarId: tar.tarId,
      versions: rows.filter((c) => c.status === "anchored").map((c) => ({ version: c.tar_version, payload: c.payload })),
    };
  });

  return app;
}
