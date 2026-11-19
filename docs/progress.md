# Progress log

## 2026-11-19 (2): §7 Specifications → M1–M4 (local chain)

### Done
- **§7.2 `packages/merkle`**: own RFC 6962 / RFC 9162 §2.1 tree (no library): roots, inclusion + consistency
  proofs, verification. **214 tests**: RFC 6962 roots, all 196 transparency-dev vectors (98 inclusion, 98
  consistency; 184 of them must-fail), cross-check against a naive RFC reference (every size ≤ 64), exhaustive
  ≤ 70, randomised ≤ 1000, tamper/reorder/truncate/fork negatives.
- **§7.1 / §7.3 `packages/core`**: event schema (zod), leaf = JCS(event), leaf hash = SHA-256(0x00‖leaf);
  checkpoint schema, Ed25519 signing over JCS(payload − signature), batch hashing, source → event mappings
  shared by collector and verifier.
- **§7.4 Supabase (cloud project `vula`, eu-central-1, free plan, created via MCP at the team's request)**:
  migrations in `supabase/migrations/` (app, app_audit + triggers, vula.*, RLS on every table, Realtime on
  alerts + checkpoints, private Storage bucket `vula-batches`), seed with synthetic data. Least-privilege login
  roles: `vula_log`, `vula_auditor` (read-only + alerts), `uibm_app`, `uibm_admin` (the insider).
- **Log server** (Fastify + Zod): ingest with de-dup, in-memory tree, proof endpoints, checkpoint + anchor worker
  (serial, retries the same payload, confirms on-chain, seq == TAR version), heartbeat watchdog, startup
  integrity check (halts if stored leaves no longer match the last anchor), `GET /tar/0x{address}` = the
  on-chain `dataUri` target.
- **Collector**: app_audit + auth audit + heartbeat, cursor per source, independent failure per source.
- **Grades demo**: Fastify + server-rendered HTML, Supabase Auth login, grade entry; trigger records the
  professor as `auth.uid()`.
- **§7.5 Verifier + `vula` CLI**: `verify-log` (chain → payloads → signature/seq/link/consistency → stored
  leaves vs every anchored root → pinpoint via anchored batches → heartbeat gaps), `reconcile` (deleted /
  modified / unexplained audit rows, replayed table state, auth audit), `watch`, `keygen`, `--json`, exit ≠ 0.
  17 unit tests covering attacks 1, 2, 4, 5, 6, 7, 8.
- **§7.6 Attacks** 1, 2, 4, 5, 8 scripted (`pnpm attack <n>`), `pnpm attack reset`, live suite `pnpm e2e:attacks`.
- **§7.7 Dashboard** (Next.js + Tailwind + shadcn-style UI): Supabase Auth gate (auditor role), Overview KPIs,
  TAR card, checkpoints timeline, real-time alerts (Supabase Realtime), insider attack lab (demo mode).

### Decisions taken (flag if you disagree)
- **Supabase cloud instead of local** for dev too (your call: local Supabase didn't fit in this laptop's RAM).
- **Dedicated Postgres roles** instead of the service-role key (the MCP can't hand out secrets). The insider
  of the demo story is `uibm_admin`, which has the same power over the app/audit/log tables as `postgres`.
- **Auth audit log via a SECURITY DEFINER function** (`vula.auth_audit_entries`): on hosted Supabase the `auth`
  schema belongs to `supabase_admin`, so plain grants are silently ignored.
- **Demo timing**: heartbeat every 15 s, alert after 45 s (defaults 60 s / 150 s) so attack 8 fits the video.
- **Batches** are stored under `{logId}/{epoch}/{seq}.json` (storage objects are write-once).

### Blocked / waiting on the team
- **Etherlink Shadownet testnet run** (M4): needs a fresh testnet-only wallet funded from the faucet (captcha) →
  then `DCAP_BLOCKCHAIN_URL/ID` in `infra/.env`, `CHAIN_RPC_URL` in `.env`, `CHECKPOINT_INTERVAL_MS=300000`.
- **Supabase Auth audit logs → database**: the project currently writes 0 rows to `auth.audit_log_entries`. Turn
  on "write audit logs to the database" in the dashboard (Auth settings) if we want attack 3 live. App logins are
  captured through `app.logins` regardless.
- Compellio Gateway API key + Getting Started guide; OK to report the DCAP.Web PUT bug; Hardhat vs anvil.

### Next
Testnet anchoring (≥ 50 checkpoints) → docs (threat model, demo script, PoC report draft) → video.
