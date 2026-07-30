import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Record } from "@/api/types";

// How long a digest highlight's "ring" stays on additional matched flags
// before auto-clearing (also cleared immediately by the next highlight click).
const RING_DURATION_MS = 3500;

interface UseHighlightNavigationOptions {
  sessionId: string;
  modelFilter?: string;
  allRecords: Record[] | undefined;
  // Lets a highlight click clear the active model filter when the flag it
  // targets is hidden by it.
  onClearModelFilter?: () => void;
}

// Owns the "click a digest highlight, land on the real flag(s) it
// summarizes" mechanism: which flags are expanded, which are temporarily
// "ringed", a screen-reader announcement for multi-flag matches, and the
// toast-driven retry when the target flag is hidden by the model filter.
//
// Expand state is a Set, not a single scalar: each TurnBlock used to own its
// own expand state independently, so a reviewer could have different flags
// expanded in different turns simultaneously. Collapsing that into one
// shared scalar would regress it into "only one flag expanded across the
// whole session" — a Set preserves today's per-turn-independent behavior
// while still letting a highlight target one specific flag ID anywhere in
// the session.
export function useHighlightNavigation({
  sessionId,
  modelFilter,
  allRecords,
  onClearModelFilter,
}: UseHighlightNavigationOptions) {
  const [expandedFlagIds, setExpandedFlagIds] = useState<Set<string>>(new Set());
  const [ringingFlagIds, setRingingFlagIds] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");

  // flagId -> interactive DOM element, populated via FlagCard's registerRef
  // (threaded through TurnBlock). Lets a highlight click scroll to and focus
  // a specific flag regardless of which turn renders it.
  const flagRefs = useRef<Map<string, HTMLElement>>(new Map());
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A flag ID a highlight click wants scrolled-to-and-focused as soon as its
  // DOM element registers. Only needed for the "newly expanding" case —
  // expanding a not-yet-expanded flag always swaps FlagCard's collapsed
  // subtree for its expanded one, so a fresh ref attach is guaranteed to
  // follow. Consumed directly by registerFlagRef below; no separate effect.
  const pendingScrollIdRef = useRef<string | null>(null);
  // A highlight click's full flag_ids, held here while waiting for the model
  // filter to clear so the target flag becomes renderable.
  const pendingNavFlagIdsRef = useRef<string[] | null>(null);

  const registerFlagRef = useCallback((flagId: string, el: HTMLElement | null) => {
    if (el) {
      flagRefs.current.set(flagId, el);
      if (pendingScrollIdRef.current === flagId) {
        pendingScrollIdRef.current = null;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
      }
    } else {
      flagRefs.current.delete(flagId);
    }
  }, []);

  const toggleFlag = useCallback((flagId: string) => {
    setExpandedFlagIds((prev) => {
      const next = new Set(prev);
      if (next.has(flagId)) next.delete(flagId);
      else next.add(flagId);
      return next;
    });
  }, []);

  // Reset all click-through state when switching sessions, mirroring the
  // old per-TurnBlock behavior where expand state never carried over.
  useEffect(() => {
    setExpandedFlagIds(new Set());
    setRingingFlagIds(new Set());
    setAnnouncement("");
    pendingNavFlagIdsRef.current = null;
    pendingScrollIdRef.current = null;
    flagRefs.current.clear();
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  }, [sessionId]);

  function isFlagFilteredOut(flagId: string): boolean {
    if (!modelFilter) return false;
    const record = (allRecords ?? []).find((r) => r.flags?.some((f) => f.id === flagId));
    return record ? record.model !== modelFilter : false;
  }

  // Whether the target flag is present in the session data we already have
  // loaded (i.e. some FlagCard for it could mount right now). The digest
  // polls independently of useSession, so it can reference a flag from a
  // turn that hasn't been fetched into allRecords yet. Without this check,
  // navigateToFlags would arm pendingScrollIdRef for a flag that may not
  // mount for a long time (or until an unrelated refetch), producing a
  // surprise scroll/focus jump later while the user is doing something else.
  function isFlagResolvable(flagId: string): boolean {
    return (allRecords ?? []).some((r) => r.flags?.some((f) => f.id === flagId));
  }

  function navigateToFlags(flagIds: string[]) {
    if (!flagIds.length) return;
    const [firstId, ...restIds] = flagIds;

    if (!isFlagResolvable(firstId)) {
      // Don't silently queue a scroll for a flag that isn't renderable yet —
      // tell the user now. Unlike the model-filter case, there's no reliable
      // trigger to know when to retry, so no automatic retry is queued here.
      toast("Flag hasn't loaded yet", {
        description: "It's from a part of the session that hasn't loaded. Try again in a moment.",
      });
      return;
    }

    const alreadyExpanded = expandedFlagIds.has(firstId);

    setExpandedFlagIds((prev) => {
      if (prev.has(firstId)) return prev;
      const next = new Set(prev);
      next.add(firstId);
      return next;
    });

    if (alreadyExpanded) {
      // No fresh mount is coming for this row, so no registerFlagRef call
      // will follow — scroll/focus immediately using the ref it already has.
      const el = flagRefs.current.get(firstId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
      }
    } else {
      pendingScrollIdRef.current = firstId;
    }

    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    const renderedRest = restIds.filter((id) => flagRefs.current.has(id));
    setRingingFlagIds(new Set(renderedRest));
    setAnnouncement(
      renderedRest.length > 0
        ? `${renderedRest.length} additional matching flag${renderedRest.length === 1 ? "" : "s"} highlighted`
        : "",
    );
    if (renderedRest.length > 0) {
      ringTimeoutRef.current = setTimeout(() => setRingingFlagIds(new Set()), RING_DURATION_MS);
    }
  }

  // Once the model filter changes (e.g. cleared via the toast action below),
  // retry any pending navigation whose target flag is no longer filtered out.
  useEffect(() => {
    const pending = pendingNavFlagIdsRef.current;
    if (!pending) return;
    if (isFlagFilteredOut(pending[0])) return;
    pendingNavFlagIdsRef.current = null;
    navigateToFlags(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelFilter]);

  function handleHighlightClick(flagIds: string[]) {
    if (!flagIds.length) return;
    const [firstId] = flagIds;

    if (isFlagFilteredOut(firstId)) {
      toast("Flag hidden by current model filter", {
        description: "Clear the filter to jump to it.",
        action: {
          label: "Clear filter",
          onClick: () => {
            pendingNavFlagIdsRef.current = flagIds;
            onClearModelFilter?.();
          },
        },
      });
      return;
    }

    navigateToFlags(flagIds);
  }

  return {
    expandedFlagIds,
    ringingFlagIds,
    announcement,
    registerFlagRef,
    toggleFlag,
    handleHighlightClick,
  };
}
