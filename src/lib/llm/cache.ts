import crypto from "crypto"
import fs from "fs"
import path from "path"

// REPLAY=1 must NEVER call a provider. This is what lets the deployed demo run
// with no API key: every LLM call goes through readCache first, and a miss
// under REPLAY throws instead of silently falling through to a live call.
//
// `detail` distinguishes two cases that both mean "cannot serve this from the
// corpus": no file at all (thrown by readCache below), and a file that exists
// but no longer parses against the current schema (thrown by adapter.ts,
// which is the layer that actually knows the Zod schema). Both must be fatal
// under REPLAY -- see adapter.ts for why a present-but-invalid entry cannot be
// allowed to fall through to a live provider call.
export class CacheMissInReplayError extends Error {
  constructor(key: string, detail?: string) {
    super(
      detail
        ? `REPLAY=1 and the cached response for ${key} no longer matches the schema (${detail}). The .llm-cache corpus is stale -- run once with a real provider to refresh it.`
        : `REPLAY=1 but no cached response for ${key}. Run once with a real provider first.`
    )
    this.name = "CacheMissInReplayError"
  }
}

// Committed to the repo (see .gitignore: only .llm-cache/tmp/ is ignored) -- this
// is the replay corpus that makes the deployed demo work without LLM_API_KEY.
export const CACHE_DIR = path.join(process.cwd(), ".llm-cache")

// Separator between the joined components of the cache key. Built at
// runtime with String.fromCharCode(0) -- a NUL character -- rather than
// written as a literal escape or raw byte in this source file: a real 0x00
// byte embedded directly in a .ts file makes git treat the whole file as
// binary (no diff, no blame, no `git apply`), which is exactly the bug this
// replaces. The hashing behavior is unchanged: NUL still can't appear in any
// of the joined strings, so there's no risk of two different tuples hashing
// to the same key by accident of concatenation, and the file itself stays
// plain, diffable UTF-8 text.
const KEY_SEPARATOR = String.fromCharCode(0)

// Code review fix round 1, Finding 1 (Critical): `provider` was missing from
// this key entirely. Two different providers (say, the mock provider and a
// real "openai" call) using the same LLM_MODEL string for an identical
// (system, prompt, toolName) collide on one cache file. A committed mock
// fixture then gets served as if it were that provider's real output, AND
// (see adapter.ts's cache-hit branch) gets logged into agent_runs tagged
// with the CURRENTLY ACTIVE provider's name and `cacheHit: true` -- so a
// fabricated response is recorded as a genuine, measured run. Under
// REPLAY=1 (the deployed demo's mode) that is silent and unrecoverable.
// Provider identity is now part of the hash, not just the model string.
export function cacheKey(system: string, prompt: string, toolName: string, model: string, provider: string): string {
  return crypto.createHash("sha256")
    .update([provider, system, prompt, toolName, model].join(KEY_SEPARATOR))
    .digest("hex")
}

export function readCache(dir: string, key: string): unknown | null {
  const file = path.join(dir, `${key}.json`)
  if (!fs.existsSync(file)) {
    if (process.env.REPLAY === "1") throw new CacheMissInReplayError(key)
    return null
  }
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export function writeCache(dir: string, key: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2))
}
