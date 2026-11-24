# Compellio notes

What the Registry API and the TAR contract actually do. Verified against Compellio's source code **and** a running
DCAP.Web on 2026-11-19. Where this differs from CLAUDE.md §4, this file wins.

Sources read (local clones in `.ref/`, gitignored):

| Repo | Commit | Notes |
|---|---|---|
| `compellio/DCAP.Web` | `bd26551` (2026-11-13), tags `v0.0.1`–`v0.0.7` | Registry API server (.NET 8, Nethereum 4.21.4) |
| `compellio/dcap-token-smart-contract` | `aad3c02` (2025-07-01) | **Old** single-version DCAP token, see §1.1 |
| `compellio/bcbcti` | `0670c34` (2026-10-13) | STIX → TARs; source of the Gateway client details |

## 1. Differences from what CLAUDE.md §4 assumed

### 1.1 The contract DCAP.Web deploys is not the one in `dcap-token-smart-contract`
That repo holds `DCAPToken`: single-version (`push` reverts with "single version token"), with `total()` and
`checksum() → string`. DCAP.Web embeds its own **DCAPv2** contract (`TAR.sol` + `ITransferableTAR`) as bytecode in
`Contracts/ContractDefinition/DCAPv2Definition.cs`, with the Solidity source as standard-JSON input in
`Contracts/TARContract.cs`. **DCAP.Web deploys one new DCAPv2 contract per `POST /api/v1/TAR`.** We don't deploy any
contract ourselves; we only need a dev chain on :8545.

ABI: compiled that embedded source with solc 0.8.28 (optimizer off, evmVersion paris). The creation bytecode equals
DCAP.Web's `BYTECODE` byte for byte, and the runtime code of a contract DCAP.Web deployed on our Hardhat node equals
the compiled `deployedBytecode`. Saved to [`packages/compellio/abi.json`](../packages/compellio/abi.json).

### 1.2 DCAP.Web hashes the raw request body, not JCS
`TAR.AddOrUpdateAsync` computes `SHA256(UTF8(JsonDocument.RootElement.ToString()))`, which is the request body text
exactly as sent (`GetRawText`). It does **not** canonicalise. Our client always sends `JCS(payload)` as the body, so the
on-chain checksum is SHA-256(JCS(payload)), the rule every verifier (ours, BCBCTI's docs, the contract repo's README)
assumes. Verified live: registry checksum and `getChecksum()` equal our own `jcsSha256()` for both versions.
⚠ Anyone sending pretty-printed or key-unsorted JSON to DCAP.Web gets a checksum no JCS verifier can reproduce.

### 1.3 Version numbering: on-chain is 0-based, the REST API is 1-based
- The contract constructor pushes the first checksum as **version 0**. `totalVersions()` = count.
- DCAP.Web's REST `version` is a local counter (count of its own records for that id), starting at **1**.
  On-chain index = REST version − 1 (verified).
- DCAP.Web bumps its counter even if the `push()` tx later fails, so **never trust the REST version**. Confirm on
  chain with `hasChecksum(c)` / `getVersion(c)` (done by `TarReader.waitForChecksum`).

### 1.4 `dataUri(version)` ignores the version
It returns `{DCAP__UriPrefix}0x{contract address, lowercase}` for every version. So whatever the prefix points to must
serve all versions of the TAR at one URL. Plan: `DCAP__UriPrefix=http://localhost:4000/tar/` → log server serves
`GET /tar/0x{address}` with every checkpoint payload. The verifier treats it as untrusted and re-hashes each payload.

### 1.5 Registration timing (DCAP.Web vs Gateway)
- **DCAP.Web POST is synchronous.** It deploys the contract, sleeps 2 s twice, reads the receipt, then returns the
  TAR id. About 5 s on Hardhat.
- **DCAP.Web PUT returns before the `push()` tx is mined** (Nethereum `SendRequestAsync`, no receipt wait) and the
  response has **no tx hash**. We get the tx hash from the contract's `Updated(version, checksum)` event.
- **Gateway is asynchronous:** POST returns a receipt, and the TAR id appears later (BCBCTI polls). Same client
  interface; `waitForTarId()` covers both.

### 1.6 BUG in `dcap-web:latest` (v0.0.6/v0.0.7): every PUT fails → we pin `v0.0.5`
Commit `7d6f705` (2026-10-08, "FIX EIP-155 address format in TAR Ids") removed `.Substring(2)`, so new TAR ids
contain `0x` (`urn:tar:eip155.31337:0x5fbd…`). The PUT path still does `"0x" + lastIdSegment`, which gives
`0x0x5fbd…`. `eth_estimateGas` then fails with "Invalid string length" and the API returns **HTTP 500** for every new
version. Stripping the `0x` from the id doesn't help either: the lookup is an exact string match, so that gives 404.
- `v0.0.5` → `v0.0.7` differs **only** in that line (the rest is README/CI), so we run the official
  `ghcr.io/compellio/dcap-web:v0.0.5` image (digest `sha256:ac10416c3e13…`), unmodified. Ids are then the
  documented no-`0x` form.
- `latest` = `v0.0.7` = digest `sha256:2ee35cf70ae2…` (built 2026-10-08).
- One-line upstream fix: in the update branch, don't prepend `0x` when the segment already starts with it.
- **Worth reporting to Compellio** (they are the evaluators). Not done yet; needs the team's go-ahead.
- Our `parseTarId` accepts both forms, so the Gateway or a fixed DCAP.Web can use either.

### 1.7 Etherlink testnet changed: Ghostnet (128123) is retired → Shadownet (127823)
| | Shadownet (current) |
|---|---|
| Chain id | `127823` |
| RPC | `https://node.shadownet.etherlink.com` |
| Explorer | `https://shadownet.explorer.etherlink.com` |
| Faucet | `https://shadownet.faucet.etherlink.com/` |

Source: <https://docs.etherlink.com/get-started/network-information>. Consequences:
- DCAP.Web hardcodes contract-source auto-verification for chain `128123` only, against the old
  `testnet.explorer.etherlink.com`. On Shadownet our TAR contract shows as **unverified** in the explorer. We can verify
  it manually with the standard-JSON input embedded in `TARContract.cs` (solc `v0.8.28+commit.7893614a`). Note that
  DCAP.Web's verification request says "optimizer on, 200 runs" while the JSON settings (and the real bytecode) have the
  optimizer **off**.
- viem's built-in `etherlinkTestnet` still points at Ghostnet. We define `etherlinkShadownet` ourselves
  (`packages/compellio/src/chains.ts`).
- The contract repo's `etherlink-testnet` network is also still Ghostnet.

### 1.8 Receipt endpoint
DCAP.Web serves both `GET /api/v1/TAR/receipt/{receipt}` and `GET /api/v1/TAR/tarId/{receipt}`. Compellio's own
Gateway client (BCBCTI) uses `/tarId/`, so we use that.

## 2. DCAPv2 contract (one contract = one TAR)

| Member | Notes |
|---|---|
| `constructor(string uriPrefix_, bytes32 checksum_, string predecessorId_)` | owner = deployer (DCAP.Web's key); pushes version 0 |
| `push(bytes32 checksum_)` | **onlyOwner** + `notTransferred`; appends version, emits `Updated` |
| `totalVersions() → uint256` | number of versions |
| `getChecksum(uint256 version) → bytes32` | reverts "TAR: version does not exist" if `version ≥ total` |
| `hasVersion(uint256) → bool`, `hasChecksum(bytes32) → bool`, `getVersion(bytes32) → uint256` | checksum → version lookup (last push wins if a checksum repeats; ours never do) |
| `dataUri(uint256) → string` | `{uriPrefix}0x{address}`, version ignored |
| `owner() → address` | |
| `replace(string successorId_)` | onlyOwner; **freezes the TAR forever** (`push` then reverts `AssetTransferred`). Never call on our log TAR. |
| `successor()`, `predecessor()`, `isTransferred()`, `supportsInterface(bytes4)` | ERC-165: ITAR, ITransferableTAR |
| `event Updated(uint256 indexed version, string checksum)` | checksum as `0x`-hex string; our source for tx hashes |
| `event Transferred(string successor)`, `error AssetTransferred()` | |

Selectors (solc): `push` `0xb298e36b`, `totalVersions` `0x0644f83a`, `getChecksum` `0x4c9c2757`, `dataUri` `0x262087af`.

**Security property we rely on:** only the owner key (held by the Registry API) can push; nobody, the owner included,
can change or delete an existing version. History is append-only, which is what makes anchored checkpoints tamper-evident.

## 3. DCAP.Web REST API (base `/api/v1/TAR`, Swagger at `/swagger` when `ASPNETCORE_ENVIRONMENT=Development`)

| Call | Behaviour (verified or read in source) |
|---|---|
| `POST /api/v1/TAR` (JSON body) | 201 `{id, receipt, data, checksum, version: 1, _sdHashes: null}`. `checksum` is **uppercase** `0x` hex. Blocks while the contract deploys. |
| `PUT /api/v1/TAR/{id}` | 201, same shape, `version` = n. 404 unknown id. **500 with a full .NET stack trace in the body** on chain errors. |
| `GET /api/v1/TAR/{id}` | latest version record |
| `GET /api/v1/TAR/version/{id}:{v}` | `v` = REST (1-based) version |
| `GET /api/v1/TAR/version/raw/{id}:{v}` | exact stored body text **only with `Accept: text/plain`**; with `application/json` it comes back as a JSON-quoted string |
| `GET /api/v1/TAR/version/canonicalized/{id}:{v}` | **not** canonicalised: same as `raw` |
| `GET /api/v1/TAR/receipt/{receipt}` (+ `/raw/`, `/canonicalized/`), `GET /api/v1/TAR/tarId/{receipt}` | lookup by receipt GUID |
| `POST /api/v1/TAR/find` body `{"k": "v", …}` | TARs whose raw JSON **contains any value as a substring**; 404 if none |
| `POST /api/v1/TAR/sd/{id}`, `/receipt/sd/{receipt}` | selective-disclosure stubs (body ignored) |
| `DELETE /api/v1/TAR/{id}` | 204 but does nothing (`ArchiveAsync` is empty) |

Other quirks:
- **No authentication at all** (API-key checks are commented out). Never expose DCAP.Web beyond localhost.
- Storage: `/data/TARReceipts.csv` (`id;receipt;checksum;version`, fully rewritten on every write) + `/data/{receipt}.json`.
  **No concurrency safety → the anchor worker keeps exactly one request in flight** (BCBCTI's docs say the same:
  `MaxConcurrentIngestions=1`).
- `data` in JSON responses is re-serialised by System.Text.Json, so its bytes may differ from what we sent (escaping).
  **Always re-canonicalise (JCS) before hashing; never hash response bytes.** The smoke test does exactly this.
- Sends legacy (type-0) transactions; gas estimated by Nethereum.
- Config: `DCAP__PrivateKey`, `DCAP__BlockchainUrl`, `DCAP__BlockchainId`, `DCAP__UriPrefix`, `DCAP__StoragePath` (default `/data/`).
- Compellio's own compose files (DCAP.Web and BCBCTI examples) now use Foundry **anvil** with `--state` persistence plus
  an **Otterscan** explorer on :5100. Per the brief we use Hardhat. Hardhat keeps state in memory only, so a chain restart
  orphans every TAR DCAP.Web remembers (`pnpm infra:reset` wipes both).

## 4. Compellio Gateway (hosted Registry API): from BCBCTI source, unverified until we have a key

> **Not needed for the challenge (see §8).** The official Getting Started guide v1.1 uses self-hosted DCAP.Web, on the
> local chain and on Etherlink Shadownet, and doesn't mention a Gateway key. `REGISTRY_MODE=gateway` stays as unused code.

- Base URL `https://registry.api.gateway.compellio.com/` (BCBCTI default).
- Headers: `X-Session-Key: <API key>` (required), `X-Blockchain: <network>` (optional), `X-Issuer-Domain: <domain>` (optional).
- Same paths as DCAP.Web: `POST /api/v1/TAR`, `PUT /api/v1/TAR/{id}`, `GET /api/v1/TAR/{id}`, `GET /api/v1/TAR/tarId/{receipt}`.
- Asynchronous: the TAR id is null until registration completes. BCBCTI persists pending operations and reconciles them
  on a timer (`ReconciliationFrequency`, `PendingOperationTimeout`), and does **not** retry failures on the client's behalf.
- Registrations cost credits (closed alpha). BCBCTI has a `Mock` flag to test without spending credits (our `mock` mode).
- Docs: <https://docs.compellio.com/registry/> (components, TAR identification).
- **To confirm once we get the Getting Started guide + API key:** the `X-Blockchain` value for Etherlink Shadownet,
  version numbering, whether the Gateway hashes the raw body or canonicalises, the TAR id format (`0x` or not), the
  credit cost per registration and update.

## 5. BCBCTI patterns we copy (patterns, not code)

- **Payload shape:** `@context` (a profile URN / TAR id) + `@type`. Ours: `"@context": "<VulaCheckpoint profile TAR id>"` (§9),
  `"@type": "VulaCheckpoint"`.
- **Hash-and-point:** the TAR holds a pointer + SHA-256(JCS(object)); raw data stays in permissioned storage. Only
  roots and hashes go on-chain (GDPR / privacy story).
- **Reconciliation loop:** persist pending registry operations, check them on a timer, time out → failed. Unlike
  BCBCTI we retry with backoff and never skip a checkpoint seq.
- **Serialise against DCAP.Web** (one registration in flight).
- **Verification order:** TAR id → chain (`totalVersions`, `getChecksum`) → fetch payload → JCS hash must equal
  on-chain checksum → only then trust what the payload references.
- BCBCTI hand-off built: see §7.

## 6. Verified live: M0 smoke test (`pnpm infra:up && pnpm m0:smoke`)

DCAP.Web v0.0.5 + Hardhat 31337, 2026-11-19:
- `POST` → `urn:tar:eip155.31337:5fbdb2315678afecb367f032d93f642f64180aa3`, REST version 1, ~5.2 s.
- `PUT` → REST version 2, ~0.2 s.
- viem: `totalVersions() = 2`; `getChecksum(0)` and `getChecksum(1)` equal our SHA-256(JCS(v1)) and SHA-256(JCS(v2));
  `owner()` = Hardhat account #0; `dataUri(0) = dataUri(1) = http://localhost:4000/tar/0x5fbd…`;
  tx hashes found via `Updated` events.
- The payload fetched back from the Registry API re-hashes (after JCS) to the on-chain checksum.

## 7. Verified live: BCBCTI hand-off (2026-11-23, BCBCTI `v1.0.0-rc.3` + DCAP.Web `v0.0.5` + Hardhat 31337)

Setup (`infra/docker-compose.yml`): `bcbcti` (TAXII on :8090) → its own `registry-cti` DCAP.Web (:6061, Hardhat
account #1) so its registrations never overlap with our anchor worker's; `bcbcti-files` serves BCBCTI's FileSystem
storage read-only on :8091 (the "permissioned storage" partners read from). `ReconciliationFrequency=00:00:05`
(default 5 min) and `MaxConcurrentIngestions=1` (required with DCAP.Web).

Flow seen: attack 3 → `vula reconcile --report` writes 2 alerts → the log server's CTI worker POSTs each as a STIX 2.1
`incident` to `/api/collections/default/objects` → TAXII status `pending` → ~5 s later `success_count = 1` and the
manifest carries `x_bcbcti_registry_tar_id` (`urn:tar:eip155.31337:…`, one new contract per object) and
`x_bcbcti_registry_version_id = 1` (DCAP.Web's 1-based REST version). `vula verify-cti` ✅ for both; editing the stored
object (`x_vula_severity` critical → info) → ❌ `[artifact] … was altered`; restoring it → ✅ again.

**Where real behaviour differs from BCBCTI's docs** (our verifier accepts both forms):
- **Checksum = SHA-256 of the exact body text, not of JCS.** BCBCTI's TAR payload isn't canonical (its own key order,
  `+` escaped as `+`), and DCAP.Web hashes the bytes it received. Our own checkpoints are sent as JCS text, so for
  them raw = JCS and the rule in §1 holds. A verifier therefore needs the exact text (`GET /api/v1/TAR/version/raw/
  {id}:{v}` with `Accept: text/plain`), or must accept either hash.
- `@type` is **`stixBundle`**, not `StixBundle` (`@context` really is the placeholder `urn:tar:...`).
- The artifact's `hashes["SHA-256"]` is **base64**, not hex; the object file name is the base64url of the same hash.
  The stored object is its JCS form, so SHA-256(file) = SHA-256(JCS(object)).
- DCAP.Web's TAR record for BCBCTI's TARs has `dataUri = {DCAP__UriPrefix}0x{address}`; we point the prefix at
  `registry-cti`'s `/api/v1/TAR/` for readability, but the verifier fetches `version/raw` directly.

Worth reporting to Compellio together with the PUT bug: the doc/implementation mismatch on the checksum rule and the
hash encoding.


## 8. Official BlockJump Getting Started guide v1.1 (`BlockJump_Getting_Started_Guide_Registry_API_BCBCTI_v1.1.pdf`, read 2026-11-24)

Three pages: (1) Registry API, (2) BCBCTI for Challenge 3, (3) key concepts. What it confirms, and what's new to us:

**Confirms what we built**
- Registry = self-hosted DCAP.Web from `ghcr.io` (API :8080, Swagger `/swagger`, chain :8545). `POST` → **201** with
  `id`, `version`, `checksum`, `data`; `PUT /{id}` → new version; `GET /version/{id}:1` → old versions stay readable.
- TAR id = `urn:tar:eip155.<chain>:<contract>`; one smart contract per TAR.
- Verification rule: `SHA-256(JCS(payload)) == getChecksum(version)`. For our checkpoints this holds as-is because we
  send JCS text (§1.2: DCAP.Web really hashes the raw body). The guide doesn't mention the 0-based / 1-based offset (§1.3).
- Live network = **Etherlink Shadownet**: `DCAP__BlockchainUrl=https://node.shadownet.etherlink.com`,
  `DCAP__BlockchainId=127823`, faucet `shadownet.faucet.etherlink.com`, explorer `shadownet.explorer.etherlink.com` (§1.7).
  Only these 3 env values change. Use a new challenge-only wallet; keep the key out of Git (we use `infra/.env.testnet`).
- "Register one TAR at a time: parallel registrations are not supported." "Contract deployment failed" = chain
  unreachable or wallet has no funds.
- BCBCTI: `docker-compose.dcap.yaml` (BCBCTI :8080, Registry :6060, chain :8545, explorer :5100). `POST
  /api/collections/default/objects` with `application/taxii+json;version=2.1` → **202** + status id →
  `GET /api/status/{id}` → manifest entries carry `x_bcbcti_registry_tar_id`. Every object is registered under the
  StixBundle profile. Resending an id with new content → new TAR version. **No authentication: keep it private.**
  Matches §7; our compose remaps ports (TAXII :8090, `registry-cti` :6061) so both stacks run side by side.

**New to us**
- **No Gateway / API key in the challenge path.** Everything runs on self-hosted DCAP.Web. Our DCAP.Web on Shadownet
  is the sanctioned setup. For BCBCTI on testnet the only option left is a second funded wallet (`DCAP_CTI_PRIVATE_KEY`).
- **TAR Profiles.** "Any JSON is accepted, but in the Compellio model a record points to a profile that describes its
  type", through its `@context`. A profile is itself a TAR. DCAP.Web README → *Data initialization*: (1) POST a root
  asset-schema JSON-LD document → TAR A; (2) POST the domain profile whose `@context` is `["<TAR A id>", {…terms…}]`
  → TAR B; (3) records use `"@context": "<TAR B id>"`. **Built (2026-11-24), see §9.**
- **Explorer UI:** `compellio/dcap-asset-explorer` is Compellio's TAR browser (separate from the Otterscan block explorer
  on :5100). Not checked yet.

## 9. Our TAR profile (built 2026-11-24)

Follows DCAP.Web README *Data initialization*, with three TARs on the same chain:

```
root asset schema TAR  ◄── @context[0] ──  VulaCheckpoint profile TAR  ◄── @context ──  every checkpoint (log TAR versions)
(README doc, verbatim)                     (packages/core/src/profile.ts)
```

- **Registration:** before its first checkpoint the log server POSTs the root asset schema, then the profile
  (`["<root TAR id>", {terms}]`, `@id` `urn:vula:asset_profile:checkpoint:v1`, one JSON-LD term per checkpoint field).
  One POST at a time, each confirmed on-chain (`hasChecksum`). Saved in `vula.config` key `profile`. On startup the log
  server reuses it if both TARs still hold the expected checksums on the RPC's chain, and re-registers otherwise (wiped
  Hardhat chain, local ↔ testnet switch). `pnpm demo:reset` keeps it, so a reset costs no extra contract deployments.
  A log TAR whose profile is gone halts the log server with a `profile_missing` alert (`pnpm demo:reset` fixes it).
- **Payload resolution:** DCAP.Web gives all three TARs the same `dataUri` prefix, so the log server's `/tar/0x{address}`
  serves the profile and the root schema too.
- **Verification (`verify-log`, `verify-event`, TAR version 0):** the profile TAR is on the log's chain and exists; its
  payload (untrusted copy) re-hashes to `getChecksum(0)` and is exactly our profile document; its `@context[0]` TAR holds
  SHA-256(JCS(root asset schema)). Both documents are fixed in `@vula/core`, so the auditor needs nothing but the chain
  to check them. Every later checkpoint must keep the same `@context` (`profile_changed`). More than one profile version
  on-chain → `profile_updated` warning.
- **Cost:** two extra TAR deployments per chain (~1.45 M gas each, measured for TAR creation), once.
