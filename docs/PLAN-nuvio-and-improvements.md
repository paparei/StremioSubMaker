# Plan: Nuvio Compatibility + Optimizations + Quality/Speed

Target: StremioSubMaker v1.4.88. Nuvio facts below come from reading current sources of
[NuvioTV](https://github.com/NuvioMedia/NuvioTV) and [NuvioMobile](https://github.com/NuvioMedia/NuvioMobile)
(cloned locally under `nuvio-tv-src/` and `nuvio-mobile-src/`).

## 0. TL;DR

| # | Change | Fixes | Priority | Status |
|---|--------|-------|----------|--------|
| 1 | Detect Nuvio, bounded wait on `/translate`, partial-SRT fallback (never the loading placeholder) | #139 ("Not work in nuvio") | P0 | DONE |
| 2 | Preserve original Stremio action names; use code-first Nuvio tags and IDs | Nuvio parsing + #151 | P0 | DONE (fork) |
| 3 | Accept Gemini `AQ.` keys + refresh dead model defaults | #154 #155 | P0 | DONE |
| 4 | Parse NuvioTV's `&`-joined extras path segment | NuvioTV hash/filename features | P1 | VERIFIED — SDK router already parses path-segment extras via `qs.parse`; query-string variant normalized by `normalizeSubtitleQueryExtras()` |
| 5 | Cap provider search ~15s for Nuvio (its list timeout is 20s) | empty lists on slow providers | P1 | (open) |
| 6 | Route background work through configured primary provider | #149 | P1 | VERIFIED — SMDB translate, AutoSubs, embedded routes all go through `createTranslationProvider()` |
| 7 | Gemini v3 thinkingLevel vs budget | #144 | P1 | DONE (fork) |
| 8 | Serbian/legacy charset detection | #143 | P1 | DONE (fork) |
| 9 | Enable gated parallel batches on ElfHosted + entry cache | #146 speed | P1 | DONE — ElfHosted cap (2 vs 5); entry cache (open) |
| 10 | Forced flag in labels, provider rate-limit backoff, `und` cleanup | #147 #141 #142 #150 #50 | P2 | #147/#50 DONE (fork); #141/#142/#150 (open) |

---

## A. Nuvio compatibility

### Constraints from Nuvio source (design against these)

1. **One-shot download.** Both clients fetch a subtitle URL exactly once and parse it
   (TV: Media3 `DefaultSubtitleParserFactory` with lenient fallback; Mobile similar).
   Neither client re-polls. SubMaker's loading SRT (`createLoadingSubtitle()`,
   [`src/handlers/subtitles.js:810`](../src/handlers/subtitles.js)) is parsed as a real cue,
   so "TRANSLATION IN PROGRESS" stays on screen forever. **This is issue #139.**
2. **Timeouts.** TV OkHttp: connect 12s / read 15s / call 25s, 3 attempts, 350ms delay.
   Addon list fetch: 20s per addon. Mobile: sequential addon loop.
3. **Extras.** TV sends `videoHash/videoSize/filename` as ONE `&`-joined path segment:
   `/subtitles/movie/tt123/videoHash=x&videoSize=y&filename=z.json`.
   Mobile sends **no extras** at all.
4. **Language parsing.** TV `normalizeLanguageCode` = pt/es special cases + ISO639-2→1 override map;
   it cannot resolve `"Make Vietnamese"`. Mobile's fuzzy alias matcher CAN resolve it (suffix match).
5. **Detection hook.** TV API client sends `User-Agent: Nuvio/$version` on addon API calls
   (body downloads use a Chrome UA). Reliable server-side detection.
6. **`{{ADDON_URL}}` is a non-issue** — already replaced with absolute URLs by middleware in
   [`index.js`](../index.js) (~line 7888) before the JSON leaves the server.

### A1. P0 — Bounded synchronous translation for Nuvio (fixes #139)

- Add `isNuvioClient(req)` to [`src/utils/stremioClientIdentity.js`](../src/utils/stremioClientIdentity.js)
  (UA prefix `Nuvio/`), following the existing Kai-detection pattern.
- In [`index.js`](../index.js) where `waitForFullTranslation` is computed (~line 5186):
  `|| isNuvio`.
- In [`src/handlers/subtitles.js`](../src/handlers/subtitles.js):
  - Cap the Nuvio wait at **18–20s** (separate from `getMobileWaitTimeoutMs()` at line 1475,
    which clamps to 720s) so it fits inside Nuvio's 25s call timeout.
  - On timeout return best-available: final cache → partial cache
    (`readFromPartialCache` + `buildPartialSrtWithTail()` line 843) → error cue with retry hint.
    **Never** return `createLoadingSubtitle()` to Nuvio.
- Effect: first tap shows partial/translated subs; Nuvio's built-in 3-attempt retry (or user
  re-select) hits the warmed cache and gets the final translation.
- Risk: holds a translation slot up to 20s per cold request — already bounded by per-user
  concurrency limits (`canUserStartTranslation`).

### A2. P0 — Cross-client action names

- Official Stremio builds the left language/action column from `lang`, while `label` names only the
  selected variant. Preserve the original addon's `lang: "Make Vietnamese"` behavior so Make, Learn,
  xSync, Auto, xEmbed, and SMDB remain separate actions instead of ordinary language variants.
- Nuvio retains code-first tags such as `vi-Make` in `lang` and human-readable action IDs such as
  `Make Vietnamese`; its existing parser behavior is unchanged.
- **ponytail:** official Android clients may still render arbitrary action languages as blank/`und`.
  Revisit when Stremio exposes a separate action-group field or reliable client capability signal.

### A3. P1 — Extras normalization for NuvioTV

- **VERIFIED, no code change needed.** NuvioTV builds
  `/subtitles/{type}/{id}/videoHash=x&videoSize=y&filename=z.json` (one `&`-joined path segment,
  no `?`); SDK's [`getRouter.js`](../node_modules/stremio-addon-sdk/src/getRouter.js) already parses
  the last path segment via `qs.parse` (`:extra?.json` route param), so `args.extra` is populated
  natively. The addon's `normalizeSubtitleQueryExtras()` ([`index.js:118`](../index.js)) only needs
  to cover the query-string variant (`?filename=...`), which it already does. A clarifying comment
  was added there.
- NuvioMobile sends no extras: verified graceful degradation — xSync/xEmbed/SMDB/OS-hash entries
  are skipped when `videoHash` absent, filename-less search keeps working.

### A4. P1 — Search latency budget

- Nuvio list timeout 20s vs `SUBTITLE_SEARCH_HARD_TIMEOUT_MS` = 60s. When Nuvio is detected,
  use ~15s hard timeout and return partial provider results
  (`markPartialProviderResults()` already exists) instead of failing the whole list.

### A5. P2 — Delivery hygiene

- Serve translated SRT with `Content-Type: application/x-subrip; charset=utf-8`
  (TV's `mimeTypeFromUrl` defaults to SRT when URL has no extension; explicit charset helps parsers).
- Keep `.srt` URL extension on translate URLs (already configurable).

### A6. P2 — Upstream PRs to Nuvio (optional, high leverage)

- TV: re-poll a subtitle body once if it parses to a single ~4h cue / known placeholder text;
  accept `X (Make)`-style labels in `normalizeLanguageCode`.
- Mobile: send `videoHash/videoSize/filename` extras (parity with TV).

---

## B. Optimizations + GitHub issue triage (25 open)

| Issue | Problem | Fix | Where | Pri | Status |
|---|---|---|---|---|---|
| #139 | Nuvio shows "processing" forever | → A1 | subtitles.js, index.js | P0 | DONE |
| #154/#155 | Gemini keys starting `AQ.` rejected; deprecated models 404 | Accept `AQ.` prefix in key validation; remove/replace dead pinned model names | [`public/config.js`](../public/config.js) `validateGeminiApiKey`, [`src/utils/config.js`](../src/utils/config.js) | P0 | DONE |
| #149 | Background work hardcodes Gemini → 429 even when OpenRouter is primary | Route background/embedded tasks through configured primary provider; skip when provider absent | [`index.js`](../index.js) background paths, [`translationProviderFactory.js`](../src/services/translationProviderFactory.js) | P1 | DONE (SMDB/AutoSubs/embedded route through provider factory) |
| #146 | Slow translation | → section C speed | — | P1 | PARTIAL — ElfHosted parallel cap landed; entry cache still off by default |
| #144 | Gemini v3 models need `thinkingLevel`, not `thinkingBudget` | Per-model generation config mapping in [`gemini.js`](../src/services/gemini.js) | gemini.js | P1 | DONE (thinkingLevel wired through config/validation/factory) |
| #143 | Serbian charset corruption | Add Windows-1250/ISO-8859-2 heuristics + Latin/Cyrillic script-dominance validation to [`encodingDetector.js`](../src/utils/encodingDetector.js) | encodingDetector.js | P1 | DONE |
| #147 | Forced subs not flagged | Surface `forced` in lang label (`French (forced)`), keep flag in id | [`subtitleFlags.js`](../src/utils/subtitleFlags.js), subtitles.js | P2 | DONE — `isForcedSubtitle`/`inferForcedFromName` + `(forced)` label in entry builder |
| #141/#142/#150 | SubDL Cloudflare, OS.com quota, Wyzie rate limits | Exponential backoff + shared negative cache via [`rateLimitRedisStore.js`](../src/utils/rateLimitRedisStore.js); extend existing `providerAuthFailureCache` to 429s | subdl.js, opensubtitles*.js, wyzieSubs.js | P2 | open |
| #151 | Missing Make option in some flows | Preserve original human-readable action names in Stremio's `lang` grouping field | subtitles.js | P2 | DONE (fork) |
| #50 | `Unknown (und)` / blank Android action entries | Client protocol/UI conflict: ISO `lang` hides action identity; arbitrary `lang` may be blank on Android | [`subtitles.js`](../src/handlers/subtitles.js) | P2 | open upstream |
| #121 | Stremio Kai | Detection already exists (`x-stremio-kai` in stremioClientIdentity.js); verify/whitelist behavior | stremioClientIdentity.js | P2 | open |
| #117 | Embedded subs on Android | Client-side limitation — document, no addon fix | docs | P3 | — |
| #11 #16 #47 #52 #89 #123 #140 #148 #152 | Mixed config/UX | Triage individually | — | P3 | open |

Not issue-bound optimizations:
- Entry-level translation cache (`CACHE_TRANSLATIONS`) is off by default → enable it; repeat hits
  on popular titles (and Nuvio's retries) become instant.
- `deduplicateSearch()` LRU already exists — tune TTL only if metrics show churn.

---

## C. Translation speed & quality

### Speed (biggest levers first)

1. **Parallel batches on ElfHosted** — hard-disabled today
   ([`translationEngine.js:685`](../src/services/translationEngine.js): `process.env.ELFHOSTED !== 'true'`).
   Replace the blanket disable with capped concurrency (e.g. 2) against the shared key pool.
   Single biggest win for the public instance.
2. **JSON structured output** — default the `enableJsonOutput && thinkingBudget === 0` path for
   2.5-series models: faster parsing, fewer malformed-batch retries.
3. **Batch sizes** — `getBatchSizeForModel()` values (400/250/200) are reasonable; re-test
   flash-lite at 250 with JSON output.
4. **Key rotation** — rotate on first 429 immediately (health already shared via Redis).
5. **Optional pre-warm** — fire-and-forget warm translation of the top-ranked subtitle when the
   list endpoint is hit; makes A1's first tap near-instant. Config-gated (costs compute).
6. Streaming partials already implemented — keep.

### Quality

1. **Title/episode context in prompt** — `DEFAULT_TRANSLATION_PROMPT` in
   [`gemini.js`](../src/services/gemini.js) says only "Translate to {target_language}";
   `videoInfo` is already resolved in the handler, passing title context is cheap and measurably
   improves name/term consistency.
2. **Encoding fixes (#143)** — directly improves quality for non-UTF-8 sources.
3. **Ranking penalties** — penalize hearing-impaired/forced matches when not requested
   (pairs with #147) in `calculateFilenameMatchScore()` / `rankSubtitlesByFilename()`.
4. **Model guidance** — keep `gemini-flash-lite-latest` default (speed); document
   gemini-3-flash / pro for quality-focused self-hosters.
5. **Two-pass QA** — optional config flag, second cheap-model consistency pass. Off by default
   (latency/cost). Skip unless requested.

---

## Execution order

1. A1 + A2 — Nuvio P0, closes #139.
2. #154/#155 — key validation + model defaults (quick win).
3. A3 + A4 — Nuvio extras + search budget.
4. #149, #144, #143 — provider routing, v3 thinking, charset.
5. C-speed #1–2 — ElfHosted parallel cap + JSON output; enable entry cache.
6. P2 backlog — #147, #141/#142/#150, #50, A5, A6.

## Verification notes

- Simulate Nuvio: `curl -H "User-Agent: Nuvio/1.0" <addon>/translate/<id>/<lang>.srt` must return
  real or partial SRT within ~20s, never the loading placeholder.
- Official Stremio action responses must retain `{ lang: "Make Vietnamese" }` to create the language
  button; Nuvio keeps its `vi-Make` compatibility tag and `Make Vietnamese` ID.
- Follow the existing regression-test pattern
  ([`subtitles-timeout-regression.test.js`](../src/handlers/subtitles-timeout-regression.test.js)):
  cover action metadata, Nuvio labels, one nuvio-wait regression test, and one extras-normalization test.
