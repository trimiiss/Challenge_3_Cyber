# Vula: tamper-evident audit trail anchored on Compellio TARs

*"Vula" = "seal" in Albanian.* BlockJump Open Innovation Challenges 2026, Challenge 03: Cybersecurity.

Even someone with full admin rights (the `postgres` / `service_role` key) cannot secretly delete, edit, reorder or
backdate audit records. Every few minutes the log's Merkle root is signed and anchored as a new version of a
**Compellio TAR** (Tokenized Asset Record) on a blockchain, and an independent verifier checks everything straight
from the chain.

**Status: M0 done.** The Registry API round trip works locally: create TAR → push version → read both checksums from
the chain with viem → they equal our own SHA-256(JCS). See [docs/progress.md](docs/progress.md).

## Quickstart (local)

Prerequisites: Node ≥ 22, pnpm 9 (`npm i -g pnpm@9`), Docker Desktop.

```sh
pnpm install
pnpm infra:up        # Hardhat chain :8545 + Compellio DCAP.Web Registry API :6060 (Swagger: /swagger)
pnpm m0:smoke        # create a TAR, push a 2nd version, verify both checksums on-chain
pnpm test            # unit tests
pnpm db:start        # local Supabase (API :54321, DB :54322, Studio :54323)
```

`pnpm infra:reset` wipes the chain and registry state together (do this whenever the chain restarts).

## Layout

```
apps/        log-server · collector · dashboard · grades-demo · cli
packages/    compellio (Registry API client + TAR ABI + chain reader) · core (JCS hashing) · merkle · verifier
supabase/    Supabase CLI project (migrations from M1)
attacks/     scripted attacks + expected detections (M3)
infra/       docker-compose.yml (Hardhat + DCAP.Web), .env.example
docs/        architecture · compellio-notes · adoption-plan · progress
```

## Docs

- [Architecture](docs/architecture.md): components, anchoring flow, the two detection layers, trust boundaries
- [Compellio notes](docs/compellio-notes.md): how the Registry API and the TAR contract really behave (incl. a DCAP.Web bug we work around)
- [Adoption plan](docs/adoption-plan.md): user, buyer, pricing, first customers, pilot
