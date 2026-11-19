# Vula architecture

**Claim:** even someone with full admin rights (the `postgres` / `service_role` key) cannot secretly delete, edit,
reorder or backdate audit records. Every few minutes the log's Merkle root is signed and anchored as a new version of
one Compellio TAR, and an independent verifier checks everything straight from the chain.

## Components and data flow

```
 UIBM Grades app (Next.js + Supabase)
        │ writes
        ▼
 Supabase Postgres ──triggers──► app_audit.events      auth.audit_log_entries
        │                                 │                       │
        └──────────────── collectors (poll every 10 s) ◄──────────┘
                                   │  + heartbeat leaf every minute
                                   ▼
                           LOG SERVER (Fastify)
                 append leaf → RFC 6962 Merkle tree (vula.leaves)
                                   │ every N min, only if there are new leaves
                                   ▼
          CHECKPOINT = {treeSize, root, prev, consistencyProof, sig, batchUri}   (Ed25519-signed)
                     │ raw batch → Supabase Storage      │
                     ▼                                    ▼
               ANCHOR WORKER ──PUT /api/v1/TAR/{id}──► Registry API ──push(checksum)──► TAR contract (chain)
               (1 request in flight)                (DCAP.Web | Gateway)                      ▲
                                                                                              │
 AUDITOR: vula verify-log / reconcile ── reads totalVersions / getChecksum via viem ──────────┘
                                      ── fetches payloads + leaves (untrusted), recomputes everything locally
 DASHBOARD (Next.js): overview, checkpoints + explorer links, real-time alerts, "Run attack" demo
```

| Component | Where | Port (local) | Status |
|---|---|---|---|
| Dev chain (Hardhat, chain id 31337) | `infra/hardhat`, Docker | 8545 | ✅ |
| Compellio Registry API (DCAP.Web `v0.0.5`) | `infra/docker-compose.yml` | 6060 (Swagger `/swagger`) | ✅ |
| Supabase cloud project `vula` (Postgres, Auth, Storage, Realtime), eu-central-1, free plan | `supabase/migrations`, `supabase/seed.sql` | pooler `aws-1-eu-central-1.pooler.supabase.com:5432` | ✅ |
| Registry client + TAR ABI + viem chain reader | `packages/compellio` | | ✅ |
| Event / checkpoint schemas, Ed25519, JCS | `packages/core` | | ✅ |
| RFC 6962 Merkle tree | `packages/merkle` | | ✅ 214 tests |
| Log server: ingest, proofs, checkpoint + anchor worker, watchdog, `GET /tar/0x{address}` | `apps/log-server` | 4000 | ✅ |
| Collector (app_audit, auth audit, heartbeat) | `apps/collector` | | ✅ |
| UIBM Grades demo app | `apps/grades-demo` | 3001 | ✅ |
| Verifier (`verify-log`, `reconcile`) + `vula` CLI | `packages/verifier`, `apps/cli` | | ✅ |
| Attacks 1, 2, 4, 5, 8 | `attacks/` | | ✅ live e2e |
| Dashboard | `apps/dashboard` | 3000 | ✅ |

`pnpm stack:up` starts the Node services (logs in `.run/`). Final demo: the chain becomes **Etherlink Shadownet**
(chain id 127823). Supabase is already the cloud project.

### Database roles (least privilege; passwords only in the local `.env`)

| Role | Used by | Can |
|---|---|---|
| `vula_log` | log server, collector | read `app_audit.events` + auth audit (via `vula.auth_audit_entries()`), write `vula.*` |
| `vula_auditor` | verifier, dashboard API | read everything it checks, append to `vula.alerts` |
| `uibm_app` | UIBM Grades backend | `app.*` only; sets `request.jwt.claims` so the trigger records the professor's `auth.uid()` |
| `uibm_admin` | **the insider** (attacks only) | everything on `app`, `app_audit`, `vula` (what the `postgres` password gives over these tables) |
| Supabase Auth users | dashboard (auditor role), grades app (professor), log server batch uploads (service role in `app.roles`) | RLS + storage policies via `vula.has_role()` |

## How a checkpoint reaches the chain (as the real Registry API behaves)

1. **First checkpoint:** `POST /api/v1/TAR` with the JCS text of the payload. DCAP.Web deploys one DCAPv2 contract
   and returns the TAR id `urn:tar:eip155.{chain}:{address}`. We store it in `vula.config`. This TAR is the log's
   permanent identity.
2. **Every next checkpoint:** `PUT /api/v1/TAR/{id}` → DCAP.Web calls `push(sha256(JCS(payload)))`, which adds one
   version.
3. **Confirmation comes from the chain, not the API.** PUT returns before the tx is mined and has no tx hash, and
   DCAP.Web's version counter is local. The anchor worker polls `hasChecksum(checksum)` / `getVersion(checksum)`
   via viem, then reads the tx hash from the `Updated(version, checksum)` event for explorer links.
4. **Strictly serial:** DCAP.Web isn't safe for concurrent writes, so there is one request in flight. On failure:
   retry with backoff, never skip a seq. The next checkpoint always chains from the last **anchored** one.
5. **Payload hosting:** `dataUri(v)` returns `{UriPrefix}0x{address}` for every version, so the log server serves all
   checkpoint payloads at `GET /tar/0x{address}`. Verifiers treat that response as untrusted and re-hash it.

The registry client has the same interface in all three modes: `REGISTRY_MODE=dcap-local | gateway | mock`.
Gateway mode adds `X-Session-Key` / `X-Blockchain` / `X-Issuer-Domain` and waits for the TAR id via receipt polling.

## Two independent detection layers

| Layer | Question | Compares | Catches | Command |
|---|---|---|---|---|
| **1. Source vs log** | Was evidence tampered with in the source system? | Events Vula captured ↔ current Supabase rows | deleted / modified audit rows, grade edits covered up in `app_audit.events` or `auth.audit_log_entries` | `vula reconcile` |
| **2. Log vs chain** | Was Vula's own log tampered with? | Stored leaves + checkpoints ↔ checksums anchored on-chain | edited leaves, truncation, reordering, rewritten checkpoints, forged checkpoints dropping history | `vula verify-log` |

The chain is the only trust anchor. Layer 1 is only meaningful because layer 2 proves that Vula's copy of the
events is the one that was anchored.

## Trust boundaries

| Component | Trusted for | Not trusted for |
|---|---|---|
| Chain (TAR contract) | append-only history of checksums, timestamps (block) | — (compromise of the chain is out of scope) |
| Signing key (env secret, never in Supabase) | authenticity of checkpoints | completeness: a thief can sign new checkpoints, but consistency proofs against anchored ones catch dropped entries |
| Registry API (DCAP.Web / Gateway) | submitting pushes | its responses; the verifier never reads them |
| Supabase (source data, `vula.*` tables, Storage) | nothing | everything is re-verified against the chain |
| Log server | nothing at verification time | the verifier doesn't need it to be honest |

Window of exposure: events between capture and the next anchor (1 min locally, 5 min on testnet). Heartbeat leaves make
silence (a stopped collector) visible as a gap.
