# apps/log-server

Fastify + Zod. Ingest API (append leaf → Merkle tree in `vula.leaves`), checkpoint worker (sign + batch to Supabase Storage),
anchor worker (one Registry API call in flight at a time → new TAR version), and `GET /tar/0x{address}` serving the
checkpoint payloads that the on-chain `dataUri()` points to. **Milestones M1–M2.**
