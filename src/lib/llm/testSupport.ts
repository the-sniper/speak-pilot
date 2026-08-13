import { __setProviderForTest } from "./adapter"
import { mockProvider } from "./providers/mock"

// Shared test seam for any suite that exercises callWithSchema through a real
// route (not adapter.test.ts's direct unit tests, which already inject a fake
// provider per-test). Two ambient .env values matter here — LLM_PROVIDER and
// REPLAY, both loaded by vitest.config.mts's `setupFiles: ["dotenv/config"]`
// so DATABASE_URL is available — and a route test file that only writes
// `process.env.LLM_PROVIDER = "mock"` in its own beforeAll does NOT actually
// pin the provider:
//
//   adapter.ts resolves `currentProvider` ONCE, at module-import time
//   (`let currentProvider: Provider = resolveProvider()`), which runs before
//   any test file's beforeAll. Reassigning process.env.LLM_PROVIDER
//   afterward never re-resolves that module-level variable, so whatever
//   LLM_PROVIDER happened to be in .env at import time silently wins. Under
//   this repo's replay-demo .env (LLM_PROVIDER=openai REPLAY=1) that means
//   the route resolves the real OpenAI provider with a blank key and calls
//   fail with 400/502 instead of exercising the intended mock path.
//
// __setProviderForTest sidesteps the whole problem by assigning the
// module-level variable directly, so it doesn't matter when it runs relative
// to module import, and it doesn't matter what LLM_PROVIDER says in .env.
//
// REPLAY has the same ambient-config hazard through a different mechanism:
// cache.ts's readCache throws CacheMissInReplayError on any cache miss when
// process.env.REPLAY === "1" (checked at call time, not import time) — which
// fires even for the mock provider, because these route tests point the
// adapter at a fresh temp cache dir (see __setCacheDirForTest) that starts
// empty. So pinning the provider alone is not enough; REPLAY must also be
// pinned off for these tests' intended behavior (a live-ish mock call, not a
// replay-corpus lookup) to hold regardless of the developer's .env.
//
// Returns a restore function so callers can put ambient state back in
// afterAll rather than leaking a pinned REPLAY value into whatever test file
// vitest runs next in the same worker process.
export function pinMockProviderForTest(): () => void {
  const originalReplay = process.env.REPLAY
  __setProviderForTest(mockProvider)
  process.env.REPLAY = "0"
  return () => {
    if (originalReplay === undefined) delete process.env.REPLAY
    else process.env.REPLAY = originalReplay
    __setProviderForTest(mockProvider)
  }
}
