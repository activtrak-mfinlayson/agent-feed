import { useQuery } from "@tanstack/react-query";
import { fetchSessionDigest } from "@/api/client";
import type { SessionDigest } from "@/api/types";

// Mirrors the server's default `digest.active_window_minutes` (see
// docs/plans/2026-07-29-001-feat-session-flag-digest-plan.md, Open Questions).
// Not read from server config — a client-side constant matching the
// server's default is acceptable here; tuning both together is deferred.
const ACTIVE_WINDOW_MINUTES = 10;

// Poll cadence while the session is within the active window.
const POLL_INTERVAL_MS = 20_000;

function isWithinActiveWindow(latestTurnAt: string): boolean {
  const latestMs = new Date(latestTurnAt).getTime();
  if (Number.isNaN(latestMs)) return false;
  return Date.now() - latestMs <= ACTIVE_WINDOW_MINUTES * 60_000;
}

export function useSessionDigest(sessionId: string | null) {
  return useQuery({
    queryKey: ["digest", sessionId],
    queryFn: () => fetchSessionDigest(sessionId!),
    enabled: !!sessionId,
    // Overrides the global 30s staleTime (see main.tsx) — this query polls
    // on its own schedule and needs to reflect fresh data on every request.
    staleTime: 0,
    refetchInterval: (query) => {
      // Always fetch at least once on mount (handled by useQuery itself,
      // not by this callback) — before the first response arrives there is
      // no `latest_turn_at` to judge activity from, so no polling decision
      // can be made yet.
      const data = query.state.data as SessionDigest | undefined;
      if (!data) return false;
      return isWithinActiveWindow(data.latest_turn_at) ? POLL_INTERVAL_MS : false;
    },
  });
}
