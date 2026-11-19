# VULA — Tamper-evident audit trail anchored on Compellio TARs

> Project brief for Claude Code. Put this file at the repo root as `CLAUDE.md`.
> Competition: **BlockJump Open Innovation Challenges 2026 — Challenge 03: Cybersecurity**
> ("Proving the integrity of software, data, logs, or documents, and tracking assets and access in a tamper-evident way").
> Hard deadline: **Sunday 13 December 2026, 23:59 CET**. Feature freeze: **12 December**. Selection Day (online pitch): 17 December.
> Rule: the PoC **must use the Compellio Registry API**. Deliverables: 4-page report on Compellio's template + code repo + 2-minute demo video. See §00 for scoring.

"Vula" = "seal" in Albanian. Rename freely.

---

## 00. HOW WE ARE SCORED — from the official Challenge 3 brief v1.2 (this drives every decision)

- **70% Scope & functionality:** the PoC works, **uses the Compellio Registry API properly**, and matches the report. The brief says the Registry API integration is mandatory and *is the part judged technically*.
- **30% Plan to adoption:** a real user, a real buyer, and a way to reach them.
- **Required deliverables (missing one = not scored):** (1) report of **max 4 pages** on Compellio's template, (2) code repository (if private, give Compellio access), (3) **2-minute demo video** of the working PoC.
- The challenge targets **IT companies (corporates, startups, SMEs)**.
- Deadline: **Sun 13 Dec 2026, 23:59 CET** (confirmed in the brief). Then evaluation by Compellio, online Selection Day, award ceremony.
- The brief must "show a concrete threat or trust problem and how the PoC addresses it" → our insider-tampering story. Optional: Compellio's BCBCTI tool for trusted threat-intel sharing (see stretch #1).

What this means for the build:
1. The Registry API integration is the star. Use it exactly as Compellio's **Getting Started guide** describes (ask me for the guide and a Gateway API key; until then build against DCAP.Web, the open-source Registry API). Make the Registry calls visible: show TAR ids, versions, receipts and explorer links in the logs, the dashboard and the video.
2. Every feature in the report must work in the video. Never describe something in the report that isn't working.
3. Write `docs/adoption-plan.md` (persona, buyer, pricing idea, first 3 target customers, how to reach them, pilot plan). It counts for 30%.
4. The demo is a **2-minute video**, not a live pitch. Script it to exactly 2:00.

## 0. HACKATHON SCOPE — read first, overrides everything below

This is a hackathon. Goal = **a demo that works and wins**, not production software. No abstractions "for later", no adapters, no AWS, no cloud hosting. Supabase + local Docker Compose only. Hardcode where it saves time.

**MVP (must ship):**
1. Grades demo app on Supabase with audit triggers.
2. Collector → log server → own Merkle tree (RFC 6962) with tests.
3. Signed checkpoints anchored as versions of one Compellio TAR (DCAP.Web, Hardhat locally → Etherlink testnet for the final demo).
4. Verifier with 2 commands: `verify-log` (chain vs log) and `reconcile` (log vs Supabase).
5. Attacks 1, 2, 4, 5, 8 from §7.6 — each detected.
6. Dashboard: overview, checkpoints with explorer links, alerts in real time, one "Run attack" demo button.
7. README + 2-minute video script + PoC report draft (≤4 pages) + adoption plan.

**Stretch (only if MVP is fully done and demo-tested):** **#1 BCBCTI hand-off:** when the verifier detects tampering, publish a STIX 2.1 `sighting`/`incident` to a local BCBCTI container (`ghcr.io/compellio/bcbcti:latest`, TAXII 2.1) so the alert itself becomes a verifiable TAR that a partner or KOS-CERT could consume; show it in the dashboard. Then: `verify-event` with visual proof path, attacks 3/6/7, GitHub build provenance + `verify-image`, Attack Lab page with all attacks.

Wherever later sections describe more than this, treat the extra as stretch.

---

## 1. One-sentence pitch

Even someone with full admin rights (the `postgres` / `service_role` key) cannot secretly delete, edit, reorder or backdate audit records, because every few minutes the log's Merkle root is signed and anchored as a new version of a Compellio TAR on a blockchain, and an independent verifier checks everything straight from the chain.

## 2. Demo story (build everything to serve this)

A small **university grades app** ("UIBM Grades") runs on Supabase. Every login, grade change and permission change is captured into Vula.

1. Professor logs in and enters grades → events flow into the log → checkpoint anchored on-chain (dashboard shows it live with an explorer link).
2. **Insider attack:** an admin with the `postgres` password changes a student's grade from 6 to 10, then runs `DELETE` on the audit rows and on `auth.audit_log_entries` to cover tracks, then also edits Vula's own stored leaves.
3. The verifier (run by an "auditor" who trusts nothing but the chain) flags: which records were removed or altered, and which checkpoint the forged log no longer matches. Red alert appears on the dashboard in real time.
4. *(Stretch)* the running container's image digest is checked against the GitHub build provenance recorded in the same log ("is this the software we actually built?").

## 3. Stack (fixed — don't swap without asking)

| Layer | Choice |
|---|---|
| Language | TypeScript everywhere, Node 22, pnpm workspaces monorepo |
| Registry + chain | Compellio **DCAP.Web** (`ghcr.io/compellio/dcap-web:latest`) + **Hardhat** node locally; **Etherlink testnet** for the final demo (look up current testnet RPC + chain id; get gas from the faucet) |
| Database / storage / auth / realtime | **Supabase** — local via Supabase CLI (`supabase start`) for dev, free cloud project for the demo |
| Log server | Fastify + Zod |
| Merkle tree | **Own implementation of RFC 6962 / RFC 9162 §2.1** in `packages/merkle` (no Merkle library) |
| Canonical JSON | `canonicalize` (RFC 8785 JCS) |
| Signing | Ed25519 via Node `crypto` (key in env secret, **never** in Supabase) |
| Chain reads | `viem` |
| Verifier | CLI with `commander` (+ same core lib reused by the dashboard) |
| Dashboard | Next.js (App Router) + Tailwind + shadcn/ui, Supabase Auth + Realtime |
| Provenance *(stretch)* | GitHub Actions + `actions/attest-build-provenance`; verify with `gh attestation verify` |
| Tests | Vitest |
| Orchestration + hosting | Docker Compose on the laptop only (no cloud hosting). Only the chain (Etherlink testnet) and the Supabase cloud project are remote for the final demo |

Budget: **€0**. Ask me before anything that costs money.

## 4. Compellio facts (verified from their source code — re-check before relying on them)

Reference repos to clone and read first:
- `https://github.com/compellio/DCAP.Web` — open-source Registry API server (.NET, run it as a container only; do not modify it).
- `https://github.com/compellio/dcap-token-smart-contract` — TAR smart contract + Hardhat setup used by DCAP.Web locally.
- `https://github.com/compellio/bcbcti` — Compellio's own cybersecurity reference (STIX threat intel → TARs). Read `docs/architecture.md` and `docs/configuration.md`; copy its patterns (payload shape, JCS hashing, reconciliation loop), not its code.

What we know:
- **TAR (Tokenized Asset Record)** = on-chain smart contract + off-chain JSON payload. The contract stores **versioned SHA-256 checksums** of the payload; the TAR Id encodes the chain (EIP-155 chain id) and contract address.
- Contract functions relevant to us: `push(bytes32 checksum_)`, `totalVersions() → uint256`, `getChecksum(uint256 versionId) → bytes32`, `dataUri(uint256 versionId) → string`, `owner()`. Confirm the exact ABI from the contract repo and save it to `packages/compellio/abi.json`.
- Checksum = SHA-256 of the payload **canonicalised with RFC 8785**. Confirm by computing it yourself and comparing to `getChecksum` in a test.
- DCAP.Web REST API (Swagger at `/swagger`), base `api/v1/TAR`:
  - `POST /api/v1/TAR` — body = JSON payload → creates TAR, returns a record with a **receipt** id (registration is asynchronous).
  - `GET /api/v1/TAR/receipt/{receiptId}` (and `/raw/`, `/canonicalized/`) — poll until the on-chain id appears.
  - `PUT /api/v1/TAR/{id}` — new payload → **new version** of the same TAR. ← this is how we append checkpoints.
  - `GET /api/v1/TAR/{tarId}`, `GET /api/v1/TAR/version/{address}:{version}`, `.../version/raw/...`, `.../version/canonicalized/...`
  - `POST /api/v1/TAR/find` — filter search.
- DCAP.Web env vars: `DCAP__PrivateKey`, `DCAP__BlockchainUrl`, `DCAP__BlockchainId` (Hardhat = 31337), `DCAP__UriPrefix`.
- DCAP.Web **does not support concurrent registrations** → the anchor worker must serialise pushes (one in flight at a time).
- The hosted Compellio Gateway Registry API needs an API key + credits (closed alpha). Make the registry client switchable: `REGISTRY_MODE=dcap-local | gateway | mock` with the same interface. `mock` is for unit tests only.
- If the real API differs from this section, trust the source code / Swagger, update `docs/compellio-notes.md`, and tell me.

## 5. Architecture

```
 UIBM Grades app (Next.js + Supabase)
        │ writes
        ▼
 Supabase Postgres ──triggers──► app_audit.events      auth.audit_log_entries
        │                                 │                       │
        └──────────────── collectors (poll every 10 s) ◄──────────┘
                                   │  + heartbeat events
                                   ▼
                           LOG SERVER (Fastify)
                 append leaf → Merkle tree (vula.leaves)
                                   │ every N min, if new leaves
                                   ▼
                 CHECKPOINT = {treeSize, root, prev, consistencyProof, sig, batchUri}
                     │ raw batch → Supabase Storage      │
                     ▼                                    ▼
               ANCHOR WORKER ──PUT /api/v1/TAR/{id}──► DCAP.Web ──push(checksum)──► TAR contract (chain)
                                                                                          ▲
 AUDITOR: vula verify ... ── reads totalVersions/getChecksum/dataUri directly via viem ───┘
                          ── fetches payloads + leaves, recomputes everything locally
 DASHBOARD (Next.js): live events, checkpoints, verify page, alerts (Realtime), attack lab
```

Two independent detection layers — make both explicit in UI and docs:
1. **Source vs log (reconcile):** events Vula captured but that are now missing/changed in Supabase → "evidence tampering in the source system".
2. **Log vs chain:** Vula's own stored leaves/checkpoints no longer reproduce the anchored roots → "the log itself was tampered with". The chain is the only trust anchor.

## 6. Repo layout

```
/apps/log-server        Fastify: ingest API, tree builder, checkpoint + anchor workers
/apps/collector         Supabase collectors (auth audit, app_audit triggers table, heartbeat)
/apps/dashboard         Next.js dashboard (Vula UI)
/apps/grades-demo       tiny UIBM Grades app that produces realistic events
/packages/merkle        RFC 6962 tree, inclusion + consistency proofs (pure, 100% tested)
/packages/core          event schema, leaf encoding, checkpoint schema, signing, JCS hashing
/packages/compellio     registry client (dcap-local | gateway | mock), ABI, chain reader (viem)
/packages/verifier      verification logic (used by CLI + dashboard)
/apps/cli               `vula` CLI
/supabase               migrations, seed, RLS policies, triggers
/attacks                scripted attacks (each has expected verifier output)
/infra                  docker-compose.yml, hardhat setup, .env.example
/docs                   architecture.md, threat-model.md, compellio-notes.md, demo-script.md, poc-report-draft.md
/.github/workflows      ci.yml (tests), release.yml (build images + provenance attestation)
```

## 7. Specifications

### 7.1 Event (leaf content)
```json
{
  "v": 1,
  "source": "supabase.auth | supabase.app_audit | vula.heartbeat | ci.release",
  "sourceId": "<primary key in source system>",
  "seq": 1234,
  "occurredAt": "ISO-8601 from source",
  "capturedAt": "ISO-8601 when collector read it",
  "actor": "user id / role / null",
  "action": "login | grade.update | grade.delete | role.grant | ...",
  "target": "table:row or resource",
  "data": { "...": "full row snapshot, or diff" },
  "dataSha256": "hex of JCS(data)"
}
```
Leaf bytes = `JCS(event)`. Leaf hash = `SHA256(0x00 || leafBytes)`. Node hash = `SHA256(0x01 || left || right)`. Exactly RFC 9162 §2.1 (including how unbalanced trees split at the largest power of two < n).

### 7.2 Merkle package API
`appendLeaf`, `root(size)`, `inclusionProof(index, size)`, `verifyInclusion(leafHash, index, size, proof, root)`, `consistencyProof(oldSize, newSize)`, `verifyConsistency(oldSize, newSize, oldRoot, newRoot, proof)`.
Tests: empty tree root = SHA256(""), known RFC 6962 test vectors (port them from Google's `transparency-dev/merkle` testdata — fetch from GitHub), property tests (random sizes, every index, every oldSize < newSize), negative tests (tampered leaf, reordered leaves, truncated tree must fail).

### 7.3 Checkpoint (= TAR payload, one TAR version per checkpoint)
```json
{
  "@context": "urn:tar:vula:checkpoint:v1",
  "@type": "VulaCheckpoint",
  "logId": "uibm-grades-prod",
  "seq": 42,
  "treeSize": 18231,
  "rootHash": "hex",
  "prevTreeSize": 17990,
  "prevRootHash": "hex",
  "consistencyProof": ["hex", "..."],
  "batch": { "uri": "supabase storage url", "sha256": "hex", "fromIndex": 17990, "toIndex": 18230 },
  "issuedAt": "ISO-8601",
  "signer": { "alg": "Ed25519", "keyId": "vula-2026-1", "publicKey": "base64" },
  "signature": "base64 Ed25519 over JCS(payload without signature)"
}
```
- First checkpoint: `POST` creates the TAR; store the TAR id in `vula.config`. Every next checkpoint: `PUT` → new version.
- Checkpoint only when there are new leaves, but emit a **heartbeat leaf** every minute so silence is detectable (gap = alert).
- Interval: 1 min locally, 5 min on testnet (configurable).
- Retry with backoff; never skip a seq; if a push fails the next checkpoint must still chain from the last **anchored** one.

### 7.4 Supabase schema (migrations in /supabase)
- `app.students`, `app.courses`, `app.grades`, `app.roles` (demo app data)
- `app_audit.events` filled by `AFTER INSERT/UPDATE/DELETE` triggers on `app.*` (old + new row, `auth.uid()`, timestamp, txid)
- `vula.leaves (index bigint pk, leaf_hash bytea, event jsonb, captured_at)`
- `vula.checkpoints (seq pk, tree_size, root_hash, payload jsonb, tar_version, tx_hash, anchored_at, status)`
- `vula.collector_state (source pk, cursor)`
- `vula.alerts (id, kind, severity, details jsonb, created_at)` → Realtime-enabled for the dashboard
- RLS on everything; dashboard reads via authenticated role; log server uses service role.
- Also collect `auth.audit_log_entries` (make sure "write auth audit logs to project database" is enabled).

### 7.5 Verifier CLI (`vula`)
- `vula verify-log --tar <id> --rpc <url>`: walk every TAR version from chain (`totalVersions`, `getChecksum`, `dataUri`), fetch payload, recompute JCS SHA-256 = on-chain checksum, check Ed25519 signature, check `prevRoot` linkage and the **consistency proof** between consecutive checkpoints, then rebuild the tree from stored leaves and compare roots. Output: ✅ or the first broken checkpoint + reason.
- `vula reconcile --source supabase`: compare captured events with current source rows; report deleted / modified / unexplained rows.
- *(Stretch)* `vula verify-event --id <leafIndex|sourceId>`: inclusion proof against the latest anchored root; prints the proof path.
- *(Stretch)* `vula verify-image --digest sha256:...`: find the `ci.release` leaf, check it's anchored, and run `gh attestation verify` on the image.
- `--json` flag for machine output; exit code ≠ 0 on any failure.
- **The verifier must not need the log server or Compellio API to be honest** — only chain RPC + payload/leaf data (which it treats as untrusted).

### 7.6 Attacks (/attacks, each a script + expected result in README). MVP = 1, 2, 4, 5, 8. Others are stretch.
1. Delete an audit row in `app_audit.events` → `reconcile` flags it.
2. Change a grade and the matching audit row → `reconcile` flags modified row.
3. Delete rows from `auth.audit_log_entries` → `reconcile` flags.
4. Edit a leaf in `vula.leaves` → `verify-log` fails at the checkpoint covering it.
5. Delete the newest leaves (truncation) → `verify-log` fails (tree size < anchored size).
6. Rewrite `vula.checkpoints` table → irrelevant, chain wins; `verify-log` still detects.
7. Forge a checkpoint with a stolen signing key that drops old entries → consistency proof fails.
8. Stop the collector (silence) → heartbeat gap alert.
9. Deploy a container not built by CI → `verify-image` fails.

### 7.7 Dashboard pages
MVP: Overview (KPIs: events, tree size, last anchored checkpoint + explorer link, health) · Checkpoints timeline · Alerts (Realtime) · one "Run attack" button (demo mode only) that runs an attack against the demo DB, then the verifier, and shows the result.
Stretch: Live events page · Verify page (paste event → visual inclusion proof path) · full Attack Lab with every attack.
Clean, serious security look; must be readable on a projector.

## 8. Milestones (commit + tag at each; all tests green before moving on)

| # | Dates | Goal | Done when |
|---|---|---|---|
| M0 | 19–21 Nov | Scaffold monorepo, Docker Compose: Hardhat + TAR contract deploy + DCAP.Web + local Supabase | Script creates a TAR, pushes a 2nd version, and `viem` reads both checksums matching our own JCS SHA-256 |
| M1 | 22–26 Nov | `packages/merkle` + `packages/core` + Supabase migrations + log-server ingest | All Merkle tests incl. RFC vectors pass; can ingest events and get inclusion proofs |
| M2 | 27 Nov–1 Dec | Collectors, heartbeat, signer, checkpoint + anchor workers | Running grades-demo produces events end-to-end into anchored checkpoints |
| M3 | 2–5 Dec | Verifier CLI (`verify-log`, `reconcile`) + MVP attacks 1, 2, 4, 5, 8 | Every MVP attack produces the expected detection; clean run = all ✅ |
| M4 | 6–9 Dec | Dashboard (MVP pages) + Etherlink testnet deployment | Full demo story works on testnet from a fresh clone, rehearsed twice |
| (stretch) | only if M4 is done | Items marked stretch, in this order: BCBCTI hand-off → `verify-event` → attacks 3/6/7 → provenance + attack 9 → full Attack Lab | Never at the expense of M5 |
| M5 | 10–12 Dec | Docs: README, architecture, threat model, adoption plan, PoC report draft (≤4 pages, fits Compellio template), 2-minute video script; record the video | Freeze 12 Dec 23:59; submit 13 Dec |

Start with M0. Before writing code, read the three Compellio repos and write `docs/compellio-notes.md` (actual endpoints, payload/receipt flow, ABI, checksum rules, quirks).

## 9. Threat model (write in docs/threat-model.md; be honest — judges will probe)

- **In scope:** malicious insider with DB superuser; attacker who compromised the log server DB; attacker who stole the signing key (can only forge *future* checkpoints, cannot rewrite anchored history — consistency proofs catch dropped entries); attacker who serves different logs to different auditors (prevented: one public on-chain history).
- **Window of exposure:** events between capture and next anchor can be altered undetected → keep interval short; heartbeats expose silence.
- **Not solved (state clearly):** attacker who disables triggers/collection *before* acting (mitigated by heartbeat + alert on trigger/DDL changes if possible); compromise of the chain itself; privacy of `data` (only hashes/roots go on-chain; raw data stays in access-controlled storage).
- **Why not just S3 Object Lock / WORM?** It trusts the storage provider and account owner, gives outside auditors nothing to verify independently, and can't prove completeness. Public anchoring + Merkle proofs do.
- **Why not one TAR per event (like BCBCTI)?** Cost and throughput: one on-chain tx per checkpoint covers thousands of events, with per-event proofs still available.

## 10. Working rules for Claude Code

- Plan each milestone briefly, then build; small commits with clear messages.
- Never commit secrets. `.env.example` only. Hardhat's well-known dev key is fine locally, never on testnet.
- **Do not use any real company data or company cloud accounts.** All data is synthetic (seed script).
- Do not modify Compellio code; run it as containers and wrap it.
- Keep `packages/merkle`, `packages/core`, `packages/verifier` dependency-light and fully unit-tested — they are the cryptographic core the jury will look at.
- When unsure about Compellio behaviour, test against the running DCAP.Web, not assumptions.
- Ask me before: spending money, changing the stack, changing the demo story, or cutting a milestone.
- If running late, drop stretch items first, then the dashboard polish. **Never cut** the Merkle tests, the verifier, the MVP attacks, or the testnet anchoring.
- Don't build anything not listed in §0. If you think something extra is needed, ask me first.
- Keep a `docs/progress.md` log: what's done, what's blocked, next step.

## 11. Final deliverables checklist

- [ ] GitHub repo (public, or private with Compellio given access), clean README (what / why / quickstart in ≤5 commands / demo GIF)
- [ ] **2-minute demo video** of the working PoC (required)
- [ ] **PoC report, max 4 pages, on Compellio's template** (required)
- [ ] `docs/adoption-plan.md` (30% of the score)
- [ ] `docker compose up` brings up everything locally from a fresh clone
- [ ] Testnet TAR with ≥ 50 anchored checkpoints + explorer links
- [ ] Verifier passes on clean log, catches every MVP attack (1, 2, 4, 5, 8)
- [ ] docs: architecture, threat model, compellio-notes, demo script
- [ ] PoC report draft (`docs/poc-report-draft.md`) mapped to the organisers' DOCX template sections
- [ ] Video script timed to 2:00, matching the report feature for feature
