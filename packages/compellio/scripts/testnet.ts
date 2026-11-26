/**
 * Switch the stack between the local Hardhat chain and the Etherlink Shadownet testnet (CLAUDE.md M4).
 *
 *   pnpm testnet wallet   create a NEW testnet-only wallet in infra/.env.testnet (gitignored), print its address
 *   pnpm testnet status   balance of that wallet on Shadownet
 *   pnpm testnet use      (needs a funded wallet) point DCAP.Web + log server + verifier at Shadownet, 5-min checkpoints,
 *                         and dataUri at the PUBLIC payload mirror {SUPABASE_URL}/storage/v1/object/public/vula-tar/
 *   pnpm testnet local    back to Hardhat, 1-min checkpoints
 *
 * After `use` / `local`: `pnpm infra:up` (recreates DCAP.Web with the new chain), then `pnpm demo:reset`
 * (the next checkpoint creates a NEW TAR on the selected chain).
 * Secrets: the testnet key only ever lives in infra/.env.testnet and infra/.env, both gitignored.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, formatEther, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { etherlinkShadownet } from "../src/chains";
import { getEnvLine, publicTarMirrorPrefix, setEnvLine, testnetInfraEnv } from "../src/mirror";

const ROOT = new URL("../../../", import.meta.url);
const path = (p: string) => new URL(p, ROOT);
const TESTNET_FILE = path("infra/.env.testnet");
const INFRA_ENV = path("infra/.env");
const ROOT_ENV = path(".env");
const RPC = etherlinkShadownet.rpcUrls.default.http[0]!;
const FAUCET = "https://shadownet.faucet.etherlink.com/";

const LOCAL_INFRA = `# Local Hardhat chain (written by \`pnpm testnet local\`). Hardhat account #0: public dev key, local only.
DCAP_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DCAP_BLOCKCHAIN_URL=http://chain:8545/
DCAP_BLOCKCHAIN_ID=31337
DCAP_URI_PREFIX=http://localhost:4000/tar/
`;

function readKey(): `0x${string}` {
  if (!existsSync(TESTNET_FILE)) throw new Error("no testnet wallet yet: run `pnpm testnet wallet`");
  const m = /^DCAP_PRIVATE_KEY=(0x[0-9a-fA-F]{64})$/m.exec(readFileSync(TESTNET_FILE, "utf8"));
  if (!m) throw new Error("infra/.env.testnet has no DCAP_PRIVATE_KEY");
  return m[1] as `0x${string}`;
}

/** Sets KEY=value lines in the root .env, keeping everything else (and comments) as is. */
function setRootEnv(values: Record<string, string>): void {
  let text = existsSync(ROOT_ENV) ? readFileSync(ROOT_ENV, "utf8") : "";
  for (const [k, v] of Object.entries(values)) text = setEnvLine(text, k, v);
  writeFileSync(ROOT_ENV, text);
}

/** SUPABASE_URL from the root .env: the public payload mirror bucket `vula-tar` lives in that project. */
function supabaseUrl(): string {
  const url = existsSync(ROOT_ENV) ? getEnvLine(readFileSync(ROOT_ENV, "utf8"), "SUPABASE_URL") : undefined;
  if (!url || url.includes("<project-ref>")) throw new Error("set SUPABASE_URL in .env first (the public TAR mirror bucket vula-tar lives there)");
  return url;
}

async function balance(address: `0x${string}`): Promise<bigint> {
  const client = createPublicClient({ chain: etherlinkShadownet, transport: http(RPC) });
  return client.getBalance({ address });
}

const cmd = process.argv[2] ?? "status";
if (cmd === "wallet") {
  if (existsSync(TESTNET_FILE)) {
    console.log(`testnet wallet already exists: ${privateKeyToAccount(readKey()).address}`);
  } else {
    const key = generatePrivateKey();
    writeFileSync(
      TESTNET_FILE,
      `# Etherlink Shadownet TESTNET-ONLY wallet for DCAP.Web (generated ${new Date().toISOString()}). Never commit, never reuse.
DCAP_PRIVATE_KEY=${key}
DCAP_BLOCKCHAIN_URL=${RPC}
DCAP_BLOCKCHAIN_ID=${etherlinkShadownet.id}
# dataUri is fixed forever in every TAR contract. \`pnpm testnet use\` sets it to the PUBLIC payload mirror
# {SUPABASE_URL}/storage/v1/object/public/vula-tar/ when it writes infra/.env.
DCAP_URI_PREFIX=
`,
    );
    console.log(`new testnet-only wallet: ${privateKeyToAccount(key).address}  (key in infra/.env.testnet)`);
  }
  console.log(`fund it at ${FAUCET} (paste the address, solve the captcha), then: pnpm testnet status`);
} else if (cmd === "status") {
  const address = privateKeyToAccount(readKey()).address;
  const b = await balance(address);
  console.log(`${address} on Shadownet (${etherlinkShadownet.id}): ${formatEther(b)} XTZ${b === 0n ? `  -> fund it at ${FAUCET}` : ""}`);
  console.log(`explorer: ${etherlinkShadownet.blockExplorers!.default.url}/address/${address}`);
} else if (cmd === "use") {
  const address = privateKeyToAccount(readKey()).address;
  const b = await balance(address);
  if (b === 0n) throw new Error(`${address} has 0 XTZ on Shadownet: fund it at ${FAUCET} first`);
  // The prefix is baked into every TAR contract on Shadownet, forever: it must be a public URL, never localhost.
  const prefix = publicTarMirrorPrefix(supabaseUrl());
  if (existsSync(INFRA_ENV)) copyFileSync(INFRA_ENV, path("infra/.env.backup"));
  writeFileSync(INFRA_ENV, testnetInfraEnv(readFileSync(TESTNET_FILE, "utf8"), supabaseUrl()));
  setRootEnv({ CHAIN_RPC_URL: RPC, CHECKPOINT_INTERVAL_MS: "300000", VULA_TAR_ID: "" });
  console.log(`switched to Etherlink Shadownet: DCAP.Web signs with ${address} (${formatEther(b)} XTZ), checkpoints every 5 min`);
  console.log(`dataUri prefix (public payload mirror, fixed in every new TAR): ${prefix}`);
  console.log("next:pnpm stack:down && pnpm infra:up && pnpm demo:reset && pnpm stack:up");
} else if (cmd === "local") {
  writeFileSync(INFRA_ENV, LOCAL_INFRA);
  setRootEnv({ CHAIN_RPC_URL: "http://localhost:8545", CHECKPOINT_INTERVAL_MS: "60000", VULA_TAR_ID: "" });
  console.log("switched to local Hardhat, checkpoints every 60 s");
  console.log("next: pnpm stack:down && pnpm infra:up && pnpm demo:reset && pnpm stack:up");
} else {
  console.error("usage: pnpm testnet wallet | status | use | local");
  process.exitCode = 2;
}
