# Vula: tamper-evident audit trail anchored on Compellio TARs

*"Vula" = "seal" in Albanian.* BlockJump Open Innovation Challenges 2026, Challenge 03: Cybersecurity.

Even someone with full admin rights on the database cannot secretly delete, edit, reorder or backdate audit records.
Every minute the audit log's Merkle root is signed and anchored as a new version of a **Compellio TAR** (Tokenized
Asset Record) on a blockchain, and an independent verifier checks everything straight from the chain.

```
UIBM Grades app ─► Supabase (triggers → app_audit.events) ─► collector ─► log server (RFC 6962 Merkle tree)
                                                                              │ signed checkpoint
                                                                              ▼
                                       Compellio Registry API (DCAP.Web) ──push(checksum)──► TAR contract
auditor:  vula verify-log (log vs chain) · vula reconcile (source vs log) · vula verify-event (one event's proof) · live alerts
```

## Quickstart

Prerequisites: Node ≥ 22, pnpm 9 (`npm i -g pnpm@9`), Docker Desktop, a Supabase project with the migrations in
[`supabase/migrations`](supabase/migrations) + [`supabase/seed.sql`](supabase/seed.sql) applied, and `.env` filled
from [`.env.example`](.env.example).

```sh
pnpm install
pnpm infra:up                                     # Hardhat chain :8545 + Compellio DCAP.Web Registry API :6060
pnpm --filter @vula/dashboard build               # once
pnpm stack:up                                     # log server :4000, collector, UIBM Grades :3001, dashboard :3000
pnpm vula verify-log && pnpm vula reconcile       # the auditor's two checks
```

Then: sign in to UIBM Grades (http://localhost:3001) as the professor and enter grades; open the dashboard
(http://localhost:3000) as the auditor: **Live events** shows every captured event and the TAR version that sealed it,
**Verify** draws an event's Merkle proof path up to the root anchored on-chain, and the **Attack lab** runs each
insider attack and the verifier that catches it (red alert in real time). `pnpm stack:down` stops the services,
`pnpm demo:reset` returns to a clean demo (new TAR).

| Command | What it does |
|---|---|
| `pnpm test` | unit tests: Merkle (RFC 6962 + 196 transparency-dev vectors), core, registry client, verifier |
| `pnpm testnet wallet\|status\|use\|local` | testnet-only wallet for DCAP.Web, its Shadownet balance, switch the whole stack to Etherlink Shadownet (5-min checkpoints) or back to Hardhat |
| `pnpm anchor:report` | live numbers of the current anchoring run (checkpoints vs chain, latency, gas per `push`, explorer links) and the report's "Live numbers" sentence; exit ≠ 0 until ≥ 50 checkpoints are anchored |
| `pnpm m0:smoke` | Registry API round trip: create TAR, push version, read both checksums on-chain |
| `pnpm vula verify-log [--tar <id>] [--rpc <url>] [--json]` | walk every TAR version on-chain, verify payload hash, signature, links, consistency proofs, stored leaves vs anchored roots |
| `pnpm vula reconcile [--json]` | captured events vs Supabase today: deleted / modified / unexplained rows |
| `pnpm vula verify-event --id <leaf\|app_audit:id> [--event file.json]` | inclusion proof of one event against the latest anchored root, prints the proof path |
| `pnpm vula verify-cti [--bcbcti <url>] [--json]` | partner / CERT view: every alert shared through Compellio's BCBCTI as a STIX incident, verified from the chain |
| `pnpm vula watch` | both every 60 s; new findings become dashboard alerts |
| `pnpm attack <1..8>` | scripted insider attacks ([attacks/README.md](attacks/README.md)); 7 forks the demo TAR |
| `pnpm e2e:attacks` | runs every MVP attack against the live stack and asserts each detection |
| `pnpm e2e:stretch` | verify-event + attacks 7, 6, 3 against the live stack (then `pnpm demo:reset`) |

## Layout

```
apps/        log-server · collector · grades-demo · dashboard · cli (vula)
packages/    merkle (RFC 6962) · core (events, checkpoints, Ed25519, JCS) · compellio (Registry API client, TAR ABI, viem reader)
             verifier (verify-log, reconcile, verify-event) · db (least-privilege Postgres roles)
attacks/     insider attacks + expected detections
supabase/    migrations (schema, triggers, RLS, roles, storage) + synthetic seed
infra/       docker-compose.yml (Hardhat + DCAP.Web)
docs/        architecture · threat-model · compellio-notes · adoption-plan · demo-script · poc-report-draft · progress
```

## Docs

- [Architecture](docs/architecture.md): components, anchoring flow, the two detection layers, trust boundaries
- [Compellio notes](docs/compellio-notes.md): how the Registry API and the TAR contract really behave (incl. a DCAP.Web bug we work around)
- [Threat model](docs/threat-model.md): attackers, what is detected, what is not solved
- [Attacks](attacks/README.md): what each attack does and what the verifier reports
- [Demo script](docs/demo-script.md): the 2-minute video, second by second
- [PoC report draft](docs/poc-report-draft.md): the 4-page report, before it goes into Compellio's template
- [Adoption plan](docs/adoption-plan.md): user, buyer, pricing, first customers, pilot
- [Progress](docs/progress.md)
