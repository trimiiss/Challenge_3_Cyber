# Demo video script: 2:00 exactly

Screen recording, 1920×1080, browser zoom 125 % (readable on a projector), dark dashboard. Voice-over at a calm
~150 words/minute. Every feature shown here is in the PoC report and works in the build; nothing else is claimed.

**Before recording** (`docs/demo-script.md` checklist at the bottom): fresh `pnpm demo:reset`, 3–4 checkpoints
anchored, professor and auditor signed in in two browser windows, terminal with large font, explorer tab open.

| Time | Screen | Voice-over |
|---|---|---|
| **0:00–0:12** | Title card: "Vula: even the database admin can't secretly rewrite the audit log" → UIBM Grades login | "Every company says its audit logs are tamper-proof. But whoever holds the database superuser password can edit or delete them, and no auditor can tell. Vula fixes that with Compellio TARs." |
| **0:12–0:30** | UIBM Grades: professor enters Driton Shala's grade **6** in CS205 → dashboard **Live events**: the `grade.create` leaf appears, badge "next checkpoint" turns into "TAR v4" | "A professor enters a grade. Database triggers record it, Vula's collector turns it into a leaf of a Merkle tree, and every minute the tree's root is signed and anchored as a new version of one Compellio TAR, through the Registry API." |
| **0:30–0:42** | **Checkpoints** page: TAR versions, root hashes, on-chain checksums → click a tx link → block explorer shows the `push` | "Each checkpoint is one TAR version. The chain stores its SHA-256; anyone can check it on the explorer." |
| **0:42–1:05** | **Attack lab**: press **2** (grade 6 → 10, audit row rewritten), then **4** (Vula's own leaf edited, hashes recomputed). Alerts slide in red on the right | "Now the insider. With the postgres password they raise the grade to 10, delete the audit row, rewrite the old one, and even edit Vula's own stored copy, recomputing every hash so the rows look consistent." |
| **1:05–1:25** | Terminal: `pnpm vula reconcile` → ❌ `modified_audit_row`, `unexplained_change: grade … is 10 but the last audited value is 6`; `pnpm vula verify-log` → ✅ v0–v3, ❌ v4 `root_mismatch`, `leaf_altered data.new.grade: 6 → 10` | "The auditor trusts nothing but the chain. Reconcile shows the source was tampered. Verify-log walks every TAR version on-chain and proves Vula's log no longer matches: first broken checkpoint, version 4, and exactly which field changed." |
| **1:25–1:40** | **Verify** page: enter the leaf index → red "Proof FAILED": proof path from leaf to root, root ≠ anchored root. (Optional cut: same page on a clean leaf shows the green path) | "Any single event can be proven against the chain: hash the leaf up its proof path, compare with the anchored root. The forged grade doesn't make it." |
| **1:40–1:52** | Attack lab card **7** result (pre-recorded on a forked TAR): `inconsistent` at the forged version, earlier versions ✅, `foreign_tar_version` alert | "Even with the stolen signing key, an attacker can only append. Dropping history breaks the consistency proof, and the log server raises the alarm." |
| **1:52–2:00** | Closing card: "Vula · open-source verifier · Compellio Registry API · Etherlink" + repo URL | "Vula: audit evidence that even admins can't rewrite. Verifiable by anyone, straight from the chain." |

## Exact commands used on camera

```sh
pnpm vula reconcile
pnpm vula verify-log --tar $VULA_TAR_ID
```

## Pre-flight checklist

- [ ] `pnpm infra:up` (or testnet env), `pnpm demo:reset`, `pnpm stack:up`; wait for 3+ anchored checkpoints
- [ ] `pnpm vula verify-log` and `pnpm vula reconcile` both ✅ before recording
- [ ] Attack 7 clip recorded separately (it forks the TAR), then `pnpm demo:reset` again
- [ ] Explorer link opens (testnet: Etherlink Shadownet explorer)
- [ ] Notifications off, bookmarks bar hidden, terminal font ≥ 18 pt
- [ ] Final cut is 2:00 ± 1 s
