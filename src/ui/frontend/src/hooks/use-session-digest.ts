import { useQuery } from "@tanstack/react-query";
import { fetchSessionDigest } from "@/api/client";
import type { SessionDigest } from "@/api/types";

// Poll cadence while the session is within the active window.
const POLL_INTERVAL_MS = 20_000;

// The active window is server config (`digest.active_window_minutes`), and
// every digest response already echoes the value the server is actually
// using — read it from there instead of maintaining a second hardcoded
// copy that could silently drift from the server's real setting.
function isWithinActiveWindow({ latest_turn_at, active_window_minutes }: SessionDigest): boolean {
  const latestMs = new Date(latest_turn_at).getTime();
  if (Number.isNaN(latestMs)) return false;
  return Date.now() - latestMs <= active_window_minutes * 60_000;
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
      return isWithinActiveWindow(data) ? POLL_INTERVAL_MS : false;
    },
  });
}
