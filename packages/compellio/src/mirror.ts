/**
 * Public payload mirror for on-chain `dataUri` (Supabase Storage, public bucket `vula-tar`).
 * DCAP.Web bakes `DCAP__UriPrefix` into every TAR contract it deploys (constructor argument `uriPrefix_`), so on a
 * public chain it must be a URL every outside auditor can fetch: dataUri(v) = prefix + 0x{address}.
 */
export const TAR_MIRROR_BUCKET = "vula-tar";

export function publicTarMirrorPrefix(supabaseUrl: string): string {
  const base = supabaseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(base)) throw new Error(`SUPABASE_URL must be https://<project-ref>.supabase.co, got "${supabaseUrl}"`);
  return `${base}/storage/v1/object/public/${TAR_MIRROR_BUCKET}/`;
}

/** Sets (or adds) KEY=value in a dotenv text, keeping every other line and comment as is. */
export function setEnvLine(text: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

/** Reads KEY from a dotenv text (no quotes/expansion; the repo's .env files are plain KEY=value). */
export function getEnvLine(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;
}

/** infra/.env for Shadownet: the testnet wallet file with dataUri pointed at the public mirror. */
export function testnetInfraEnv(testnetFile: string, supabaseUrl: string): string {
  return setEnvLine(testnetFile, "DCAP_URI_PREFIX", publicTarMirrorPrefix(supabaseUrl));
}
