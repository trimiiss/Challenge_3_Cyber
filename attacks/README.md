# Attacks (CLAUDE.md §7.6)

Scripted insider attacks against the demo, each with the detection it must produce. The attacker is
**`uibm_admin`**: a database administrator with full rights on the `app`, `app_audit` and `vula` tables. That is
exactly what someone holding the `postgres` password can do to these tables. Source: [src/attacks.ts](src/attacks.ts).

```sh
pnpm attack list          # show attacks
pnpm attack 2             # run one (prints what it did + the expected detection)
pnpm vula reconcile       # layer 1: source vs log
pnpm vula verify-log      # layer 2: log vs chain
pnpm attack reset         # back to a clean demo (stop log server + collector first: pnpm stack:down)
pnpm e2e:attacks          # runs 2, 1, 4, 5, 8 against the live stack and asserts every detection
pnpm e2e:stretch          # verify-event + attacks 7, 6, 3 (forks the demo TAR: pnpm demo:reset afterwards)
```

The dashboard's **Attack lab** page (demo mode) runs the same functions, then the matching verifier, and the
findings arrive as real-time alerts.

| # | Attack | What the insider does | Detected by | Expected result |
|---|---|---|---|---|
| 1 | Delete an audit record | `DELETE` the latest captured grade row from `app_audit.events` | `vula reconcile` | `❌ [deleted_audit_row] Audit record #N (UPDATE on grade of … in CS205, …) was DELETED from app_audit.events` |
| 2 | Change a grade + rewrite its audit record | In one transaction: `UPDATE app.grades` 6 → 10, delete the audit row the trigger just wrote (so no collector ever sees it), edit the earlier audit record to show 10 | `vula reconcile` | `❌ [modified_audit_row] Audit record #N (…) was MODIFIED after capture` (with `new.grade: 6 → 10`) and `❌ [unexplained_change] grade of Driton Shala in CS205 is 10 but the last audited value is 6: no audit record explains the change` |
| 3 | Delete Supabase Auth audit entries | Delete the newest captured rows of `auth.audit_log_entries` (via `vula_demo.insider_delete_auth_entries`, which models the postgres superuser's power over the `auth` schema) | `vula reconcile` | `❌ [deleted_auth_entry] Auth audit entry … was DELETED from auth.audit_log_entries`. Needs the project to write Auth audit logs to the database: Supabase dashboard → Authentication → Audit Logs (check with `pnpm auth-audit status`) |
| 4 | Edit a leaf in Vula's own log | Rewrite the grade event in `vula.leaves` to 10 and **recompute `dataSha256` and `leaf_hash`** so the row looks self-consistent | `vula verify-log` | `❌ [root_mismatch] Stored leaves no longer reproduce the root anchored in TAR version V …` + `❌ [leaf_altered] Leaf I was ALTERED: grade.create app.grades:… (grade 6)` with `data.new.grade: 6 → 10`. RESULT: first broken checkpoint = the one covering leaf I |
| 5 | Truncate the log | `DELETE` the newest 5 anchored leaves from `vula.leaves` | `vula verify-log` | `❌ [log_truncated] Log truncated: vula.leaves (Supabase) has N leaves but TAR version V anchored M` + one `❌ [leaf_deleted] Leaf i was DELETED from the log: …` per removed leaf |
| 6 | Rewrite the checkpoint store | Edit the grade leaf **and** rewrite every covering row of `vula.checkpoints` (new roots, consistency proofs and checksums) so the database is self-consistent again; no key, so no re-signing | `vula verify-log` | `❌ [payload_mismatch] Checkpoint store tampered: payload for TAR version V from {dataUri} does not match the checksum anchored on-chain`. RESULT: first broken = V; every earlier version ✅. `vula verify-event --id <leaf>` fails too |
| 7 | Stolen signing key | With `VULA_SIGNING_KEY` + Registry API access: rebuild the log without the grade event, sign a checkpoint that links to the real last one, `PUT` it as the next TAR version, insert it into `vula.checkpoints` | `vula verify-log` + log server | `❌ [inconsistent] TAR version V is NOT an append-only extension of version V-1` (RFC 6962 consistency proof fails); v0..V-1 ✅; the log server raises `foreign_tar_version` and halts. **Forks the demo TAR: `pnpm demo:reset` afterwards** |
| 8 | Stop the collector | Kill the collector process (silence before doing something) | log-server watchdog | Dashboard alert `heartbeat_gap: No collector heartbeat for N s` after `HEARTBEAT_GAP_MS` (demo: 45 s, default 150 s). `vula verify-log` later reports `⚠️ [heartbeat_gap]` for the silent window |

Not built (stretch, needs the repo on GitHub for build attestations):

| # | Attack | Detection |
|---|---|---|
| 9 | Container not built by CI | `vula verify-image` + `gh attestation verify` |

Attacks 4, 5, 6, 7 and 8 also have unit tests in [packages/verifier/test](../packages/verifier/test/verifier.test.ts).

## Why the insider can't win

- Layer 1 (`reconcile`) compares the source tables with Vula's captured copy. The insider can rewrite the source
  but not the copy...
- ...because layer 2 (`verify-log`) proves the copy against roots that were **signed and anchored on-chain** as TAR
  versions **before** the attack. Editing, deleting or reordering leaves changes the Merkle root; the chain can't be
  changed. The anchored batch hashes let the verifier say exactly *which* leaf changed and *how*.
- **Window of exposure:** events between capture and the next checkpoint (1 min locally, 5 min on testnet) are not
  yet sealed. Heartbeats every 15–60 s make a stopped collector visible.
