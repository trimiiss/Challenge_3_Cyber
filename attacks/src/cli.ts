/**
 *   pnpm attack list
 *   pnpm attack <1..8>      (7 writes a forged version to the chain: pnpm demo:reset afterwards)
 *   pnpm attack reset     wipe the demo (log, checkpoints, alerts, app data) and re-seed. Stop log server + collector first!
 */
import { ATTACKS, closeInsiderDb, findAttack, insiderDb } from "./attacks";
import { resetDemo } from "./reset";

const id = process.argv[2] ?? "list";
try {
  if (id === "list") {
    for (const a of ATTACKS) console.log(`  ${a.id}  ${a.title.padEnd(52)} detected by ${a.detectedBy}${a.destructive ? "  (forks the demo TAR)" : ""}`);
  } else if (id === "reset") {
    console.log(await resetDemo(insiderDb()));
  } else {
    const a = findAttack(id);
    console.log(`\n☠  Attack ${a.id}: ${a.title}\n   ${a.story}\n`);
    console.log(`   done: ${await a.run(insiderDb())}\n`);
    console.log(`   expected (${a.detectedBy}):\n   ${a.expected.split("\n").join("\n   ")}\n`);
  }
} catch (e) {
  console.error(`attack failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeInsiderDb();
}
