import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { useUpdateFlagStatus, useSaveNotes, useBulkUpdate } from "@/hooks/use-flag-mutations";
import { TurnBlock } from "./turn-block";
import { SessionDigest } from "./session-digest";
import { ToolDecisionTimeline } from "./tool-decision-timeline";
import { HookActivity } from "./hook-activity";
import { MCPHealth } from "./mcp-health";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import type { ReviewStatus } from "@/api/types";

interface SessionDetailProps {
  sessionId: string;
  modelFilter?: string;
  // Lets a digest highlight click clear the active model filter when the
  // flag it targets is hidden by it (see handleHighlightClick below).
  onClearModelFilter?: () => void;
}

// How long a digest highlight's "ring" stays on additional matched flags
// before auto-clearing (also cleared immediately by the next highlight click).
const RING_DURATION_MS = 3500;

export function SessionDetail({ sessionId, modelFilter, onClearModelFilter }: SessionDetailProps) {
  const { data: allRecords, isLoading, error } = useSession(sessionId);
  const records = modelFilter
    ? allRecords?.filter((r) => r.model === modelFilter)
    : allRecords;
  const updateStatus = useUpdateFlagStatus(sessionId);
  const saveNotes = useSaveNotes(sessionId);
  const bulkUpdate = useBulkUpdate(sessionId);

  // ── Lifted flag-expand state (U5) ──────────────────────────────────────
  // A Set, not a single scalar: each TurnBlock used to own its own
  // expandedFlagId independently, so a reviewer could have different flags
  // expanded in different turns simultaneously. Lifting this to a shared
  // scalar would collapse that into "only one flag expanded across the
  // whole session" — a regression. A Set of expanded flag IDs preserves
  // today's per-turn-independent behavior while still letting a digest
  // highlight target one specific flag ID anywhere in the session.
  const [expandedFlagIds, setExpandedFlagIds] = useState<Set<string>>(new Set());
  // Flags currently getting the temporary "ring" treatment from a digest
  // highlight click (see handleHighlightClick).
  const [ringingFlagIds, setRingingFlagIds] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  // A flag ID a highlight click wants scrolled-to-and-focused once it's
  // rendered (set immediately after expanding it; consumed by the effect
  // below once the DOM element is registered).
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null);
  // A highlight click's full flag_ids, held here while we wait for the
  // model filter to clear so the target flag becomes renderable.
  const [pendingNavFlagIds, setPendingNavFlagIds] = useState<string[] | null>(null);

  // flagId -> interactive DOM element, populated via FlagCard's registerRef
  // (threaded through TurnBlock). Lets a highlight click scroll to and focus
  // a specific flag regardless of which turn renders it.
  const flagRefs = useRef<Map<string, HTMLElement>>(new Map());
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registerFlagRef = useCallback((flagId: string, el: HTMLElement | null) => {
    if (el) flagRefs.current.set(flagId, el);
    else flagRefs.current.delete(flagId);
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
    setPendingNavFlagIds(null);
    setScrollTargetId(null);
    flagRefs.current.clear();
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  }, [sessionId]);

  // Scroll to and focus scrollTargetId once its DOM element is registered
  // (i.e. after the expand state change above has been committed).
  useEffect(() => {
    if (!scrollTargetId) return;
    const el = flagRefs.current.get(scrollTargetId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus();
    }
    setScrollTargetId(null);
    // expandedFlagIds is a dep so this re-runs once the target flag's row
    // finishes re-rendering in its expanded shape (new DOM node, new ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTargetId, expandedFlagIds]);

  // Once the model filter changes (e.g. cleared via the toast action below),
  // retry any pending navigation whose target flag is no longer filtered out.
  useEffect(() => {
    if (!pendingNavFlagIds) return;
    if (isFlagFilteredOut(pendingNavFlagIds[0])) return;
    navigateToFlags(pendingNavFlagIds);
    setPendingNavFlagIds(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNavFlagIds, modelFilter]);

  function isFlagFilteredOut(flagId: string): boolean {
    if (!modelFilter) return false;
    const record = (allRecords ?? []).find((r) => r.flags?.some((f) => f.id === flagId));
    return record ? record.model !== modelFilter : false;
  }

  function navigateToFlags(flagIds: string[]) {
    if (!flagIds.length) return;
    const [firstId, ...restIds] = flagIds;

    setExpandedFlagIds((prev) => {
      if (prev.has(firstId)) return prev;
      const next = new Set(prev);
      next.add(firstId);
      return next;
    });

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

    setScrollTargetId(firstId);
  }

  function handleHighlightClick(flagIds: string[]) {
    if (!flagIds.length) return;
    const [firstId] = flagIds;

    if (isFlagFilteredOut(firstId)) {
      toast("Flag hidden by current model filter", {
        description: "Clear the filter to jump to it.",
        action: {
          label: "Clear filter",
          onClick: () => {
            setPendingNavFlagIds(flagIds);
            onClearModelFilter?.();
          },
        },
      });
      return;
    }

    navigateToFlags(flagIds);
  }

  if (isLoading) return <div className="p-10 text-center font-mono text-xs text-muted-foreground">loading session...</div>;
  if (error || !records?.length) return <div className="p-10 text-center text-sm text-muted-foreground">Session not found.</div>;

  const allFlags = records.flatMap((r) => r.flags ?? []);
  // Digest always covers the whole session regardless of the model filter
  // (see plan's Key Technical Decisions), so its review-status lookups need
  // the unfiltered flag set, not the possibly-filtered `records`/`allFlags`.
  const digestFlags = (allRecords ?? []).flatMap((r) => r.flags ?? []);
  const unreviewed = allFlags.filter((f) => f.review_status === "unreviewed");
  const accepted = allFlags.filter((f) => f.review_status === "accepted").length;
  const needsChange = allFlags.filter((f) => f.review_status === "needs_change").length;
  const falsePos = allFlags.filter((f) => f.review_status === "false_positive").length;
  const first = records[0];

  function handleBulk(status: ReviewStatus) {
    const ids = unreviewed.map((f) => f.id);
    if (!ids.length) return;
    if (!confirm(`Update ${ids.length} flags to "${status.replace("_", " ")}"?`)) return;
    bulkUpdate.mutate({ flagIds: ids, status });
  }

  // Build a compact summary string
  const parts: string[] = [];
  parts.push(`${allFlags.length} flag${allFlags.length !== 1 ? "s" : ""}`);
  if (unreviewed.length > 0) parts.push(`${unreviewed.length} unreviewed`);
  if (accepted > 0) parts.push(`${accepted} accepted`);
  if (needsChange > 0) parts.push(`${needsChange} needs change`);
  if (falsePos > 0) parts.push(`${falsePos} FP`);
  const turnsWithFlags = records.filter((r) => (r.flags?.length ?? 0) > 0).length;
  parts.push(`${turnsWithFlags} turn${turnsWithFlags !== 1 ? "s" : ""} with flags`);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-base font-semibold tracking-tight">{first.repo || sessionId}</h1>
        <p className="font-mono text-[11px] text-muted-foreground mt-1 leading-relaxed">
          {first.agent} · {first.model} · {formatDate(first.timestamp)}
          {first.git_branch ? ` · ${first.git_branch}` : ""}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground mt-0.5">
          {parts.join(" · ")}
        </p>
      </div>

      {/* Bulk actions — only when there's something to triage */}
      {unreviewed.length > 0 && (
        <div className="flex items-center gap-3 mb-5 font-mono text-[11px]">
          <span className="text-muted-foreground">{unreviewed.length} unreviewed</span>
          <Button
            variant="ghost"
            size="sm"
            className="font-mono text-[10px] h-6 px-2 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
            onClick={() => handleBulk("accepted")}
          >
            accept all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="font-mono text-[10px] h-6 px-2 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
            onClick={() => handleBulk("false_positive")}
          >
            mark all FP
          </Button>
        </div>
      )}

      {/* Digest + OTel-derived signals (each self-hides when not applicable) */}
      <div className="space-y-6 mb-8">
        <SessionDigest
          sessionId={sessionId}
          flags={digestFlags}
          onHighlightClick={handleHighlightClick}
          announcement={announcement}
        />
        <ToolDecisionTimeline sessionId={sessionId} />
        <HookActivity sessionId={sessionId} />
        <MCPHealth sessionId={sessionId} />
      </div>

      {/* Turns — newest first */}
      {[...records].reverse().map((r) => (
        <TurnBlock
          key={r.id}
          record={r}
          sessionId={sessionId}
          expandedFlagIds={expandedFlagIds}
          onToggleFlag={toggleFlag}
          ringingFlagIds={ringingFlagIds}
          registerFlagRef={registerFlagRef}
          onFlagStatusChange={(flagId, status) => updateStatus.mutate({ flagId, status })}
          onSaveNotes={(flagId, note, outcome) => saveNotes.mutate({ flagId, reviewerNote: note, outcome })}
        />
      ))}
    </div>
  );
}
