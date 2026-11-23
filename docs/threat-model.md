# Vula threat model

What Vula protects, against whom, how each attack is detected, and what it does **not** solve. Every "detected"
row below is a scripted attack in [attacks/](../attacks/README.md) with an automated check
(`pnpm e2e:attacks`, `pnpm e2e:stretch`) or a unit test in [packages/verifier/test](../packages/verifier/test/verifier.test.ts).

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Business records (grades, roles, logins) | `app.*` in Supabase | the thing an insider wants to change |
| Audit evidence | `app_audit.events` (triggers), `auth.audit_log_entries` (Supabase Auth) | proves who changed what, when |
| Vula's log | `vula.leaves` (events), `vula.checkpoints` (signed payloads), Storage `vula-batches` | Vula's own copy of the evidence |
| Checkpoint signing key | `VULA_SIGNING_KEY`, env secret of the log server only, **never** in Supabase | authenticity of checkpoints |
| Trust anchor | one Compellio TAR on-chain: versioned SHA-256 checksums of the checkpoints | the only thing the auditor trusts |

## Trust assumptions

- The auditor trusts **only** a chain RPC and the TAR id (published out of band, pinned with `--tar` / `VULA_TAR_ID`).
- Everything else (Supabase tables, Storage, the log server, the Registry API's responses) is untrusted input that the
  verifier re-hashes against the chain. The verifier does not need the log server or the Registry API to be honest.
- The chain itself is honest (no deep reorgs, contract behaves as published).

## Attackers in scope

| # | Attacker | Capability | Attack | Detected by | Result |
|---|---|---|---|---|---|
| A1 | Insider DBA (`postgres` password) | full DML on app, audit and Vula tables | 1. delete an audit row | `vula reconcile` | `deleted_audit_row` |
| | | | 2. change a grade 6 → 10, delete the trigger's row, rewrite the earlier audit row | `vula reconcile` | `modified_audit_row` + `unexplained_change` ("is 10 but the last audited value is 6") |
| | | | 3. delete rows of `auth.audit_log_entries` | `vula reconcile` | `deleted_auth_entry` |
| | | | 4. edit Vula's stored leaf and recompute `dataSha256` + `leaf_hash` | `vula verify-log` | `root_mismatch` at the covering TAR version + `leaf_altered` with the exact field diff (`data.new.grade: 6 → 10`) |
| | | | 5. delete the newest leaves (truncation) | `vula verify-log` | `log_truncated` + `leaf_deleted` per removed leaf |
| | | | 6. rewrite leaves **and** `vula.checkpoints` (new roots, proofs, checksums) so the DB is self-consistent | `vula verify-log` | `payload_mismatch`: the payload no longer hashes to the checksum on-chain; earlier versions stay ✅ |
| | | | 8. stop the collector before acting | log-server watchdog, `verify-log` | `heartbeat_gap` alert (demo: after 45 s) |
| A2 | Attacker who compromised the log server | signing key + Registry API credentials + DB | 7. rebuild history without an event, sign a checkpoint that links to the real last one, anchor it as the next TAR version | `vula verify-log`, log server | `inconsistent` (RFC 6962 consistency proof fails) at the forged version; all earlier versions stay ✅; the honest log server halts with `foreign_tar_version` |
| A3 | Log operator serving different logs to different auditors (split view) | controls what each auditor downloads | serve auditor X a log without an event | `verify-log` / `verify-event` | impossible to hide: there is one public on-chain history per TAR, and every served payload/leaf must hash into it |
| A4 | Anyone holding a copy of an event (student, professor, partner) | none | wants proof the event is in the sealed log | `vula verify-event` | RFC 9162 inclusion proof from the leaf to the root anchored on-chain; a held copy that differs from the log is flagged `mismatch` with a diff |

What the thief of the signing key **cannot** do (A2): rewrite history that was anchored before the theft. Old TAR
versions are immutable on-chain, and every new checkpoint must carry a consistency proof from the previous anchored
one. They can only append (and appending a forged version is itself visible, see attack 7).

## Window of exposure

Events are sealed only when the next checkpoint is anchored: 1 minute locally, 5 minutes on testnet (configurable,
`CHECKPOINT_INTERVAL_MS`). Between capture and anchoring an attacker with DB access can alter or drop events without
a chain-level trace. Mitigations: short interval; heartbeat leaves every 15–60 s; `vula verify-log` reports the
unanchored tail as `unanchored_tail` (info) so the auditor sees the size of the open window.

The alerts themselves sit in the same database the insider controls. The log server shares every warning/critical
alert with Compellio's BCBCTI within ~3 s, and BCBCTI registers it as its own TAR a few seconds later; after that,
deleting or editing the alert in `vula.alerts` no longer erases it, and editing the shared copy is caught by
`vula verify-cti`. The shared STIX incident carries no row data (no grades, e-mails or diffs), only the kind, layer,
checkpoint version, leaf index and a SHA-256 commitment to the full alert.

## Not solved (stated plainly)

- **Disable before acting.** An insider who disables the audit triggers or the collector *before* changing data
  leaves no audit row to compare. Mitigations: heartbeat gap alert (attack 8); `reconcile` still flags table rows
  whose state no audit record explains (`unexplained_change` / `unexplained_row`); alerting on DDL/trigger changes
  is future work.
- **Compromise of the chain** (or of the TAR contract owner key doing something the contract allows). Out of scope.
- **Privacy of `data`.** Only checksums and roots go on-chain. Raw events stay in access-controlled Supabase tables and
  a private Storage bucket. Anyone verifying needs read access to that data (or to the batches).
- **Integrity of the source at capture time.** Vula proves what was captured was not changed later. If the source
  system writes a false audit row in the first place, Vula faithfully seals the false row.
- **Availability.** An attacker can delete everything; Vula then proves *that* it was deleted (and what was anchored),
  but cannot restore it. Keep backups of the batches.

## Why not just S3 Object Lock / WORM storage?

WORM trusts the storage provider and the account owner, gives an outside auditor nothing to check independently,
and cannot prove completeness (that nothing was dropped or reordered before it was written). Public anchoring plus
Merkle consistency and inclusion proofs give all three.

## Why not one TAR per event (as Compellio's BCBCTI does for threat intel)?

Cost and throughput. One on-chain transaction per checkpoint covers every event since the previous one (thousands if
needed), and per-event inclusion proofs (`vula verify-event`) are still available. BCBCTI's per-object TARs make sense
for a few high-value threat-intel objects; audit logs have thousands of low-value events per day. That is exactly how
we use both: one TAR per log for the events, one BCBCTI TAR per tampering incident.

## Demo-only shortcuts (not for production)

- `vula_demo.insider_delete_auth_entries` (migration `20261121120000`): a SECURITY DEFINER function that gives the demo
  insider role the one power the `postgres` superuser has over `auth.audit_log_entries`, so attack 3 runs without
  putting the postgres password in the repo.
- The dashboard's attack lab runs attacks with the insider role; it only exists when `VULA_DEMO_MODE=1`.
- Locally the Registry API signs with Hardhat's well-known dev key. Never on testnet.
