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

| Component | Where | Port (local) | Milestone |
|---|---|---|---|
| Dev chain (Hardhat, chain id 31337) | `infra/hardhat`, Docker | 8545 | M0 ✅ |
| Compellio Registry API (DCAP.Web `v0.0.5`) | `infra/docker-compose.yml` | 6060 (Swagger `/swagger`) | M0 ✅ |
| Supabase (Postgres, Auth, Storage, Realtime, Studio) | Supabase CLI | 54321 API, 54322 DB, 54323 Studio | M0 ✅ |
| Registry client + chain reader | `packages/compellio` | | M0 ✅ |
| JCS hashing | `packages/core` | | M0 ✅ |
| Merkle tree | `packages/merkle` | | M1 |
| Log server: ingest, checkpoint + anchor workers, `GET /tar/0x{address}` | `apps/log-server` | 4000 | M1–M2 |
| Collectors + heartbeat | `apps/collector` | | M2 |
| Grades demo app | `apps/grades-demo` | | M2 |
| Verifier + `vula` CLI | `packages/verifier`, `apps/cli` | | M3 |
| Dashboard | `apps/dashboard` | | M4 |

Final demo: the chain becomes **Etherlink Shadownet** (chain id 127823) and Supabase becomes a free cloud project.
Everything else stays on the laptop (Docker Compose).

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
