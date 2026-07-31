import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');

const VALID_REVIEW_STATUSES = ['unreviewed', 'accepted', 'needs_change', 'false_positive'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'content-type': mime });
    res.end(content);
  } catch {
    return false;
  }
  return true;
}

// Reduces a session's flags (already attached to records via getRecordsWithFlags)
// down to the shape the digest synthesizer expects: the flat set of real flag
// ids (for server-side validation of whatever the synthesizer returns) and
// the trimmed flag payload actually sent to the synthesizer. Only needed when
// synthesis is actually about to run — latest_turn_at and the live flag count
// come from the cheaper db.getSessionFlagSummary() query for every other path.
function summarizeSessionFlags(records) {
  const flags = records.flatMap((r) => r.flags ?? []);
  const flagIds = new Set(flags.map((f) => f.id));
  const flagsForSynthesis = flags.map((f) => ({
    id: f.id,
    type: f.type,
    content: f.content,
    confidence: f.confidence,
  }));
  return { flagIds, flagsForSynthesis };
}

// Same-origin policy for routes whose side effects are costly enough to
// matter if triggered by a cross-site request (currently just the digest
// route's billed LLM call + DB write). Absent header covers curl/tests/CLI.
function requireSameOrigin(req) {
  const secFetchSite = req.headers['sec-fetch-site'];
  return !secFetchSite || secFetchSite === 'same-origin';
}

// Drops any highlight whose flag_ids aren't ALL real flags in this session —
// guards against hallucinated/stale ids from the synthesizer. A highlight
// with no flag_ids at all references nothing and is dropped too.
function validateHighlights(highlights, flagIds) {
  if (!Array.isArray(highlights)) return [];
  return highlights.filter(
    (h) =>
      h &&
      Array.isArray(h.flag_ids) &&
      h.flag_ids.length > 0 &&
      h.flag_ids.every((id) => flagIds.has(id)),
  );
}

export function createUIServer({ db, digestSynthesizer = null, digestConfig = {} } = {}) {
  let server = null;
  let _port = null;

  // Digest is only actually usable when both a synthesizer function was
  // wired in (production: App.start(); tests: opt-in) AND it isn't
  // explicitly disabled via config. Callers that construct createUIServer
  // with just { db } (existing test files) get a safe disabled default
  // rather than a crash on first digest request.
  const digestEnabled = digestConfig.enabled !== false && typeof digestSynthesizer === 'function';
  const flagThreshold = digestConfig.flag_threshold ?? 20;

  // Per-session "recently failed" marker for the digest route (fix for
  // unbounded retry-every-poll on a down/erroring synthesizer). Session-
  // scoped and in-memory only — no new DB table needed, and it's fine for
  // this to reset on daemon restart. Cleared on the next successful
  // generation for that session.
  // Value shape is { at, flagCount } rather than a bare timestamp: flagCount
  // is the live flag count observed at the moment synthesis failed. If new
  // flags land on an actively-running session while it's still within the
  // cooldown window, that's new content worth trying to synthesize against
  // even though the timer hasn't expired yet — so the cooldown check below
  // bypasses the wait whenever the current live flag count no longer matches
  // the count recorded at failure time.
  const digestRecentFailures = new Map();
  const DIGEST_FAILURE_COOLDOWN_MS = 60_000;

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost`);
    const pathname = url.pathname;
    const method = req.method;

    // ── API routes ──────────────────────────────────────────────────────

    // Readiness probe — used by `agent-feed start` to confirm the daemon is
    // serving requests AND the DB is queryable (catches migration failures
    // that just-binding-the-port wouldn't). Returns 503 on DB error so the
    // CLI can treat the daemon as unhealthy and trigger auto-unset.
    if (method === 'GET' && pathname === '/api/health') {
      try {
        db.ping();
        return json(res, 200, { ok: true, db: 'ready' });
      } catch (err) {
        return json(res, 503, { ok: false, db: err.message ?? String(err) });
      }
    }

    if (method === 'GET' && pathname === '/api/trends') {
      const agent = url.searchParams.get('agent') || undefined;
      const repo = url.searchParams.get('repo') || undefined;
      const branch = url.searchParams.get('branch') || undefined;
      const dateFrom = url.searchParams.get('dateFrom') || undefined;
      const dateTo = url.searchParams.get('dateTo') || undefined;
      const trends = await db.getTrends({ agent, repo, branch, dateFrom, dateTo });
      return json(res, 200, trends);
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      const agentFilter = url.searchParams.get('agent');
      const dateFilter = url.searchParams.get('date');
      let sessions = await db.listSessions();
      if (agentFilter) sessions = sessions.filter((s) => s.agent === agentFilter);
      if (dateFilter) sessions = sessions.filter((s) => s.latest_timestamp >= dateFilter);
      const flagCounts = await db.getSessionFlagCounts();
      const countsMap = new Map(flagCounts.map((c) => [c.session_id, c]));
      for (const s of sessions) {
        const counts = countsMap.get(s.session_id);
        s.total_flags = counts?.total_flags ?? 0;
        s.unreviewed_flags = counts?.unreviewed_flags ?? 0;
      }
      return json(res, 200, sessions);
    }

    const rawMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/records\/([^/]+)\/raw$/);
    if (method === 'GET' && rawMatch) {
      const sessionId = decodeURIComponent(rawMatch[1]);
      const recordId = decodeURIComponent(rawMatch[2]);
      const records = await db.getSession(sessionId);
      const record = records.find((r) => r.id === recordId);
      if (!record) return json(res, 404, { error: 'Record not found' });
      return json(res, 200, { raw_response: record.raw_response, raw_request: record.raw_request });
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const raw = url.searchParams.get('raw') === '1';
      const records = raw
        ? await db.getRecordsWithFlags(sessionId)
        : await db.getCoalescedRecordsWithFlags(sessionId);
      if (!records.length) return json(res, 404, { error: 'Session not found' });
      return json(res, 200, records);
    }

    // OTel-derived event timeline for a session.
    // Optional ?kind=tool_decision|hook|mcp|... filters by event_kind
    // Optional ?prompt_id=<uuid> filters by prompt
    const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const sessionId = decodeURIComponent(eventsMatch[1]);
      const kind = url.searchParams.get('kind') || null;
      const promptId = url.searchParams.get('prompt_id') || null;
      const events = await db.getEventsForSession(sessionId, { kind, promptId });
      // Parse stored JSON attributes for the wire response
      const parsed = events.map((e) => ({ ...e, attributes: safeJsonParse(e.attributes) }));
      return json(res, 200, parsed);
    }

    const toolDecMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tool-decisions$/);
    if (method === 'GET' && toolDecMatch) {
      const sessionId = decodeURIComponent(toolDecMatch[1]);
      const decisions = await db.getEventsForSession(sessionId, { kind: 'tool_decision' });
      const results = await db.getEventsForSession(sessionId, { kind: 'tool_result' });
      return json(res, 200, {
        decisions: decisions.map((e) => ({ ...e, attributes: safeJsonParse(e.attributes) })),
        results: results.map((e) => ({ ...e, attributes: safeJsonParse(e.attributes) })),
      });
    }

    const hooksMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/hooks$/);
    if (method === 'GET' && hooksMatch) {
      const sessionId = decodeURIComponent(hooksMatch[1]);
      const hooks = await db.getEventsForSession(sessionId, { kind: 'hook' });
      return json(
        res,
        200,
        hooks.map((e) => ({ ...e, attributes: safeJsonParse(e.attributes) })),
      );
    }

    const mcpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/mcp$/);
    if (method === 'GET' && mcpMatch) {
      const sessionId = decodeURIComponent(mcpMatch[1]);
      const mcp = await db.getEventsForSession(sessionId, { kind: 'mcp' });
      return json(
        res,
        200,
        mcp.map((e) => ({ ...e, attributes: safeJsonParse(e.attributes) })),
      );
    }

    // Session digest: on-demand synthesis of a session's flags into a small
    // set of reviewer-facing highlights, cached until the live flag count
    // changes. See docs/plans/2026-07-29-001-feat-session-flag-digest-plan.md.
    const digestMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/digest$/);
    if (method === 'GET' && digestMatch) {
      // This is the first GET route whose side effect includes a billed LLM
      // call and a DB write, so it requires same-origin before any other
      // work — including DB reads — happens.
      if (!requireSameOrigin(req)) {
        return json(res, 403, { error: 'Cross-site requests are not allowed for this endpoint' });
      }

      const sessionId = decodeURIComponent(digestMatch[1]);
      const active_window_minutes = digestConfig.active_window_minutes ?? 10;

      // Cheap query first: just the live flag count and latest turn
      // timestamp, not every record's full row content or every flag row.
      // Covers the 404 check, the disabled/below-threshold self-hide paths,
      // and the cache-hit path — the common case on a ~20s poll loop. The
      // full getRecordsWithFlags() fetch only happens below if synthesis is
      // actually about to run.
      const { total_flags: liveFlagCount, latest_turn_at } =
        await db.getSessionFlagSummary(sessionId);
      if (latest_turn_at == null) return json(res, 404, { error: 'Session not found' });

      // Disabled digest self-hides exactly like a below-threshold session —
      // same response shape the frontend already treats as "render nothing" —
      // rather than the distinct "unavailable" shape, which renders a
      // permanent broken-looking retry box that can never succeed while the
      // feature is off.
      if (!digestEnabled) {
        return json(res, 200, { status: 'below_threshold', latest_turn_at, active_window_minutes });
      }

      if (liveFlagCount < flagThreshold) {
        return json(res, 200, { status: 'below_threshold', latest_turn_at, active_window_minutes });
      }

      const cached = await db.getSessionDigest(sessionId);
      if (cached && cached.flag_count_at_generation === liveFlagCount) {
        return json(res, 200, {
          status: 'ready',
          highlights: cached.content?.highlights ?? [],
          generated_at: cached.generated_at,
          latest_turn_at,
          active_window_minutes,
        });
      }

      // Cache miss or flag-count mismatch, above threshold, enabled — this is
      // the path that would invoke the (billed) synthesizer. If this session
      // failed recently, skip re-invoking it on every ~20s poll and return
      // the unavailable shape directly instead — unless the live flag count
      // has changed since that failure, in which case there's new content
      // worth trying to synthesize even though the cooldown window hasn't
      // elapsed yet.
      const lastFailure = digestRecentFailures.get(sessionId);
      const stillInCooldown =
        lastFailure != null &&
        Date.now() - lastFailure.at < DIGEST_FAILURE_COOLDOWN_MS &&
        lastFailure.flagCount === liveFlagCount;
      if (stillInCooldown) {
        return json(res, 200, { status: 'unavailable', latest_turn_at, active_window_minutes });
      }

      // Synthesis is actually about to run — now (and only now) do we need
      // full record+flag rows, for flagsForSynthesis and flag-id validation.
      const records = await db.getRecordsWithFlags(sessionId);
      const { flagIds, flagsForSynthesis } = summarizeSessionFlags(records);

      let synthesized;
      try {
        synthesized = await digestSynthesizer(flagsForSynthesis);
      } catch (err) {
        console.error('[agent-feed] digest synthesis failed:', err.message ?? err);
        digestRecentFailures.set(sessionId, { at: Date.now(), flagCount: liveFlagCount });
        return json(res, 200, { status: 'unavailable', latest_turn_at, active_window_minutes });
      }

      const highlights = validateHighlights(synthesized?.highlights, flagIds);
      if (!highlights.length) {
        digestRecentFailures.set(sessionId, { at: Date.now(), flagCount: liveFlagCount });
        return json(res, 200, { status: 'unavailable', latest_turn_at, active_window_minutes });
      }

      digestRecentFailures.delete(sessionId);

      const generated_at = new Date().toISOString();
      try {
        await db.saveSessionDigest(sessionId, {
          generated_at,
          flag_count_at_generation: flagIds.size,
          content: { highlights },
          model: digestConfig.model || null,
        });
      } catch (err) {
        console.error('[agent-feed] failed to save session digest:', err.message ?? err);
      }

      return json(res, 200, {
        status: 'ready',
        highlights,
        generated_at,
        latest_turn_at,
        active_window_minutes,
      });
    }

    if (method === 'PATCH' && pathname === '/api/flags/bulk') {
      const body = await readBody(req);
      const { flag_ids, review_status } = body;
      if (
        !Array.isArray(flag_ids) ||
        !flag_ids.length ||
        !flag_ids.every((id) => typeof id === 'string' && id.length > 0)
      ) {
        return json(res, 400, { error: 'flag_ids must be a non-empty array of strings' });
      }
      if (!review_status || !VALID_REVIEW_STATUSES.includes(review_status)) {
        return json(res, 400, { error: `Invalid review_status: ${review_status}` });
      }
      try {
        await db.bulkUpdateFlagReview(flag_ids, review_status);
        return json(res, 200, { ok: true, updated: flag_ids.length });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    const flagMatch = pathname.match(/^\/api\/flags\/([^/]+)$/);
    if (method === 'PATCH' && flagMatch) {
      const flagId = decodeURIComponent(flagMatch[1]);
      const body = await readBody(req);
      const { review_status, reviewer_note, outcome } = body;
      if (review_status && !VALID_REVIEW_STATUSES.includes(review_status)) {
        return json(res, 400, { error: `Invalid review_status: ${review_status}` });
      }
      try {
        await db.updateFlagReview(flagId, { review_status, reviewer_note, outcome });
        return json(res, 200, { ok: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // ── Static file serving ─────────────────────────────────────────────

    if (method === 'GET') {
      // Try exact file path first
      const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(DIST_DIR, safePath);
      if (filePath.startsWith(DIST_DIR) && serveStatic(res, filePath)) return;

      // SPA fallback: serve index.html for non-API, non-file routes
      const indexPath = path.join(DIST_DIR, 'index.html');
      if (serveStatic(res, indexPath)) return;

      // No dist/ built yet
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Frontend not built. Run: cd src/ui/frontend && npm run build');
      return;
    }

    json(res, 404, { error: 'Not found' });
  }

  const instance = {
    get port() {
      return _port;
    },

    async listen(configPort = 3000) {
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => json(res, 500, { error: err.message }));
      });
      await new Promise((resolve, reject) => {
        // Bind explicitly to 127.0.0.1 (IPv4) rather than 'localhost' so the
        // CLI's health probe can match deterministically. macOS resolves
        // 'localhost' to ::1 (IPv6) first, which produced a probe-vs-bind
        // mismatch when the probe used 127.0.0.1.
        server.listen(configPort, '127.0.0.1', (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      _port = server.address().port;
    },

    async close() {
      if (!server) return;
      await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };

  return instance;
}
