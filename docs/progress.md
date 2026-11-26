# Progress log

## 2026-11-26 (2): task 3 prep, `pnpm anchor:report`

### Done
- **`pnpm anchor:report`** (`scripts/anchor-report.ts`, pure logic in `packages/compellio/src/anchor-stats.ts`):
  read-only (auditor DB role + chain RPC) summary of the current anchoring run: TAR id + explorer link, anchored /
  pending / failed / retried checkpoints vs on-chain `totalVersions`, anchored leaves per source, anchor latency
  (signed → confirmed, median / p95 / max), gas for TAR creation and per `push` + fee in XTZ from the real receipts,
  gaps > 2× the interval, first/last tx links. Prints the ready-to-paste "Live numbers" sentence for the PoC report
  §5. Exit ≠ 0 while < 50 checkpoints are anchored, a receipt is missing, or DB and chain disagree, so it is also the
  "is the testnet run done?" check. `--json` for machine output. +4 tests.

### Blocked (task 3 needs the team)
- Shadownet wallet `0xF52FAf67B682542eD48eBc8C0d05525e83AdC019` still has **0 XTZ** (checked today). Fund it at
  https://shadownet.faucet.etherlink.com/ (captcha), start Docker Desktop, turn sleep off
  (`powercfg /change standby-timeout-ac 0`, on AC), then:
  `pnpm testnet use && pnpm stack:down && pnpm infra:up && pnpm demo:reset && pnpm stack:up`.
  After ≈ 4.5 h: `pnpm anchor:report` (✅ = done) → paste its sentence into the report §5 →
  `pnpm vula verify-log --chain-only --tar <id> --rpc https://node.shadownet.etherlink.com`.

## 2026-11-26: final improvements, tasks 1–2 (public payload mirror, `verify-log --chain-only`)

### Done
- **Task 1, public payload mirror:** public Storage bucket `vula-tar` (migration `20261126120000_vula_tar_public_mirror.sql`,
  applied to the `vula` project). The log server upserts the exact JSON of `GET /tar/0x{address}` to `vula-tar/0x{address}`
  for the log TAR, the profile TAR and the root schema TAR (`mirror.ts`, shared `tar-docs.ts`). Failed uploads retry
  with backoff and never block anchoring. A `mirror_lagging` warning fires when the mirror is more than 2 versions behind.
  `pnpm testnet use` now writes `DCAP_URI_PREFIX={SUPABASE_URL}/storage/v1/object/public/vula-tar/` into infra/.env
  (localhost stays for Hardhat). The log server halts if a TAR on a non-Hardhat chain gets a localhost dataUri.
  Tests: mirror == `/tar/0x…` response for all 3 TARs, dataUri(0) resolves to it via the verifier's source,
  backoff + lag alert, testnet prefix. Live: `pnpm mirror:smoke` ✅ (upsert ×2, public read without credentials,
  `application/json`, `max-age=10`).
- **Task 2, `vula verify-log --chain-only`:** needs only `--tar` + `--rpc`. Payloads via dataUri, profile, checksum,
  signature, seq, prevRoot link and consistency proofs. Opens no DB connection and reads no credentials. Output:
  "chain-only: N checkpoints verified append-only; stored leaves not checked (needs auditor access)". Exit ≠ 0 on any
  failure. Tests: clean, altered payload, broken prevRoot, bad consistency proof, missing payloads; runner with
  `@vula/db` mocked so any `connect()` fails the test. Live: run from an empty directory with an empty environment against
  Shadownet RPC, reached the chain with no env/DB error (no Vula TAR on Shadownet yet, so no positive live run).

### Next
Task 3: the Shadownet run (team), then fill the report placeholders from real data and run `--chain-only` against it.

## 2026-11-24: official Getting Started guide + TAR profile

### Done
- Read the BlockJump Getting Started guide v1.1 (now `docs/BlockJump_Getting_Started_Guide_Registry_API_BCBCTI_v1.1.pdf`):
  `docs/compellio-notes.md` §8. It confirms our setup: self-hosted DCAP.Web, the
  SHA-256(JCS) = getChecksum rule, Shadownet values, one registration at a time, and the BCBCTI flow.
  **There's no Gateway / API key in the challenge**, so our self-hosted DCAP.Web is the intended setup.
- **TAR profile** (the one gap the guide showed): checkpoints' `@context` is now the TAR id of a `VulaCheckpoint`
  profile TAR, built on DCAP.Web's root asset schema TAR (README "Data initialization"). The log server registers both
  before the first checkpoint, reuses them while they're on-chain (kept across `demo:reset`), serves them at
  `/tar/0x…`, and shows them in `/v1/status`. `verify-log` / `verify-event` check the profile from the chain
  (`profile_invalid`, `profile_changed`, `profile_updated`). The CLI prints the profile line; the dashboard overview
  shows it with an explorer link. Details: compellio-notes §9. +14 tests (301 total), typecheck clean.

### Full delivery check: verified live (2026-11-24, local Hardhat 31337 + DCAP.Web v0.0.5 + BCBCTI + Supabase cloud)
- `pnpm test` ✅ 301 · `pnpm typecheck` ✅ (root + dashboard) · `pnpm m0:smoke` ✅ (after `pnpm infra:reset`; see below)
- Profile live: root schema TAR → profile TAR → log TAR v0 anchored. After `demo:reset` the log server reused the
  profile ("checkpoints use TAR profile …"), so no extra deployments.
- `vula verify-log` ✅ (profile ✅, payloads via `dataUri` and via `--payloads db`), `reconcile` ✅, `verify-event` ✅
- `pnpm dashboard:smoke` ✅ 15/15 (needed a rebuild: the old `.next` bundle still had the old `@context` schema)
- `pnpm realtime:smoke` ✅ 2 alerts pushed to the browser in ~3.9 s · `pnpm vula verify-cti` ✅ 3 incidents
- `pnpm e2e:attacks` ✅ attacks 2, 1, 4, 5, 8 · `pnpm e2e:stretch` ✅ verify-event, attacks 7, 6, 3
- **Fixed:** attack 6 crashed (`RangeError size=53 out of range`) when run right after attack 7 and before a new
  heartbeat landed. The forged checkpoint is larger than the stored log, so it now stops there. Also hit from the
  Attack lab with the same 7 → 6 order.
- Gotchas seen: (1) after Docker restarts the Hardhat chain, DCAP.Web's volume still remembers old TARs at the same
  addresses (REST version 15 for a new TAR) → `pnpm infra:reset && pnpm infra:up`, then `pnpm demo:reset`.
  (2) After changing packages, rebuild the dashboard (`pnpm --filter @vula/dashboard build`) before `stack:up`.
  (3) The laptop went to sleep (21:42 → 21:53 local) with the stack running: watchdog `heartbeat_gap` 671 s, then
  Supabase `ECONNRESET`, then everything resumed on its own. Working as designed, but **before the 4.5 h testnet run
  turn sleep off** (`powercfg /change standby-timeout-ac 0`, laptop on AC). Otherwise the gap gets anchored on
  Shadownet for good.

## 2026-11-23 (2): anchoring cost + more adoption channels

### Done
- **Gas measured** (DCAP.Web's DCAPv2 bytecode, in-process Hardhat EVM, no network): `push` = 100,020 gas, TAR creation
  = 1,451,292 gas. With Etherlink's fee formula (1 gwei floor + L1 inclusion fee) one checkpoint ≈ 0.00084 XTZ,
  so one log ≈ 7.3 XTZ / month at 5 min, 36.5 XTZ at 1 min. Inclusion fee ≈ 90 %. In adoption plan §4.
- Correction: heartbeats make every interval anchor, so "less when nothing happened" was wrong; removed.
- Gateway pricing isn't public → §4 now gives the ceiling price per update for each tier; asked for in §9.
- Adoption plan v0.3 §6: named ISO 27001 referral partners in Prishtina, Supabase Partner Catalog, Albania (Law
  25/2024) as second market, Western Balkan Accelerator + Fortify Labs, KOS-CERT / GovCERT XK / UBT CERT.

### Not done
- README demo GIF: needs the full stack + dashboard + a browser; ~1 GB RAM free and Docker not running today.
  Record it during the Shadownet run (dashboard Attack lab → attack 4 → red alert).
- Check the gas cost against real Shadownet receipts once the wallet is funded.

## 2026-11-23: adoption targets + Auth audit switch

### Done
- **Adoption plan v0.2:** researched and named the first 3 targets (ASEE SH.P.K, Kosbit, KIT), UIBM as design partner,
  a 10-organisation outreach list, Kosovo-specific drivers (CBK ICT rules, Law 08/L-173), KosICT/EEN channel, sources.
  The PoC report draft §7 now names them. Contact persons get added after the first reply.
- **`pnpm auth-audit status|on|off`:** reads "write Auth audit logs to the database" with a personal access
  token. Confirmed the need: 4 users, last sign-in today, 0 rows in `auth.audit_log_entries`, setting OFF.
  The setting can't be changed from the terminal: the v1 Management API returns `audit_log_disable_postgres` but
  ignores it on PATCH, and the dashboard's `/platform` endpoint rejects personal tokens ("Unsupported access token").

- **Attack 3 live** ✅ (Auth audit logs to the database turned on in the dashboard): sign-in captured as
  `supabase.auth` leaves, `pnpm attack 3` deleted 2 entries, `reconcile` → 2× `deleted_auth_entry`.
- **Collector fix:** the auth cursor lost microseconds (JS Date), so the newest auth row was re-fetched on every poll
  and the per-source seq kept climbing. The cursor is now Postgres text, sent back as `::text::timestamptz`
  (postgres.js serialises a bare `::timestamptz` parameter through a Date). Verified: each sign-in captured once.
- **BCBCTI hand-off (§0 stretch #1)** ✅ live: Compellio BCBCTI `v1.0.0-rc.3` + its own DCAP.Web + read-only object
  storage in `infra/docker-compose.yml`; log-server CTI worker publishes each warning/critical alert as a STIX 2.1
  `incident` (no row data, `x_vula_alert_sha256` commitment) and records the TAR in `vula.alerts.cti` (migration
  `20261123120000_vula_alerts_cti.sql`, applied); dashboard alerts show "STIX incident · TAR"; new
  `vula verify-cti` follows BCBCTI's verification flow from the chain. Live: 2 incidents from attack 3 ✅; stored
  incident edited (critical → info) ❌ `artifact … was altered`; restored ✅. BCBCTI's real format differs from its
  docs (raw-body checksum, `stixBundle`, base64 hash): `docs/compellio-notes.md` §7. +13 tests (STIX mapping, verify-cti).
- Demo script: BCBCTI segment at 1:37–1:47 (verify and attack 7 shortened), still 2:00.

### Not verified yet
- Dashboard alert badge not looked at in a browser (Next.js didn't fit in RAM next to Docker today); API + types
  build clean.
- BCBCTI on testnet needs a second funded wallet for `registry-cti` (`DCAP_CTI_PRIVATE_KEY`), or the Gateway.

### Blocked / waiting on the team
- Laptop RAM: 5.8 GB total, ~0.5 GB free with Edge + VS Code open; Docker Desktop hung once today. Close Edge tabs
  before running the full stack + dashboard.

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
