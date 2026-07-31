---
title: Session Flag Digest
type: feat
status: completed
date: 2026-07-29
origin: docs/brainstorms/2026-07-29-session-flag-digest.md
---

# Session Flag Digest

## Summary

Digest synthesis runs on demand behind a new `GET /api/sessions/:id/digest` endpoint, reusing the classifier's provider plumbing (extracted into a shared helper) with a new prompt, and caching results in a new `session_digests` table keyed by session and generation-time flag count. The frontend introduces this codebase's first polling pattern, scoped to sessions still receiving new turns, and the digest renders as a self-hiding widget alongside the existing tool-decision timeline rather than being wired inline into the page.

---

## Problem Frame

Sessions produced by unattended compound-engineering runs can accumulate ~300 flags with no natural review checkpoint, and the existing flat per-turn flag list gives a reviewer nothing to orient with before diving in. Full narrative, root-cause investigation, and product decisions are in the origin document — see [Sources & References](#sources--references).

---

## Requirements

- R1. When a session's total flag count meets or exceeds a flag-volume threshold, a session digest renders at the top of the session view, above the existing per-turn flag list.
- R2. When a session's flag count is below the threshold, the session view renders exactly as it does today, with no digest.
- R3. The digest condenses the session's flags into a small number of synthesized highlights (target: roughly a half-dozen), prioritizing higher-signal flag types (decision, risk, architecture, tradeoff, constraint) over routine or duplicate-looking flags.
- R4. The digest is read-only: it never sets or bulk-applies review status to any flag.
- R5. Each digest highlight is clickable and navigates the reviewer to the specific underlying flag(s) it summarizes in the full list below.
- R6. If a session is still actively receiving new turns and flags while the reviewer is viewing it, the digest reflects the newly-arrived flags rather than remaining a stale snapshot.

**Origin actors:** A1 (Reviewer), A2 (Digest synthesis)
**Origin flows:** F1 (Reviewing a large, already-finished session), F2 (Reviewing a session mid-run)
**Origin acceptance examples:** AE1 (covers R1, R2), AE2 (covers R1), AE3 (covers R6), AE4 (covers R5)

---

## Scope Boundaries

- Deterministic heuristic clustering of flags — not built here; tracked as [activtrak-mfinlayson/agent-feed#1](https://github.com/activtrak-mfinlayson/agent-feed/issues/1).
- Reducing flag volume or noise at the classifier/source — not built here; tracked as [activtrak-mfinlayson/agent-feed#2](https://github.com/activtrak-mfinlayson/agent-feed/issues/2).
- The digest never resolves, bulk-updates, or otherwise changes flag review status.
- No changes to how the compound-engineering skills run.
- The digest always summarizes the whole session; it does not respect the session view's per-model filter (confirmed during planning — see Key Technical Decisions).
- Introducing a frontend automated test framework (e.g., Vitest + Testing Library) is out of scope for this plan. The frontend currently has none; new components are verified manually per each unit's Verification section.

### Deferred to Follow-Up Work

- Establishing frontend automated test tooling: separate initiative, not scoped to this feature.

---

## Context & Research

### Relevant Code and Patterns

- `src/classifier/index.js` — `buildClassifier`/`validateClassifier` provider-branching pattern (Anthropic vs. OpenAI-compatible `ollama`/`lmstudio`) to extend for digest synthesis.
- `src/pipeline.js` — existing per-turn capture → classify → store flow; confirms there is no session-level aggregation today, motivating the on-demand endpoint approach.
- `src/storage/database.js` — `SCHEMA` constant and transaction-wrapped, `pragma table_info`-guarded migration pattern (`Database.init()`); `getSessionFlagCounts()` shows the existing all-flags-regardless-of-review-status counting convention to mirror.
- `src/ui/server.js` — `eventsMatch`/`toolDecMatch` regex-route + `json(res, status, body)` handler pattern for the new digest route.
- `src/ui/frontend/src/components/sessions/tool-decision-timeline.tsx` and `hook-activity.tsx` — self-hiding widget convention (`if (!data) return null`) to mirror for `SessionDigest`.
- `src/ui/frontend/src/components/sessions/turn-block.tsx` and `src/ui/frontend/src/components/flags/flag-card.tsx` — current per-flag rendering and local `expandedFlagId` state that click-through needs to lift or reach into.
- `src/ui/frontend/src/hooks/use-session.ts`, `use-flag-mutations.ts` — TanStack Query conventions (`useQuery`/`useMutation` + `invalidateQueries`) to follow for the new digest hook.
- `src/ui/frontend/src/main.tsx` — global `QueryClient` defaults (`staleTime: 30_000`, `refetchOnWindowFocus: true`); the digest query needs to override `staleTime` given it introduces polling.

### Institutional Learnings

- No `docs/solutions/` directory exists in this repo. Relevant conventions instead pulled directly from code/commit history: migrations must run inside `Database.init()`'s single transaction with `pragma table_info` guards (see commit `d3883c0`); fire-and-forget LLM calls must log failures via `console.error`, never a bare `catch {}` (see commit `5b3889c`).
- No existing LLM-call caching/dedup pattern and no existing frontend polling pattern — both are genuinely new ground for this codebase (confirmed via research, not an extension of prior art).

### External References

- None used — local patterns for REST routing, SQLite migrations, and TanStack Query usage were strong enough (3+ direct examples each) that external research was skipped. The two genuinely novel pieces (LLM-output caching strategy, first frontend polling pattern) are addressed as explicit Key Technical Decisions below rather than via external research, since both are well-understood, low-risk applications of existing library features (TanStack Query's `refetchInterval`) rather than open technical unknowns.

---

## Key Technical Decisions

- **On-demand generation via a new endpoint, not pipeline-embedded**: `src/pipeline.js` only ever sees one turn at a time and has no session-aggregation capability today; adding a `GET /api/sessions/:id/digest` handler keeps session-level synthesis entirely out of the capture path.
- **Regeneration triggers on flag-count mismatch, no incremental updates**: the endpoint compares the session's live flag count to `flag_count_at_generation` on the cached row and fully re-synthesizes when they differ. Simplest correct approach; accepted tradeoff is a full re-synthesis call for every new flag during an active run rather than a cheaper incremental update.
- **Threshold counts every flag regardless of review status; digest persists once rendered**: matches the existing `getSessionFlagCounts()` convention of counting all flags. Once a digest has been generated for a session, it is not hidden again just because later review drops the reviewed-remaining count below threshold — avoids the digest flickering in and out during a review pass.
- **Digest ignores the session view's model filter**: always synthesizes over the whole session. Confirmed with the user during planning — a per-filter cache would require a separate cached variant per filter value, adding complexity for a feature mainly aimed at the common single-model case.
- **Extract shared LLM-call plumbing from `buildClassifier`**: rather than duplicating the provider-branching request/response logic a second time for digest synthesis, extract it into a reusable helper used by both `buildClassifier` and a new `buildDigestSynthesizer`.
- **New `session_digests` table, not a column on `records`/`flags`**: the digest is session-scoped with no single natural owning row; a new table keyed by `session_id` follows the existing table-per-concept convention (`records`/`flags`/`events`).
- **Generation failure returns a defined "unavailable" state, not an error thrown to the client**: no `session_digests` row is written on failure; the client shows an inline "digest unavailable" note and retries on the next poll tick or page view. No separate background retry loop.
- **Highlights are validated against real flag IDs server-side before caching**: any highlight whose referenced flag ID(s) don't match the session's actual flags is dropped. If zero highlights survive validation, the generation is treated as a failure (per the point above), not an empty-but-successful digest.
- **"Active session" is derived from the digest response itself, not from `useSession`**: `useSession` has no polling and can go stale while a tab stays focused (only window-refocus or a flag mutation triggers a refetch), so deriving liveness from it would let the digest's polling silently stop while the session is still genuinely active. Instead, the digest endpoint computes the session's live latest-turn timestamp fresh on every request and returns it alongside the highlights; the frontend derives "still receiving turns" from that field. The hook always performs at least one fetch on mount regardless of perceived activity, to bootstrap this signal.
- **No frontend test framework is introduced**: `src/ui/frontend` has no automated test tooling today (no Vitest, no test files). New frontend units are verified manually; see each unit's Verification section for the specific checks.
- **Digest synthesizer inherits the classifier's already-resolved provider config**: `buildDigestSynthesizer` is built from the same post-fallback `effectiveConfig` `App.start()` already resolved for `classifierFn` (see `validateClassifierWithFallback`), not a freshly-validated config. A developer running a local-only classifier (Ollama/LM Studio) is not silently exposed to a different provider via the digest path; the `digest.model` config option (when set) only overrides the model name within that same resolved provider/base_url.
- **Reviewed highlights are greyed out client-side, not excluded from regeneration**: since regeneration triggers only on flag-count change (not review-status change — see above), a highlight can otherwise keep looking "significant" long after its underlying flag(s) are all marked reviewed. Rather than adding review status to the regeneration trigger (which would reintroduce per-review-action regeneration cost), `SessionDigest` compares each highlight's referenced flag IDs against the already-available flag review statuses (from `useSession`) and visually de-emphasizes any highlight whose flags are all reviewed — a client-only, no-cost fix.
- **Digest route requires a same-origin request before triggering synthesis**: unlike existing PATCH routes (implicitly protected by CORS preflight) and existing side-effect-free GET routes, this is the first GET route whose side effect includes a billed outbound LLM call and a DB write. A page open in the same browser could otherwise fire a simple cross-origin GET at it. The handler requires the request's `Sec-Fetch-Site` header to be `same-origin` (or absent — covers non-browser clients like `curl`, tests, and the CLI) before it will read live flag counts or trigger synthesis; a cross-site browser request is rejected before doing any work.

---

## Open Questions

### Resolved During Planning

- On-demand vs. pipeline-embedded synthesis: on-demand via a new endpoint (see Key Technical Decisions).
- Model filter interaction: digest always covers the whole session, confirmed with the user.
- Threshold accounting and persistence: counts all flags regardless of review status; digest, once shown, stays shown.
- Regeneration trigger: flag-count mismatch, full re-synthesis, no incremental update.
- Generation failure handling: defined "unavailable" state, retried passively on next poll/view, no background retry loop.
- Empty/degenerate synthesis output: server-side validation against real flag IDs; zero-valid-highlights counts as a failure.
- Single-session flag-count query: add a dedicated query (`getFlagCountForSession`) rather than reusing the all-sessions `getSessionFlagCounts()` (see U1, resolved during doc review).
- Digest synthesizer provider config: inherits the classifier's already-resolved `effectiveConfig` rather than a fresh validation pass (see Key Technical Decisions, resolved during doc review).

### Deferred to Implementation

- [Needs research] Starting values for the digest flag-volume threshold and the "active session" time window — implement as tunable config (`digest.flag_threshold`, `digest.active_window_minutes`) with reasonable defaults (e.g. 20 flags / 10 minutes), to be adjusted once real large sessions are reviewed against it.
- [Technical] Exact digest synthesis prompt wording and the mechanism for keeping highlight count near "a half-dozen" — will need iteration once tested against real ~300-flag sessions.
- [Technical] Whether to cap or sample the flags sent to the synthesis prompt for extremely large sessions (1000+ flags) to bound prompt size and cost — not needed at the ~300-flag scale motivating this plan; revisit if sessions grow substantially larger.
- [Technical] Exact response contract for a below-threshold session's digest request (e.g., 404 vs. a `{status: "below_threshold"}` 200 body) — pick whichever is more consistent with the endpoint's other-error-shapes during implementation.
- [Technical] Exact duration for the temporary highlight ring's auto-clear timeout (e.g., 3s vs. 5s) — pick a value during implementation and adjust if it feels too fast/slow in manual testing.

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

```mermaid
sequenceDiagram
    participant UI as SessionDigest (frontend)
    participant API as GET /api/sessions/:id/digest
    participant DB as session_digests table
    participant LLM as Digest synthesizer

    UI->>API: fetch (on mount, then on interval while session active)
    API->>API: reject if Sec-Fetch-Site is cross-site
    API->>DB: read cached digest + live flag count + latest turn timestamp
    alt no cached digest, or flag count changed
        API->>LLM: synthesize(flags for session)
        LLM-->>API: highlights (flag id references)
        API->>API: drop highlights with invalid flag id refs
        alt zero valid highlights
            API-->>UI: unavailable
        else
            API->>DB: upsert digest + flag_count_at_generation
            API-->>UI: highlights + latest_turn_at
        end
    else cached digest is current
        API-->>UI: cached highlights + latest_turn_at
    end
    UI->>UI: render highlights, or self-hide if below threshold; derive next-poll activity from latest_turn_at
```

Click-through (R5) is a separate, purely frontend concern: a highlight click needs to reach a specific `FlagCard` that today only knows about its own expand/collapse state, scoped inside `TurnBlock`. That state (or a scroll-target signal) needs to move up to `SessionDetail`, which already owns everything else the digest and turn list both need.

---

## Implementation Units

### U1. Digest storage: schema and persistence

**Goal:** Durable, session-scoped cache for synthesized digest content, with a staleness signal based on flag count.

**Requirements:** R1, R2, R6

**Dependencies:** None

**Files:**
- Modify: `src/storage/database.js`
- Test: `test/migrations.test.js`
- Test: `test/storage.test.js`

**Approach:**
- Add a `session_digests` table to the `SCHEMA` constant, guarded by `CREATE TABLE IF NOT EXISTS` (new table, no `ALTER TABLE` backfill needed).
- Add `getSessionDigest(sessionId)` and `saveSessionDigest(sessionId, {...})` methods following the existing plain-prepared-statement style used by `getTrends`/`getSessionFlagCounts`. `saveSessionDigest` upserts on the session's primary key.
- Add a single-session flag-count query (e.g. `getFlagCountForSession(sessionId)`) rather than reusing the all-sessions `getSessionFlagCounts()` — avoids aggregating across the entire `flags` table on every digest poll.

**Patterns to follow:**
- `src/storage/database.js` `SCHEMA` constant and `Database.init()`'s transaction-wrapped migration guard.
- `test/migrations.test.js` — fresh-DB shape, idempotent re-init, and legacy-DB backfill test structure.

**Test scenarios:**
- Happy path: fresh `Database.init()` creates the `session_digests` table with the expected columns.
- Happy path: `saveSessionDigest` then `getSessionDigest` round-trips content correctly.
- Happy path: saving a digest twice for the same session upserts rather than erroring or duplicating.
- Edge case: `getSessionDigest` for a session with no saved digest returns a clean empty result, not an error.
- Edge case: calling `Database.init()` twice does not fail or duplicate the table (mirrors existing migration idempotency tests).

**Verification:**
- `test/migrations.test.js` and `test/storage.test.js` pass, covering fresh-DB, idempotent-reinit, and round-trip read/write behavior for `session_digests`.

---

### U2. Digest synthesis function

**Goal:** A classifier-layer function that turns a session's flags into a small set of validated, highlight-worthy summaries.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/classifier/index.js`
- Test: `test/digest-synthesizer.test.js`

**Approach:**
- Extract the provider-branching request-building and response-parsing logic currently inline in `buildClassifier` into a shared helper, then add `buildDigestSynthesizer(config, fetchFn)` that reuses it with a new prompt constant and a different expected response shape (a small array of highlights, each referencing one or more flag IDs from the input).
- Input is the session's flags reduced to `{id, type, content, confidence}` (not the full `context` text) to keep the prompt bounded even at ~300 flags.
- Prioritizes decision/risk/architecture/tradeoff/constraint types over routine/duplicate-looking flags, per R3 — expressed as prompt guidance, not a hard filter (the synthesizer decides significance; the endpoint in U3 only validates that referenced IDs are real).

**Technical design:** *(directional, not implementation-ready)*

```
buildDigestSynthesizer(config, fetchFn):
  returns async synthesize(flags: [{id, type, content, confidence}]) -> { highlights: [{summary, flag_ids: [...]}] }
```

**Patterns to follow:**
- `src/classifier/index.js` `buildClassifier`, `parseClassifierResponse` — provider branching and malformed-response-to-empty-result handling.
- `test/classifier.test.js` — mock-fetch test construction for both Anthropic and OpenAI-compatible provider shapes.

**Test scenarios:**
- Happy path: given mock flags and a mocked Anthropic-shaped response, `synthesize()` returns parsed highlights.
- Happy path: same, mocked against an OpenAI-compatible (`ollama`/`lmstudio`) response shape.
- Edge case: empty flags array input returns an empty highlight set without calling the provider.
- Error path: mocked fetch returns a non-ok response — synthesizer returns an empty/failure result rather than throwing.
- Error path: mocked provider returns malformed/non-JSON text — result is empty highlights, not a thrown error (mirrors `parseClassifierResponse`'s catch-to-empty behavior).

**Verification:**
- `test/digest-synthesizer.test.js` passes; no network calls made during tests (all fetch calls mocked, consistent with `test/classifier.test.js`).

---

### U3. Digest API endpoint and wiring

**Goal:** A `GET /api/sessions/:id/digest` endpoint that orchestrates staleness-checking, regeneration, validation, and caching, and is reachable from the running daemon.

**Requirements:** R1, R2, R4, R6

**Dependencies:** U1, U2

**Files:**
- Modify: `src/ui/server.js`
- Modify: `src/app.js`
- Modify: `src/config.js`
- Test: `test/ui.test.js` (or new `test/ui-digest-routes.test.js` if the route group grows large, mirroring how OTel routes got their own file)

**Approach:**
- Add a `digest` config section (`enabled`, `flag_threshold`, `active_window_minutes`, optional `model` override) to `defaultConfig` in `src/config.js`.
- `App.start()` builds a digest synthesizer function (via U2) from the classifier's already-resolved `effectiveConfig` (see Key Technical Decisions), alongside the existing `classifierFn`, and passes it into `createUIServer(...)`, since `createUIServer` currently only receives `db`.
- The route handler first checks `Sec-Fetch-Site` is `same-origin` or absent (see Key Technical Decisions), rejecting cross-site requests before any other work. It then reads the session's live flag count and cached digest row; if below threshold, returns the below-threshold contract (see Open Questions); if no cached digest or flag count changed, calls the synthesizer, validates returned highlights' flag IDs against the session's real flags (drop invalid ones), and on success upserts via U1 and returns the highlights — on failure or zero valid highlights, returns the "unavailable" shape without writing a cache row. Every successful response (cached or freshly generated) includes the session's live latest-turn timestamp, computed fresh on each request, so the frontend's activity signal (U4) never depends on a separately-cached query.
- Failures inside the synthesis call are caught and logged (`console.error`), never swallowed silently, consistent with the fire-and-forget-but-logged convention already used for the per-turn classifier.

**Patterns to follow:**
- `src/ui/server.js` `eventsMatch`/`toolDecMatch` route + `json(res, status, body)` handler shape, including `safeJsonParse` for the stored JSON `content` column.
- `src/app.js` existing `classifierFn` construction and `createUIServer({ db: this._db })` call site.

**Test scenarios:**
- Happy path: session at/above threshold with no prior digest triggers synthesis and returns 200 with highlights.
- Happy path: session with a current cached digest (flag count matches) returns cached content without invoking the synthesizer (assert via a call-counting mock).
- Happy path: session whose live flag count has grown since the cached generation triggers regeneration and returns updated content.
- Edge case: session below threshold returns the defined below-threshold response, without attempting synthesis.
- Error path: synthesizer returns/throws a failure — endpoint returns the "unavailable" shape (200, not 500) and does not write a cache row.
- Error path: unknown `session_id` returns 404, consistent with the other `/api/sessions/:id/*` routes.
- Error path: a request with a cross-site `Sec-Fetch-Site` header is rejected before any flag count is read or synthesis is attempted.
- Integration: seeding real flags via `db.insertFlag` past the threshold and calling the endpoint end-to-end (no synthesizer mock bypass) exercises the full read/generate/save round trip through U1 and U2.

**Verification:**
- New/extended route tests pass under the existing `createUIServer({ db })`-on-port-0 test harness pattern.
- Existing tests that construct `createUIServer(...)` directly (`test/ui.test.js`, `test/ui-otel-routes.test.js`, `test/trends.test.js`) still pass after the constructor signature gains the digest dependency.

---

### U4. Frontend digest fetch and display

**Goal:** Render the digest above the flag list, self-hiding when not applicable, and keeping it current while the session is still active.

**Requirements:** R1, R2, R3, R4, R6

**Dependencies:** U3

**Files:**
- Create: `src/ui/frontend/src/hooks/use-session-digest.ts`
- Create: `src/ui/frontend/src/components/sessions/session-digest.tsx`
- Modify: `src/ui/frontend/src/api/client.ts`
- Modify: `src/ui/frontend/src/api/types.ts`
- Modify: `src/ui/frontend/src/components/sessions/session-detail.tsx`

**Approach:**
- `use-session-digest.ts` wraps a `useQuery` keyed `["digest", sessionId]`, always fetching at least once on mount. `refetchInterval` is computed from the *digest response's own* `latest_turn_at` field (not from `useSession`'s cached data — see Key Technical Decisions) falling within the configured active window; polling stops once the session goes quiet. Overrides the global `staleTime: 30_000` default since this query needs fresher data while active.
- `SessionDigest` follows the self-hiding widget convention already used by `ToolDecisionTimeline`/`HookActivity`/`MCPHealth` for the below-threshold case (renders nothing), but distinguishes that from an explicit loading/pending render ("synthesizing digest...") while the first fetch is in flight, and an "unavailable" state on failure that includes a manual retry button — clicking it fires a one-off refetch regardless of the active-window heuristic, so a session that's gone quiet since its last failed generation isn't permanently stuck.
- Each highlight is cross-referenced against the review status of the flags it references (from the same `useSession` data already used elsewhere on the page); a highlight whose flags are all reviewed renders visually de-emphasized rather than looking equally "significant" as an unreviewed one (see Key Technical Decisions).
- Mounted in `session-detail.tsx` alongside the existing OTel-derived widgets.

**Patterns to follow:**
- `src/ui/frontend/src/components/sessions/tool-decision-timeline.tsx` — self-hiding widget + `useQuery` shape.
- `src/ui/frontend/src/hooks/use-session.ts` — existing session-scoped hook conventions.

**Test scenarios:**
*No automated frontend test harness exists in this repo (no Vitest/Testing Library configured, no existing frontend test files) — see Scope Boundaries. The following are manual verification scenarios, not automated tests:*
- Happy path (manual): session below threshold shows no digest section; page is visually identical to today.
- Happy path (manual): session above threshold shows a loading state briefly, then the digest section above the flag list.
- Edge case (manual): a session whose digest generation failed shows the inline "unavailable" note with a retry button, not a blank space or a crash.
- Edge case (manual): clicking the retry button in the "unavailable" state fires a new fetch even if the session's latest turn is outside the active window.
- Integration (manual): while viewing an above-threshold session with a recent latest turn, capturing new flags causes the digest to visibly update without a manual page reload, even if the tab stays focused the whole time and no flag is manually reviewed.
- Integration (manual): once the session's latest turn falls outside the active window, no further digest network requests fire (verify via browser dev tools).
- Edge case (manual): a highlight whose referenced flag(s) have all been marked reviewed (e.g. false positive) renders visually de-emphasized rather than looking equally significant as an unreviewed highlight.

**Verification:**
- `npm run build` (in `src/ui/frontend/`) passes with no type errors.
- Manual scenarios above confirmed against a real running daemon with a seeded large session.

---

### U5. Digest click-through to underlying flags

**Goal:** Clicking a digest highlight navigates the reviewer to the flag(s) it summarizes.

**Requirements:** R5

**Dependencies:** U4

**Files:**
- Modify: `src/ui/frontend/src/components/sessions/session-detail.tsx`
- Modify: `src/ui/frontend/src/components/sessions/turn-block.tsx`
- Modify: `src/ui/frontend/src/components/flags/flag-card.tsx`
- Modify: `src/ui/frontend/src/components/sessions/session-digest.tsx`

**Approach:**
- Lift expand/scroll-target state currently local to `TurnBlock` (`expandedFlagId`) up to `SessionDetail`, which already owns the data both the digest and the turn list need. Lift it as a keyed structure (e.g. a `Set` of expanded flag IDs, or a map from record ID to expanded flag ID), not a single scalar — today, each `TurnBlock` independently tracks its own expanded flag, so a reviewer can have different flags expanded in different turns at once; a single shared scalar would collapse that into "only one flag expanded across the whole session," a regression the click-through feature must not introduce.
- On highlight click: scroll to and expand the first referenced flag, moving DOM focus to that flag's interactive element (or its container via `tabindex=-1`) so keyboard and screen-reader users get a clear indication of where they landed, not just a visual scroll. The highlight trigger itself is a focusable, keyboard-activatable button, consistent with `FlagCard`'s own button-based rows. Apply a temporary highlight ring to any other referenced flags currently rendered in the DOM. The ring clears after a few seconds, or immediately on the next highlight click, whichever comes first, and is paired with an `aria-live` announcement naming how many additional flags were matched — so the multi-flag case is perceivable non-visually, not only as a visual ring.
- If a referenced flag's turn is hidden by the session view's active model filter, show a toast with an action button (sonner supports toast actions, per `use-flag-mutations.ts`) that clears the model filter and retries the scroll/expand, rather than a passive notice with no path forward.

**Patterns to follow:**
- `src/ui/frontend/src/components/sessions/turn-block.tsx` current `expandedFlagId` local state, to be lifted.
- `src/ui/frontend/src/components/flags/flag-card.tsx` `TYPE_COLOR`/styling conventions, for the temporary highlight-ring treatment.

**Test scenarios:**
*Manual verification — see U4's note on the absence of a frontend test harness.*
- Happy path (manual): clicking a highlight scrolls to and expands its first underlying flag, moving keyboard focus there.
- Edge case (manual): expanding a flag via a digest highlight does not collapse an already-expanded flag in a different turn.
- Edge case (manual): a highlight representing multiple flags visually rings all currently-rendered matches, not just the first, and the ring clears after a few seconds or on the next highlight click.
- Edge case (manual): clicking a highlight whose flag is hidden by the active model filter shows a toast with a "clear filter" action that completes the navigation when clicked.
- Edge case (manual, accessibility): a screen reader announces the multi-flag match count when a highlight rings more than one flag, and reading order lands on the expanded flag after a click-through, not on the highlight trigger.

**Verification:**
- Manual scenarios above confirmed against a real running daemon with a seeded large, multi-model session.

---

## System-Wide Impact

- **Interaction graph:** `createUIServer(...)`'s constructor signature gains a digest dependency; `App.start()` is the only production caller, but test files that construct `createUIServer(...)` directly (`test/ui.test.js`, `test/ui-otel-routes.test.js`, `test/trends.test.js`) need to keep working once the signature changes.
- **Error propagation:** Digest synthesis failures must resolve to a defined "unavailable" response, not a thrown 500 — the endpoint is synchronously awaited by the UI, unlike the existing fire-and-forget per-turn classifier call.
- **State lifecycle risks:** None beyond normal cache staleness — flags are append-only in this system (no delete path), so `session_digests` never needs cleanup beyond the count-mismatch regeneration already designed.
- **API surface parity:** None — no other interface (CLI, eval) currently surfaces flags in aggregate; no parity concern.
- **Integration coverage:** The end-to-end "seed flags past threshold → GET digest → add more flags → GET digest again → content reflects the new flags" path (U3's integration test scenario) is the one behavior mocks alone would not prove.
- **Unchanged invariants:** Existing per-flag review endpoints (`PATCH /api/flags/:id`, `/bulk`) and existing session/records/flags read endpoints are untouched — the digest is strictly additive.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LLM synthesis cost/latency on every regeneration, since there's no incremental update | Staleness check (flag-count comparison) avoids redundant regeneration when nothing changed; revisit flag-count capping/sampling only if sessions grow well beyond the ~300-flag scale motivating this plan |
| Hallucinated or stale flag ID references from the synthesis output | Server-side validation drops any highlight referencing a non-existent flag; zero-valid-highlights is treated as a failure, not a false-empty success |
| First polling pattern in this frontend could poll indefinitely against an abandoned session | Active-window heuristic bounds polling to sessions with a recent latest turn; polling stops once the window is exceeded |
| No frontend test harness means regressions in `SessionDigest`/click-through are only caught manually | Explicit manual verification scenarios per unit (U4, U5); establishing automated frontend testing is called out as separate follow-up work |
| Two overlapping requests for the same session (two tabs, or a poll landing just before a slow synthesis call returns) can each see a stale cached count and both trigger a full regeneration | Accepted, low-cost tradeoff: no in-process locking is added — the upsert on `session_digests` is idempotent, so the worst case is a duplicate LLM call, not incorrect data |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-29-session-flag-digest.md](../brainstorms/2026-07-29-session-flag-digest.md)
- Related code: `src/pipeline.js`, `src/classifier/index.js`, `src/storage/database.js`, `src/ui/server.js`, `src/ui/frontend/src/components/sessions/`
- Related issues: [activtrak-mfinlayson/agent-feed#1](https://github.com/activtrak-mfinlayson/agent-feed/issues/1) (deterministic clustering), [activtrak-mfinlayson/agent-feed#2](https://github.com/activtrak-mfinlayson/agent-feed/issues/2) (classifier-side volume reduction)
