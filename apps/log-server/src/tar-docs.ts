import { ASSET_SCHEMA_ROOT } from "@vula/core";
import { parseTarId } from "@vula/compellio";
import type { ProfileConfig, TarConfig } from "./anchor";
import type { CheckpointRow } from "./store";

/** What `dataUri(v)` resolves to: every version of one TAR at one URL (DCAP.Web's dataUri ignores the version). */
export interface TarDocument {
  tarId: string;
  versions: { version: number | null; payload: unknown }[];
}

export interface TarDocSources {
  tar: TarConfig | null;
  profile: ProfileConfig | null;
  loadCheckpoints: () => Promise<CheckpointRow[]>;
}

/**
 * The one source of truth for `GET /tar/0x{address}` AND the public Storage mirror `vula-tar/0x{address}`, so both
 * always serve the same JSON. Payloads come from the checkpoint store (vula.checkpoints) and the profile config:
 * whoever controls those controls what is served. Verifiers treat it as untrusted and re-hash it against the chain.
 */
export async function tarDocument(address: string, src: TarDocSources): Promise<TarDocument | null> {
  const a = address.toLowerCase();
  const { profile, tar } = src;
  // The TAR profile and its root asset schema (DCAP.Web gives every TAR it registers the same dataUri prefix).
  if (profile && parseTarId(profile.tarId).address === a) {
    return { tarId: profile.tarId, versions: [{ version: 0, payload: profile.payload }] };
  }
  if (profile && parseTarId(profile.rootSchemaTarId).address === a) {
    return { tarId: profile.rootSchemaTarId, versions: [{ version: 0, payload: ASSET_SCHEMA_ROOT }] };
  }
  if (!tar || parseTarId(tar.tarId).address !== a) return null;
  const rows = await src.loadCheckpoints();
  return {
    tarId: tar.tarId,
    versions: rows.filter((c) => c.status === "anchored").map((c) => ({ version: c.tar_version, payload: c.payload })),
  };
}

/** Exactly the bytes Fastify sends for a returned object (JSON.stringify), so the mirror is byte-identical. */
export function tarDocumentBody(doc: TarDocument): string {
  return JSON.stringify(doc);
}
