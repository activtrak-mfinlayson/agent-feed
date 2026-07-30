---
date: 2026-07-29
topic: session-flag-digest
---

# Session Flag Digest

## Summary

Add a synthesized digest at the top of large sessions that condenses hundreds of flags into a handful of the most significant highlights, each linking through to the full flag detail below. The digest only appears once a session crosses a flag-volume threshold, is read-only, and doesn't change how any individual flag is reviewed.

---

## Problem Frame

Agent Feed's session view renders one row per classified flag, grouped under the turn that produced it. This works well for an ordinary session reviewed shortly after each turn. It breaks down for sessions produced by running the compound-engineering pipeline (brainstorm → plan → work) unattended end-to-end: dozens of turns run without a checkpoint, and the reviewer comes back to a single session with roughly 300 flags stacked in one flat, scrolling list.

At that volume, the reviewer's own report is that they wouldn't open the review at all — the wall of rows is enough to make them give up before starting, even though the existing per-flag interaction (type badge, one-line content, confidence, one-click accept / needs change / false positive) is exactly what they want to use once they're actually looking at something small enough to read. The problem isn't the review interaction itself; it's that nothing helps a reviewer get oriented before diving into hundreds of individually-presented rows. Investigation also surfaced that the ~300 figure is a mix of genuinely distinct flags and noisier, more repetitive ones — but fixing flag volume at the source is a separate, harder initiative (see Scope Boundaries) and doesn't remove the need for a better way to review whatever volume of flags a session ends up with.

---

## Actors

- A1. Reviewer: the person reviewing a captured session's flags in the Agent Feed UI.
- A2. Digest synthesis: the backend process that generates and maintains the session digest from the session's flags.

---

## Key Flows

- F1. Reviewing a large, already-finished session
  - **Trigger:** Reviewer opens a session whose flag count is at or above the digest threshold.
  - **Actors:** A1, A2
  - **Steps:** A2 has synthesized (or synthesizes on first view) a digest from the session's flags. A1 sees the digest above the full flag list. A1 clicks a digest highlight. The view navigates to the underlying flag(s) it represents. A1 reviews those flags — or any others — individually via the existing accept / needs change / false positive controls, unchanged from today.
  - **Outcome:** A1 gets oriented to what's significant in the session without first scanning the full flat list, while every flag remains individually reviewable exactly as before.
  - **Covered by:** R1, R3, R4, R5

- F2. Reviewing a session mid-run
  - **Trigger:** Reviewer opens a session while a compound-engineering run is still actively producing new turns and flags.
  - **Actors:** A1, A2
  - **Steps:** A1 opens the session and sees the digest as it currently stands. New turns continue arriving and get classified into new flags. A2 updates the digest to reflect the newly-arrived flags. A1 sees the digest change rather than working from a stale snapshot taken when the page first loaded.
  - **Outcome:** The digest stays representative of the session's current state even while the underlying run is unattended and still in progress.
  - **Covered by:** R1, R6

---

## Requirements

**Digest trigger**
- R1. When a session's total flag count meets or exceeds a flag-volume threshold, a session digest renders at the top of the session view, above the existing per-turn flag list.
- R2. When a session's flag count is below the threshold, the session view renders exactly as it does today, with no digest.

**Digest behavior**
- R3. The digest condenses the session's flags into a small number of synthesized highlights (target: roughly a half-dozen), prioritizing higher-signal flag types (decision, risk, architecture, tradeoff, constraint) over routine or duplicate-looking flags.
- R4. The digest is read-only: it never sets or bulk-applies review status to any flag. The existing per-flag review actions and existing bulk actions on unreviewed flags are unaffected by the digest's presence.
- R5. Each digest highlight is clickable and navigates the reviewer to the specific underlying flag(s) it summarizes in the full list below.
- R6. If a session is still actively receiving new turns and flags while the reviewer is viewing it, the digest reflects the newly-arrived flags rather than remaining a stale snapshot from when the page was first opened.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a session with a flag count below the digest threshold, when the reviewer opens the session, the view renders with no digest section, identical to today's behavior.
- AE2. **Covers R1.** Given a session with a flag count at or above the digest threshold, when the reviewer opens the session, a digest section renders above the full flag list.
- AE3. **Covers R6.** Given a session already showing a digest, when additional turns arrive and produce new flags while the reviewer has the session open, then the digest updates to include the new flags without requiring a full page reload.
- AE4. **Covers R5.** Given a rendered digest, when the reviewer clicks a digest highlight, then the view navigates to the underlying flag(s) that highlight summarizes.

---

## Success Criteria

- A reviewer opening a session with hundreds of flags can orient themselves via a handful of digest highlights instead of confronting a flat wall of rows, and no longer abandons the review outright.
- Sessions below the digest threshold are visually and functionally unchanged from today.
- A downstream planner can implement without inventing: what triggers the digest, whether it mutates review state (it doesn't), whether it links into flag-level detail (it does), and whether it must track new flags arriving live (it must).

---

## Scope Boundaries

- Deterministic heuristic clustering of flags (grouping by type/turn/similarity into collapsible rows without a synthesis pass) — not built here; tracked as [activtrak-mfinlayson/agent-feed#1](https://github.com/activtrak-mfinlayson/agent-feed/issues/1).
- Reducing flag volume or noise at the classifier/source — not built here; tracked as [activtrak-mfinlayson/agent-feed#2](https://github.com/activtrak-mfinlayson/agent-feed/issues/2), since it's a distinct precision/recall tuning initiative with its own existing eval harness (`agent-feed eval classifier`).
- The digest never resolves, bulk-updates, or otherwise changes flag review status — reviewing remains entirely flag-by-flag as it is today.
- No changes to how the compound-engineering skills run (e.g., adding pause checkpoints between brainstorm/plan/work) — Agent Feed remains a passive observer of session activity; this only changes how a session's flags are reviewed after (or during) the fact.

---

## Key Decisions

- Digest is read-only rather than an accept/reject-at-the-digest-level shortcut: flag-level review stays unambiguous and complete: scanning effort is what's reduced, not review coverage.
- Digest is threshold-gated rather than always-on: a digest over a handful of flags adds no value and would just be more content to read.
- Digest must reflect flags arriving during an in-progress session rather than only a one-time snapshot: the unattended, multi-phase compound-engineering run is exactly the scenario motivating this feature, and reviewers may check in while it's still running.

---

## Dependencies / Assumptions

- Assumes a session-level synthesis/summarization pass can be added alongside the existing per-turn classifier call; the exact mechanism, and whether/how its output is cached, is left to planning.
- Assumes the flag-volume threshold is a tunable value rather than fixed by this doc; the starting number is a planning/tuning decision.
- Assumes the digest respects the same model filter already available on the session view (if a session spans multiple models and the reviewer has filtered to one) — not explicitly confirmed with the user, low-risk default.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R2][Needs research] What's the right starting flag-volume threshold for the digest to activate?
- [Affects R6][Technical] What's the mechanism for detecting newly-arrived flags and refreshing the digest — polling, invalidate-on-write, incremental update, or full regeneration?
- [Affects R3][Technical] What generates the digest content (e.g., an additional LLM synthesis call over the session's flags) and how its cost/latency is managed for very large sessions.
