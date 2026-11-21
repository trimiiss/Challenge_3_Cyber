# Vula: tamper-evident audit trail anchored on Compellio TARs

**PoC report draft** · BlockJump Open Innovation Challenges 2026 · Challenge 03: Cybersecurity
Budget: 4 pages on Compellio's template (~1,800 words + 1 figure). Section headings below are placeholders until we
paste into the organisers' DOCX template; map them 1:1 to its sections. Values marked **[testnet]** are filled in
from the Etherlink run.

---

## 1. Problem: the admin can rewrite the evidence

IT companies tell customers and auditors that their audit logs are tamper-proof. In practice anyone holding the
database superuser password (a DBA, a compromised admin account, a malicious contractor) can change a record, delete
the matching audit rows and leave no trace. ISO/IEC 27001:2022 control 8.15 and PCI DSS v4.0 requirement 10.3 ask for
logs protected against modification, and NIS2 pushes the same requirement down to IT suppliers. Today the answer is
"restricted access" or WORM storage, which still trusts the account owner and gives an external auditor nothing to
check independently.

**Concrete threat (our demo):** at a university grades system, an insider with the `postgres` password raises a
student's grade from 6 to 10, deletes the audit record the trigger wrote, rewrites the earlier one, and finally edits
the copy in the audit tool's own database, recomputing every hash so it looks consistent.

## 2. Solution

Vula turns an ordinary Postgres/Supabase audit trail into a log whose history can be verified by anyone from the chain:

1. **Capture.** Database triggers and Supabase Auth audit entries are collected every 10 s into an append-only
   **RFC 6962 Merkle tree** (own implementation). Heartbeat events make silence visible.
2. **Seal.** Every minute (5 min on testnet) with new events, the log server signs a **checkpoint** (tree size,
   root, previous root, RFC 6962 consistency proof, hash of the raw batch) with Ed25519 and anchors it as a **new
   version of one Compellio TAR** through the Registry API.
3. **Verify.** An independent auditor, trusting only a chain RPC and the TAR id, runs `vula verify-log` (log vs
   chain), `vula reconcile` (source vs log) and `vula verify-event` (inclusion proof of one event). The dashboard shows
   checkpoints with explorer links, live events and real-time alerts.

**Two independent detection layers:** (1) *source vs log*: evidence altered in the source database; (2) *log vs
chain*: Vula's own stored copy no longer reproduces the roots anchored on-chain. The chain is the only trust anchor.

## 3. How we use the Compellio Registry API

| Step | Registry API call | On-chain effect | How we confirm |
|---|---|---|---|
| First checkpoint | `POST /api/v1/TAR` with the JCS (RFC 8785) text of the checkpoint | DCAP.Web deploys the TAR contract; the TAR id `urn:tar:eip155.{chain}:{address}` becomes the log's permanent identity | `totalVersions() = 1`, `getChecksum(0) = SHA-256(JCS(payload))` |
| Every next checkpoint | `PUT /api/v1/TAR/{id}` | `push(checksum)` adds one version: **one TAR version = one checkpoint** (seq = version index) | wait for `hasChecksum` / the `Updated(version, checksum)` event, store the tx hash for the explorer link |
| Verification | none: the verifier reads the contract directly (`totalVersions`, `getChecksum`, `dataUri`) with viem | — | re-hash every payload and compare with the on-chain checksum |

- The checksum rule `SHA-256(JCS(payload))` was confirmed against DCAP.Web's source and in a test that compares our
  own hash with `getChecksum` (milestone M0).
- DCAP.Web is not safe for concurrent writes, so the anchor worker keeps exactly one request in flight, retries the
  *same* payload with backoff, never skips a seq, and always chains from the last **anchored** checkpoint.
- `dataUri(v)` points to our log server, which serves all payloads. Payloads are treated as untrusted: a rewritten
  checkpoint store is caught because its payloads no longer hash to the on-chain checksums (attack 6).
- The client is switchable (`REGISTRY_MODE=dcap-local | gateway | mock`); Gateway mode adds the session key headers
  and receipt polling. Local: DCAP.Web + Hardhat. Final demo: **Etherlink Shadownet testnet [testnet]**.
- One TAR transaction covers every event since the last checkpoint (hundreds or thousands); per-event inclusion proofs
  remain available. This is why we use one TAR per log rather than one TAR per event.

## 4. Architecture

*Figure 1 (to draw): UIBM Grades → Supabase (triggers) → collector → log server (Merkle tree, checkpoint signer,
anchor worker) → Compellio Registry API → TAR contract on Etherlink; auditor CLI and dashboard read the chain directly.*

| Component | Tech |
|---|---|
| Demo app + source of events | "UIBM Grades" on Supabase (Postgres triggers, Auth) |
| Log server | TypeScript, Fastify + Zod; Merkle tree RFC 6962 / RFC 9162 §2.1 (own code, no library) |
| Checkpoints | RFC 8785 canonical JSON, Ed25519 (key only in the log server's env, never in the database) |
| Registry + chain | Compellio DCAP.Web, TAR contract, Etherlink testnet; viem for reads |
| Verifier | `vula` CLI (commander) and the same library inside the Next.js dashboard |
| Least privilege | dedicated Postgres roles: log server, auditor (read-only + alerts), app, and the demo insider |

## 5. Results

**Tests.** 216 Merkle tests (all 196 transparency-dev RFC 6962 vectors, exhaustive checks up to 70 leaves, randomised
up to 1,000, tamper/reorder/truncate/fork negatives); verifier unit tests for every attack; live end-to-end suites
`pnpm e2e:attacks` and `pnpm e2e:stretch` against the running stack.

**Every attack detected** (scripted in `/attacks`, one click each in the dashboard's attack lab):

| # | Insider action | Detected by | What the auditor sees |
|---|---|---|---|
| 1 | delete an audit row | reconcile | `deleted_audit_row` |
| 2 | grade 6 → 10, audit rows deleted/rewritten | reconcile | `modified_audit_row`, "grade … is 10 but the last audited value is 6" |
| 3 | delete Supabase Auth audit entries | reconcile | `deleted_auth_entry` |
| 4 | edit Vula's leaf, recompute hashes | verify-log | first broken TAR version + `data.new.grade: 6 → 10` |
| 5 | delete newest leaves | verify-log | `log_truncated`, each deleted leaf listed |
| 6 | rewrite leaves **and** checkpoint store consistently | verify-log | `payload_mismatch`: the chain wins |
| 7 | stolen signing key anchors a forged checkpoint dropping an event | verify-log + log server | `inconsistent` (consistency proof fails); earlier history stays verified; `foreign_tar_version` alarm |
| 8 | stop the collector | watchdog | `heartbeat_gap` alert |

**Live numbers [testnet]:** TAR id …, ≥ 50 anchored checkpoints, … events, median anchor latency … s, gas per
`push` …, explorer link …. Locally (Hardhat): anchoring takes 0.5–0.7 s per checkpoint; a dashboard attack produces a
red real-time alert in ≈ 4 s.

## 6. Security analysis and limits

- **Signing-key theft** lets an attacker append, not rewrite: anchored versions are immutable and every checkpoint
  must prove it extends the previous one (attack 7).
- **Window of exposure:** events between capture and the next anchor (1–5 min) are not yet sealed; heartbeats and the
  reported unanchored tail make it visible.
- **Not solved:** an insider who disables the triggers or collector *before* acting (mitigated by heartbeat alerts and
  `unexplained_change` checks on table state); compromise of the chain; false data written at the source. Only hashes
  go on-chain; raw events stay in access-controlled storage. Full analysis: `docs/threat-model.md`.

## 7. Plan to adoption

- **User:** platform / security engineer at a SaaS SME or IT service company running Postgres/Supabase.
- **Buyer:** CTO (SME) or CISO (corporate) preparing ISO 27001 / SOC 2 or answering customer security questionnaires.
- **Influencer:** the external auditor, who can verify with the free open-source CLI and a public RPC.
- **Offer:** free verifier; Starter ~€49 / month per source; Team ~€199 / month; self-hosted licence. Every customer
  is a recurring consumer of Compellio Registry API credits.
- **First customers and reach:** [TODO(team): three named companies + contacts]; pilot of 6 weeks with 1–2 design
  partners. Details: `docs/adoption-plan.md`.

## 8. Next steps

Testnet hardening and Compellio Gateway mode with a real API key; BCBCTI hand-off (publish each tampering alert as a
STIX 2.1 sighting so partners and CERTs can consume it as a verifiable TAR); build provenance of the Vula images
(`ci.release` leaves + GitHub attestations); collectors beyond Supabase (plain Postgres, cloud audit logs).
