import { useCallback, useMemo } from "react";
import { useSession } from "@/hooks/use-session";
import { useUpdateFlagStatus, useSaveNotes, useBulkUpdate } from "@/hooks/use-flag-mutations";
import { useHighlightNavigation } from "@/hooks/use-highlight-navigation";
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
  // flag it targets is hidden by it (see useHighlightNavigation).
  onClearModelFilter?: () => void;
}

export function SessionDetail({ sessionId, modelFilter, onClearModelFilter }: SessionDetailProps) {
  const { data: allRecords, isLoading, error } = useSession(sessionId);
  const records = modelFilter
    ? allRecords?.filter((r) => r.model === modelFilter)
    : allRecords;
  const updateStatus = useUpdateFlagStatus(sessionId);
  const saveNotes = useSaveNotes(sessionId);
  const bulkUpdate = useBulkUpdate(sessionId);

  // Stable identity across SessionDetail re-renders (react-query's `mutate`
  // itself is already stable) so TurnBlock/FlagCard's memoization isn't
  // defeated by a fresh inline closure on every render.
  const handleFlagStatusChange = useCallback(
    (flagId: string, status: ReviewStatus) => updateStatus.mutate({ flagId, status }),
    [updateStatus.mutate],
  );
  const handleSaveNotes = useCallback(
    (flagId: string, note: string | null, outcome: string | null) =>
      saveNotes.mutate({ flagId, reviewerNote: note, outcome }),
    [saveNotes.mutate],
  );

  const {
    expandedFlagIds,
    ringingFlagIds,
    announcement,
    registerFlagRef,
    toggleFlag,
    handleHighlightClick,
  } = useHighlightNavigation({ sessionId, modelFilter, allRecords, onClearModelFilter });

  // Digest always covers the whole session regardless of the model filter
  // (see plan's Key Technical Decisions), so its review-status lookups need
  // the unfiltered flag set, not the possibly-filtered `records`/`allFlags`.
  const digestFlags = useMemo(
    () => (allRecords ?? []).flatMap((r) => r.flags ?? []),
    [allRecords],
  );

  if (isLoading) return <div className="p-10 text-center font-mono text-xs text-muted-foreground">loading session...</div>;
  if (error || !records?.length) return <div className="p-10 text-center text-sm text-muted-foreground">Session not found.</div>;

  const allFlags = records.flatMap((r) => r.flags ?? []);
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
          onFlagStatusChange={handleFlagStatusChange}
          onSaveNotes={handleSaveNotes}
        />
      ))}
    </div>
  );
}
