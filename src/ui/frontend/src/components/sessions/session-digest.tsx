import { useSessionDigest } from "@/hooks/use-session-digest";
import { cn } from "@/lib/utils";
import type { Flag } from "@/api/types";

interface SessionDigestProps {
  sessionId: string;
  // Full, unfiltered session flags (digest always covers the whole session,
  // independent of the session view's per-model filter — see plan's Key
  // Technical Decisions) — used only to look up review status per highlight.
  flags: Flag[];
  // Wired by SessionDetail to scroll/expand/focus the referenced flag(s)
  // and ring any additional matches elsewhere on the page.
  onHighlightClick?: (flagIds: string[]) => void;
  // Screen-reader-only announcement text, set by SessionDetail after a
  // multi-flag highlight click rings additional matches (e.g. "2 additional
  // matching flags highlighted"). Rendered here since this is where the
  // triggering click happens.
  announcement?: string;
}

function isFullyReviewed(flagIds: string[], flagsById: Map<string, Flag>): boolean {
  if (flagIds.length === 0) return false;
  return flagIds.every((id) => {
    const flag = flagsById.get(id);
    return flag ? flag.review_status !== "unreviewed" : false;
  });
}

export function SessionDigest({ sessionId, flags, onHighlightClick, announcement }: SessionDigestProps) {
  const { data, isLoading, error, refetch, isFetching } = useSessionDigest(sessionId);

  // First-ever fetch still in flight, no prior data to fall back on — show a
  // brief loading indicator rather than silently rendering nothing, so a
  // large session doesn't look broken while the synthesis call is running.
  if (isLoading && !data) {
    return <div className="font-mono text-xs text-muted-foreground p-4">synthesizing digest...</div>;
  }

  // A hard transport/HTTP error (e.g. 404/403) with nothing to show yet.
  // Distinct from the server's own defined "unavailable" status below.
  if (error && !data) {
    return (
      <div className="flex items-center gap-3 font-mono text-xs text-red-500 p-4">
        <span>{(error as Error).message}</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-primary hover:underline disabled:opacity-50 cursor-pointer"
        >
          {isFetching ? "retrying..." : "retry"}
        </button>
      </div>
    );
  }

  // Below-threshold sessions render exactly as they do today: nothing.
  if (!data || data.status === "below_threshold") return null;

  if (data.status === "unavailable") {
    return (
      <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground p-4 rounded border border-border">
        <span>Digest unavailable</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-primary hover:underline disabled:opacity-50 cursor-pointer"
        >
          {isFetching ? "retrying..." : "retry"}
        </button>
      </div>
    );
  }

  const flagsById = new Map(flags.map((f) => [f.id, f]));

  return (
    <div className="space-y-2 font-mono text-xs">
      {/* Visually hidden; announces multi-flag ring matches to screen readers */}
      <div aria-live="polite" className="sr-only">{announcement}</div>
      <h3 className="text-sm font-medium text-foreground">Digest ({data.highlights.length})</h3>
      <div className="rounded border border-border divide-y divide-border">
        {data.highlights.map((highlight, i) => {
          const reviewed = isFullyReviewed(highlight.flag_ids, flagsById);
          return (
            <button
              key={i}
              onClick={() => onHighlightClick?.(highlight.flag_ids)}
              className={cn(
                "w-full text-left px-4 py-2.5 hover:bg-accent/30 transition-colors cursor-pointer",
                reviewed && "opacity-45 hover:opacity-70",
              )}
            >
              <span className="text-sm text-foreground">{highlight.summary}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
