/**
 * Insider attacks for the demo (CLAUDE.md §7.6). The attacker is `uibm_admin`: a DBA with full rights on the app,
 * audit and Vula tables, i.e. what someone holding the postgres password can do to these tables.
 * Each attack returns a description of what it did; the README lists the expected verifier output.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  checkpointChecksum,
  eventLeafHash,
  heartbeatEvent,
  makeEvent,
  signCheckpoint,
  signerFromPkcs8,
  type CheckpointPayload,
  type VulaEvent,
} from "@vula/core";
import { connect, loadEnv, requireEnv, type Sql } from "@vula/db";
import { MerkleTree, fromHex, toHex } from "@vula/merkle";
import { createRegistryClient, createTarReader, registryConfigFromEnv } from "@vula/compellio";

loadEnv();

export interface Attack {
  id: string;
  title: string;
  story: string;
  detectedBy: "vula reconcile" | "vula verify-log" | "log-server watchdog";
  expected: string;
  /** true = the attack writes to the chain and leaves the demo TAR permanently forked: `pnpm demo:reset` after it */
  destructive?: boolean;
  /** what the attacker needs besides the DB (shown in the attack lab) */
  requires?: string;
  run(sql: Sql): Promise<string>;
}

let insider: Sql | null = null;
export function insiderDb(): Sql {
  insider ??= connect("uibm_admin", { max: 2 });
  return insider;
}
export async function closeInsiderDb(): Promise<void> {
  await insider?.end({ timeout: 5 });
  insider = null;
}

interface GradeTarget { id: string; grade: number; student: string; course: string }

/** The victim grade: Driton Shala's CS205 grade if entered in the demo, otherwise his CS101 grade (seed: 6). */
async function targetGrade(sql: Sql): Promise<GradeTarget> {
  const rows = await sql<GradeTarget[]>`
    select g.id::text, g.grade, s.full_name as student, c.code as course
    from app.grades g join app.students s on s.id = g.student_id join app.courses c on c.id = g.course_id
    where s.student_no = 'UIBM-2026-004'
    order by (c.code = 'CS205') desc, c.code limit 1`;
  if (!rows[0]) throw new Error("no grade for Driton Shala (UIBM-2026-004) yet");
  return rows[0];
}

/** Highest audit id the collector has already shipped to Vula (so the tampering is of captured evidence). */
async function capturedAuditCursor(sql: Sql): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    select coalesce((cursor ->> 'lastId')::bigint, 0) as id from vula.collector_state where source = 'supabase.app_audit'`;
  return Number(rows[0]?.id ?? 0);
}

/** The latest anchored grade event in vula.leaves (the evidence the insider wants to change). */
async function anchoredGradeLeaf(sql: Sql): Promise<{ index: number; event: VulaEvent }> {
  const rows = await sql<{ index: number; event: VulaEvent }[]>`
    select index, event from vula.leaves
    where event ->> 'action' in ('grade.create', 'grade.update')
      and index < (select coalesce(max(tree_size), 0) from vula.checkpoints where status = 'anchored')
    order by index desc limit 1`;
  if (!rows[0]) throw new Error("no anchored grade event in vula.leaves yet");
  return rows[0];
}

/** Same event with the grade set to 10 (9 if it already is 10), dataSha256 recomputed so it looks genuine. */
function forgeGrade(event: VulaEvent): { forged: VulaEvent; before: number; after: number } {
  const data = structuredClone(event.data) as { new: { grade: number } };
  const before = data.new.grade;
  data.new.grade = before === 10 ? 9 : 10;
  const { v: _v, dataSha256: _d, ...rest } = event;
  return { forged: makeEvent({ ...rest, data }), before, after: data.new.grade };
}

/** Leaf hashes recomputed from the stored events (as the insider sees the log). */
async function allLeafHashes(sql: Sql): Promise<Uint8Array[]> {
  const rows = await sql<{ index: number; event: VulaEvent }[]>`select index, event from vula.leaves order by index`;
  return rows.map((r) => eventLeafHash(r.event));
}

export const ATTACKS: Attack[] = [
  {
    id: "1",
    title: "Delete an audit record",
    story: "The insider deletes the audit record of the latest grade change from app_audit.events.",
    detectedBy: "vula reconcile",
    expected: "❌ [deleted_audit_row] Audit record #N (… grade …) was DELETED from app_audit.events",
    async run(sql) {
      const cursor = await capturedAuditCursor(sql);
      const rows = await sql<{ id: number; op: string }[]>`
        delete from app_audit.events
        where id = (select max(id) from app_audit.events where table_name = 'app.grades' and id <= ${cursor})
        returning id, op`;
      if (!rows[0]) throw new Error("no captured grade audit record to delete yet");
      return `deleted app_audit.events #${rows[0].id} (${rows[0].op} on app.grades)`;
    },
  },
  {
    id: "2",
    title: "Change a grade and rewrite its audit record",
    story:
      "The insider raises Driton Shala's grade to 10, deletes the audit row the trigger just wrote (same transaction, " +
      "so no collector ever sees it) and edits the earlier audit record so it already shows 10.",
    detectedBy: "vula reconcile",
    expected:
      "❌ [modified_audit_row] Audit record #N (…) was MODIFIED after capture\n" +
      "❌ [unexplained_change] grade of Driton Shala in CS205 is 10 but the last audited value is 6",
    async run(sql) {
      const t = await targetGrade(sql);
      const newGrade = t.grade === 10 ? 9 : 10;
      const cursor = await capturedAuditCursor(sql);
      let edited = 0;
      await sql.begin(async (tx) => {
        await tx`update app.grades set grade = ${newGrade}, updated_at = now() where id = ${t.id}`;
        await tx`delete from app_audit.events where txid = txid_current()`;
        const r = await tx`
          update app_audit.events
          set new_row = jsonb_set(new_row, '{grade}', to_jsonb(${newGrade}::int))
          where id = (select max(id) from app_audit.events where row_pk = ${t.id} and id <= ${cursor} and new_row is not null)
          returning id`;
        edited = r.count;
      });
      return `set ${t.student}'s ${t.course} grade ${t.grade} -> ${newGrade}, removed the trigger's audit row, rewrote ${edited} earlier audit record(s)`;
    },
  },
  {
    id: "3",
    title: "Delete Supabase Auth audit log entries",
    story:
      "The insider deletes the newest captured rows of auth.audit_log_entries (Supabase's own login / token audit " +
      "log) to hide when and from where they signed in.",
    detectedBy: "vula reconcile",
    requires: "Supabase Auth must write its audit log to the database (Auth settings) so there are entries to capture",
    expected: "❌ [deleted_auth_entry] Auth audit entry <uuid> (login …) was DELETED from auth.audit_log_entries",
    async run(sql) {
      const rows = await sql<{ id: string; action: string }[]>`
        select event ->> 'sourceId' as id, event ->> 'action' as action from vula.leaves
        where event ->> 'source' = 'supabase.auth' order by index desc limit 2`;
      if (rows.length === 0) {
        throw new Error(
          "no captured auth audit entries: enable writing Auth audit logs to the database in the Supabase dashboard, sign in once, wait for the collector",
        );
      }
      // auth.* belongs to supabase_auth_admin; only the postgres superuser can delete there. The demo models the
      // insider's postgres access with one SECURITY DEFINER function (supabase/migrations/*_vula_demo_attacks.sql).
      const ids = rows.map((r) => r.id);
      const deleted = await sql<{ id: string }[]>`select id::text from vula_demo.insider_delete_auth_entries(${ids}::uuid[]) as id`;
      return `deleted ${deleted.length} auth.audit_log_entries row(s): ${rows.map((r) => `${r.action} ${r.id.slice(0, 8)}…`).join(", ")}`;
    },
  },
  {
    id: "4",
    title: "Edit a leaf in Vula's own log",
    story:
      "The insider also edits Vula's stored copy (vula.leaves) of the grade event so it shows 10, and recomputes " +
      "dataSha256 and leaf_hash so the row looks self-consistent.",
    detectedBy: "vula verify-log",
    expected:
      "❌ [root_mismatch] Stored leaves no longer reproduce the root anchored in TAR version V …\n" +
      "❌ [leaf_altered] Leaf I was ALTERED: grade.update app.grades:… (grade 6 -> …)\n" +
      "        data.new.grade: 6 → 10",
    async run(sql) {
      const row = await anchoredGradeLeaf(sql);
      const { forged, before, after } = forgeGrade(row.event);
      await sql`
        update vula.leaves set event = ${sql.json(forged as never)}, leaf_hash = ${Buffer.from(eventLeafHash(forged))}
        where index = ${row.index}`;
      return `rewrote leaf ${row.index} (${row.event.action} ${row.event.target}): grade ${before} -> ${after}, leaf_hash -> ${toHex(eventLeafHash(forged)).slice(0, 16)}…`;
    },
  },
  {
    id: "5",
    title: "Truncate the log (delete the newest leaves)",
    story: "The insider deletes the newest 5 anchored leaves from vula.leaves to make recent events disappear.",
    detectedBy: "vula verify-log",
    expected: "❌ [log_truncated] Log truncated: vula.leaves has N leaves but TAR version V anchored M\n❌ [leaf_deleted] Leaf … was DELETED from the log",
    async run(sql) {
      const rows = await sql<{ size: number }[]>`
        select coalesce(max(tree_size), 0)::int as size from vula.checkpoints where status = 'anchored'`;
      const size = rows[0]?.size ?? 0;
      if (size < 6) throw new Error("need at least 6 anchored leaves");
      const r = await sql`delete from vula.leaves where index >= ${size - 5}`;
      return `deleted ${r.count} leaves (index >= ${size - 5}) from vula.leaves`;
    },
  },
  {
    id: "6",
    title: "Rewrite the checkpoint store to match a forged log",
    story:
      "The insider edits the grade event in vula.leaves AND rewrites every row of vula.checkpoints that covers it " +
      "(new Merkle roots, new consistency proofs, new checksums), so Vula's database is perfectly self-consistent " +
      "again. Without the signing key they cannot re-sign, and nothing inside the database checks signatures.",
    detectedBy: "vula verify-log",
    expected:
      "❌ [payload_mismatch] Checkpoint store tampered: payload for TAR version V … does not match the checksum anchored on-chain\n" +
      "RESULT ❌ first broken checkpoint: TAR version V (the chain wins: earlier versions stay ✅)",
    async run(sql) {
      const row = await anchoredGradeLeaf(sql);
      const { forged, before, after } = forgeGrade(row.event);
      const cps = await sql<{ seq: number; tree_size: number; payload: CheckpointPayload }[]>`
        select seq, tree_size, payload from vula.checkpoints where status = 'anchored' order by seq`;
      const hashes = await allLeafHashes(sql);
      hashes[row.index] = eventLeafHash(forged);
      const tree = new MerkleTree(hashes);
      const rewrites: { seq: number; payload: CheckpointPayload }[] = [];
      let prevRoot: string | null = null;
      for (const c of cps) {
        if (c.tree_size <= row.index) {
          prevRoot = c.payload.rootHash;
          continue;
        }
        // A checkpoint larger than the stored log (e.g. the foreign one from attack 7, whose extra leaves were never
        // stored) cannot be recomputed from vula.leaves: stop there.
        if (c.tree_size > tree.size) break;
        const p: CheckpointPayload = {
          ...c.payload,
          rootHash: toHex(tree.root(c.tree_size)),
          prevRootHash: prevRoot ?? c.payload.prevRootHash,
          consistencyProof: c.payload.prevTreeSize > 0 ? tree.consistencyProof(c.payload.prevTreeSize, c.tree_size).map(toHex) : [],
        };
        prevRoot = p.rootHash;
        rewrites.push({ seq: c.seq, payload: p });
      }
      await sql.begin(async (tx) => {
        await tx`
          update vula.leaves set event = ${tx.json(forged as never)}, leaf_hash = ${Buffer.from(eventLeafHash(forged))}
          where index = ${row.index}`;
        for (const r of rewrites) {
          await tx`
            update vula.checkpoints
            set payload = ${tx.json(r.payload as never)}, root_hash = ${Buffer.from(fromHex(r.payload.rootHash))},
                checksum = ${Buffer.from(checkpointChecksum(r.payload), "hex")}
            where seq = ${r.seq}`;
        }
      });
      return `rewrote leaf ${row.index} (grade ${before} -> ${after}) and ${rewrites.length} checkpoint row(s) from seq ${rewrites[0]?.seq} on: roots, consistency proofs and checksums recomputed`;
    },
  },
  {
    id: "7",
    title: "Stolen signing key: anchor a forged checkpoint",
    story:
      "An attacker who stole the checkpoint signing key and the registry credentials rebuilds the log WITHOUT the " +
      "grade event, signs a checkpoint that chains from the real last one, anchors it as the next TAR version " +
      "through the Compellio Registry API and makes Vula's checkpoint store serve it.",
    detectedBy: "vula verify-log",
    destructive: true,
    requires: "VULA_SIGNING_KEY + Registry API access; it writes to the chain, so run `pnpm demo:reset` afterwards",
    expected:
      "❌ [inconsistent] TAR version V is NOT an append-only extension of version V-1: history was rewritten or entries dropped\n" +
      "   (every earlier TAR version stays ✅; the log server also halts with foreign_tar_version)",
    async run(sql) {
      const [tar] = await sql<{ value: { tarId: string } }[]>`select value from vula.config where key = 'tar'`;
      if (!tar) throw new Error("no TAR yet");
      const reader = createTarReader({ rpcUrl: process.env.CHAIN_RPC_URL || "http://localhost:8545", tarId: tar.value.tarId });
      const total = await reader.totalVersions();
      const [prev] = await sql<{ payload: CheckpointPayload }[]>`
        select payload from vula.checkpoints where status = 'anchored' and tar_version = ${total - 1}`;
      if (!prev) throw new Error(`TAR version ${total - 1} is not an anchored Vula checkpoint (already forked? run pnpm demo:reset)`);
      const victim = await anchoredGradeLeaf(sql);

      // History without the victim event, plus two fresh heartbeats so the tree "grows" past the real size.
      const hashes = (await allLeafHashes(sql)).slice(0, prev.payload.treeSize).filter((_, i) => i !== victim.index);
      const extra = [heartbeatEvent("forger", 1, {}), heartbeatEvent("forger", 2, {})];
      const tree = new MerkleTree([...hashes, ...extra.map(eventLeafHash)]);
      const size = tree.size;
      const signer = signerFromPkcs8(requireEnv("VULA_SIGNING_KEY"), process.env.VULA_SIGNING_KEY_ID || "vula-2026-1");
      const { signature: _sig, signer: _signer, ...base } = prev.payload;
      const forged = signCheckpoint(
        {
          ...base,
          seq: total,
          treeSize: size,
          rootHash: toHex(tree.root()),
          prevTreeSize: prev.payload.treeSize,
          prevRootHash: prev.payload.rootHash,
          consistencyProof: tree.consistencyProof(prev.payload.treeSize, size).map(toHex),
          batch: { ...prev.payload.batch, uri: `${prev.payload.batch.uri}.forged`, fromIndex: prev.payload.treeSize, toIndex: size - 1 },
          issuedAt: new Date().toISOString(),
        },
        signer,
      );
      const checksum = `0x${checkpointChecksum(forged)}` as const;
      const head = await reader.blockNumber();
      const rec = await createRegistryClient(registryConfigFromEnv()).update(tar.value.tarId, forged);
      const landed = await reader.waitForChecksum(checksum, { fromBlock: head > 50n ? head - 50n : 0n, timeoutMs: 180_000 });
      await sql`
        insert into vula.checkpoints (seq, tree_size, root_hash, payload, checksum, status, tar_version, tx_hash, anchored_at)
        values (${total}, ${size}, ${Buffer.from(fromHex(forged.rootHash))}, ${sql.json(forged as never)},
                ${Buffer.from(checkpointChecksum(forged), "hex")}, 'anchored', ${landed.version}, ${landed.txHash}, now())
        on conflict (seq) do update set payload = excluded.payload, root_hash = excluded.root_hash, checksum = excluded.checksum,
          tree_size = excluded.tree_size, status = 'anchored', tar_version = excluded.tar_version, tx_hash = excluded.tx_hash,
          anchored_at = excluded.anchored_at`;
      return `anchored a forged checkpoint as TAR version ${landed.version} (registry receipt ${rec.receipt}, tx ${landed.txHash.slice(0, 18)}…): ` +
        `tree ${prev.payload.treeSize} -> ${size} WITHOUT leaf ${victim.index} (${victim.event.action} ${victim.event.target})`;
    },
  },
  {
    id: "8",
    title: "Stop the collector (silence)",
    story: "The insider stops the Vula collector before doing something, hoping nobody notices the gap.",
    detectedBy: "log-server watchdog",
    expected: "❌ [heartbeat_gap] No collector heartbeat for N s   (dashboard alert after HEARTBEAT_GAP_MS)",
    async run() {
      const pidFile = join(dirname(fileURLToPath(import.meta.url)), "../../.run/collector.pid");
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        try {
          if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
          else process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
        rmSync(pidFile, { force: true });
        return `killed collector process ${pid}; heartbeat alert expected within ${Number(process.env.HEARTBEAT_GAP_MS || 150000) / 1000} s`;
      }
      try {
        execSync("docker compose -f infra/docker-compose.yml stop collector", { stdio: "ignore" });
        return "stopped the collector container";
      } catch {
        throw new Error("collector is not running (no .run/collector.pid and no compose service)");
      }
    },
  },
];

export function findAttack(id: string): Attack {
  const a = ATTACKS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown attack ${id}; available: ${ATTACKS.map((x) => x.id).join(", ")}`);
  return a;
}
