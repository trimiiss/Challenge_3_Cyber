import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// One .env for the whole monorepo (repo root).
const root = resolve(process.cwd(), "../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));

const config: NextConfig = {
  transpilePackages: ["@vula/verifier", "@vula/core", "@vula/merkle", "@vula/compellio", "@vula/db", "@vula/attacks"],
  serverExternalPackages: ["postgres"],
  outputFileTracingRoot: root,
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_DEMO_MODE: process.env.VULA_DEMO_MODE ?? "1",
    NEXT_PUBLIC_AUDITOR_EMAIL: process.env.AUDITOR_EMAIL ?? "",
  },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
