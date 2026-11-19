# Progress log

## 2026-11-19: M0 (scaffold + Registry API round trip)

### Done
- Read the three Compellio repos; wrote [compellio-notes.md](compellio-notes.md). Several of the brief's assumptions
  were wrong (contract, checksum rule, version numbering, `dataUri`, testnet). All are recorded there.
- pnpm monorepo (Node ≥ 22, TypeScript 5.9, Vitest 4) with the §6 layout. Packages run from TS source, no build step.
- `infra/docker-compose.yml`: Hardhat node (31337) + DCAP.Web Registry API on :6060.
- `packages/compellio`: ABI (compiled from DCAP.Web's embedded source; bytecode matches on-chain), TAR id
  parsing, Etherlink Shadownet chain + explorer links, viem `TarReader`, registry client with
  `REGISTRY_MODE=dcap-local | gateway | mock`.
- `packages/core`: RFC 8785 JCS + SHA-256 (RFC sample vectors).
- `pnpm m0:smoke` **passes**: TAR created, 2nd version pushed, both on-chain checksums equal our SHA-256(JCS).
- 24 unit tests green, typecheck clean, CI workflow (`.github/workflows/ci.yml`).
- Docs: architecture.md, compellio-notes.md, adoption-plan.md (draft with TODO(team) slots).
- Supabase CLI project initialised (`supabase/config.toml`, project id `vula`; edge runtime + analytics disabled to
  save memory).

### Decisions taken (flag if you disagree)
- **DCAP.Web pinned to `v0.0.5`**: `latest` (v0.0.7) breaks every PUT (`0x0x` address bug, see compellio-notes §1.6).
  Same code otherwise. Revert to `latest` when Compellio fixes it.
- **Testnet = Etherlink Shadownet (127823)**: Ghostnet (128123) is retired.
- **Node 24 is installed locally**; the repo targets Node ≥ 22 (`.nvmrc` = 22, CI uses 22).
- Versions pinned to releases ≥ 2 weeks old (TypeScript 5.9.3 rather than 7.x; Supabase CLI 2.122.1 rather than 3.x).

### Blocked / waiting on the team
- **Compellio Getting Started guide + Gateway API key** (needed for `REGISTRY_MODE=gateway` and the report's "used as
  Compellio describes" claim).
- **Report the DCAP.Web PUT bug to Compellio?** Needs the team's go-ahead (public GitHub issue).
- **Hardhat vs anvil:** Compellio's own compose files use anvil (persistent state) + Otterscan (local explorer links).
  Switching is a stack change, so it needs the team's OK.
- **Local Supabase start:** Docker Desktop has only ~3 GB RAM and its engine went down while pulling the Supabase
  images. Raise Docker Desktop's memory (Settings → Resources) to ≥ 4–6 GB, then rerun `pnpm db:start`.
- Adoption plan: real company names and contacts for the 3 target customers (TODO(team)).

### Next step (M1)
`packages/merkle` (RFC 6962 + transparency-dev vectors) → `packages/core` event/leaf/checkpoint schemas → Supabase
migrations (§7.4) → log-server ingest.
