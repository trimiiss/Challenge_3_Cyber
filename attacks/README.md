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
```

The dashboard's **Insider attack lab** (demo mode) runs the same functions, then the matching verifier, and the
findings arrive as real-time alerts.

| # | Attack | What the insider does | Detected by | Expected result |
|---|---|---|---|---|
| 1 | Delete an audit record | `DELETE` the latest captured grade row from `app_audit.events` | `vula reconcile` | `❌ [deleted_audit_row] Audit record #N (UPDATE on grade of … in CS205, …) was DELETED from app_audit.events` |
| 2 | Change a grade + rewrite its audit record | In one transaction: `UPDATE app.grades` 6 → 10, delete the audit row the trigger just wrote (so no collector ever sees it), edit the earlier audit record to show 10 | `vula reconcile` | `❌ [modified_audit_row] Audit record #N (…) was MODIFIED after capture` (with `new.grade: 6 → 10`) and `❌ [unexplained_change] grade of Driton Shala in CS205 is 10 but the last audited value is 6: no audit record explains the change` |
| 4 | Edit a leaf in Vula's own log | Rewrite the grade event in `vula.leaves` to 10 and **recompute `dataSha256` and `leaf_hash`** so the row looks self-consistent | `vula verify-log` | `❌ [root_mismatch] Stored leaves no longer reproduce the root anchored in TAR version V …` + `❌ [leaf_altered] Leaf I was ALTERED: grade.create app.grades:… (grade 6)` with `data.new.grade: 6 → 10`. RESULT: first broken checkpoint = the one covering leaf I |
| 5 | Truncate the log | `DELETE` the newest 5 anchored leaves from `vula.leaves` | `vula verify-log` | `❌ [log_truncated] Log truncated: vula.leaves (Supabase) has N leaves but TAR version V anchored M` + one `❌ [leaf_deleted] Leaf i was DELETED from the log: …` per removed leaf |
| 8 | Stop the collector | Kill the collector process (silence before doing something) | log-server watchdog | Dashboard alert `heartbeat_gap: No collector heartbeat for N s` after `HEARTBEAT_GAP_MS` (demo: 45 s, default 150 s). `vula verify-log` later reports `⚠️ [heartbeat_gap]` for the silent window |

Covered by the verifier unit tests ([packages/verifier/test](../packages/verifier/test/verifier.test.ts)) but not
scripted against the live stack yet (stretch):

| # | Attack | Detection |
|---|---|---|
| 3 | Delete rows from `auth.audit_log_entries` | `reconcile` → `deleted_auth_entry` (needs "write auth audit logs to database" enabled in the Supabase project) |
| 6 | Rewrite `vula.checkpoints` | irrelevant: the chain wins → `verify-log --payloads db` → `payload_mismatch` |
| 7 | Stolen signing key forges a checkpoint that drops old entries | `verify-log` → `inconsistent` (RFC 6962 consistency proof fails); earlier history stays ✅ |
| 9 | Container not built by CI | `verify-image` (stretch, not built) |

## Why the insider can't win

- Layer 1 (`reconcile`) compares the source tables with Vula's captured copy. The insider can rewrite the source
  but not the copy...
- ...because layer 2 (`verify-log`) proves the copy against roots that were **signed and anchored on-chain** as TAR
  versions **before** the attack. Editing, deleting or reordering leaves changes the Merkle root; the chain can't be
  changed. The anchored batch hashes let the verifier say exactly *which* leaf changed and *how*.
- **Window of exposure:** events between capture and the next checkpoint (1 min locally, 5 min on testnet) are not
  yet sealed. Heartbeats every 15–60 s make a stopped collector visible.
