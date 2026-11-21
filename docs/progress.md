# Progress log

## 2026-11-21: §7 stretch items + M5 docs

### Done
- **§7.5 `vula verify-event`** (`--id <leaf|app_audit:id|auth:uuid>` or `--event file.json`): walks the TAR from the
  chain (same checks as verify-log part A), recomputes the leaf hash from the event content, builds the RFC 9162
  inclusion proof and prints the proof path up to the anchored root. Reports `included`, `not_anchored`
  (exposure window), `not_included` (log altered), `mismatch` (a held copy differs, with diff) or `not_found`.
  New `inclusionProofSteps` in `packages/merkle` (+2 tests). verify-log's chain walk is now `verifyCheckpoints`,
  shared by both commands. +5 verifier tests.
- **§7.6 attacks 3, 6, 7** scripted (`pnpm attack 3|6|7`) and in the dashboard:
  - 3: delete `auth.audit_log_entries` rows → `reconcile` `deleted_auth_entry`
  - 6: rewrite leaves **and** every covering `vula.checkpoints` row consistently → `verify-log` `payload_mismatch`
  - 7: stolen signing key anchors a forged checkpoint (drops the grade event) through the Registry API →
    `verify-log` `inconsistent`; the log server detects the foreign TAR version, halts, alerts `foreign_tar_version`
- **Log server:** `GET /tar/0x…` now serves payloads from `vula.checkpoints` (the DB is the payload store the
  attacker controls; the verifier re-hashes it anyway); new foreign-version check before each checkpoint.
- **§7.7 dashboard stretch pages:** Live events (every leaf + the TAR version that sealed it, filters, "prove" link),
  Verify (visual inclusion proof: leaf → siblings → root vs anchored root, explorer link), Attack lab (all 8 attacks
  with story, needs, expected output, result; attack 7 asks for a second click because it forks the TAR).
- **Supabase** (migration `20261121120000_vula_demo_attacks_live_events.sql`, applied to the cloud project):
  `vula_demo.insider_delete_auth_entries` for attack 3 (execute only for `uibm_admin`), auditors may read
  `vula.leaves` (RLS), `vula.leaves` added to Realtime.
- **M5 docs:** `docs/threat-model.md`, `docs/demo-script.md` (2:00), `docs/poc-report-draft.md`; README and
  attacks README updated. New `pnpm e2e:stretch`; `pnpm dashboard:smoke` covers the new routes and pages.

### Verified live (2026-11-21, fresh Hardhat chain + Supabase cloud)
- `pnpm vula verify-event --id 5` ✅ 5-hash proof path to TAR version 0; `verify-log` ✅
- `pnpm dashboard:smoke` ✅ (401/403 gate, 8 attacks listed, live events, verify-event, all 6 pages render)
- `pnpm test` ✅ 274 tests (216 Merkle, 22 verifier, core, registry client)
- `pnpm e2e:attacks` ✅ MVP regression: attacks 2, 1, 4, 5, 8 all detected
- `pnpm e2e:stretch` ✅ verify-event (by index, by source id, by held copy); attack 7 → `inconsistent` at the forged
  TAR version 1, v0 still ✅, log server halted with `foreign_tar_version`; attack 6 → `payload_mismatch` at v0
  (chain wins). Attack 3 skipped: no Auth audit rows in the DB yet (see blocked)

### Blocked / waiting on the team
- **Etherlink testnet run** (M4, ≥ 50 checkpoints): testnet-only wallet `0xF52FAf67B682542eD48eBc8C0d05525e83AdC019`
  is ready (key in gitignored `infra/.env.testnet`) but has 0 XTZ. Fund it at https://shadownet.faucet.etherlink.com/
  (captcha), then `pnpm testnet use && pnpm stack:down && pnpm infra:up && pnpm demo:reset && pnpm stack:up`.
  At 5-min checkpoints, 50 checkpoints take ≈ 4.5 h of the stack running. `pnpm testnet local` switches back.
- **Attack 3 live**: the Supabase project still writes 0 rows to `auth.audit_log_entries`. Turn on writing Auth audit
  logs to the database (Dashboard → Authentication → audit log settings), sign in once, then `pnpm attack 3`.
- **Attack 9 / `verify-image`**: needs the repo on GitHub (build attestations). No remote yet.
- PoC report: Compellio's DOCX template + three named target customers (`TODO(team)` in adoption plan).

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

### Verified live (2026-11-19, local chain + Supabase cloud)
- `pnpm e2e:attacks`: clean run ✅ (10 checkpoints / 49 events), then attacks 2, 1, 4, 5, 8 all detected
  (reconcile: modified_audit_row + unexplained_change, deleted_audit_row; verify-log: root_mismatch at v5 with
  leaf 37 pinpointed `grade 6 → 10`, log_truncated; watchdog: "No collector heartbeat for 46 s").
- `pnpm dashboard:smoke`: 401 without session, 403 for a professor, all routes OK, UI renders.
- `pnpm realtime:smoke`: dashboard "Run attack 2" → alert pushed to the auditor's Realtime channel in ~3.8 s.
- Log server restart resumes from the stored log and keeps chaining (seq 4 → TAR version 4).
- Supabase security advisor: no errors (INFO: RLS-without-policy on deny-all tables, by design; WARN: leaked
  password protection is off, an Auth dashboard setting).

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
