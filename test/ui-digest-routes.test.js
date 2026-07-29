import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/storage/database.js';
import { createUIServer } from '../src/ui/server.js';

const FLAG_THRESHOLD = 3;

async function buildServer({ digestSynthesizer = null, digestConfig = { enabled: true, flag_threshold: FLAG_THRESHOLD } } = {}) {
  const db = new Database(':memory:');
  await db.init();
  const server = createUIServer({ db, digestSynthesizer, digestConfig });
  await server.listen(0);
  return { db, server, port: server.port };
}

async function seedSession(db, sessionId, flagCount) {
  const recordId = await db.insertRecord({
    timestamp: new Date().toISOString(),
    agent: 'claude-code',
    session_id: sessionId,
    turn_index: 1,
    working_directory: '/tmp/project',
    response_summary: 'summary',
    raw_response: JSON.stringify({ content: 'x' }),
    model: 'claude-sonnet-4-6',
  });
  const flagIds = [];
  for (let i = 0; i < flagCount; i++) {
    const id = await db.insertFlag({
      record_id: recordId,
      type: 'decision',
      content: `Decision number ${i}`,
      confidence: 0.9,
    });
    flagIds.push(id);
  }
  return { recordId, flagIds };
}

describe('GET /api/sessions/:id/digest', () => {
  it('triggers synthesis and returns ready when at/above threshold with no prior digest', async () => {
    const db = new Database(':memory:');
    await db.init();
    const { flagIds } = await seedSession(db, 'sess-a', FLAG_THRESHOLD);

    let calls = 0;
    const server = createUIServer({
      db,
      digestSynthesizer: async (flags) => {
        calls++;
        assert.equal(flags.length, FLAG_THRESHOLD);
        return { highlights: [{ summary: 'Several decisions made', flag_ids: [flagIds[0]] }] };
      },
      digestConfig: { enabled: true, flag_threshold: FLAG_THRESHOLD },
    });
    await server.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.port}/api/sessions/sess-a/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ready');
      assert.equal(body.highlights.length, 1);
      assert.equal(body.highlights[0].summary, 'Several decisions made');
      assert.ok(body.generated_at);
      assert.ok(body.latest_turn_at);
      assert.equal(calls, 1);

      const cached = await db.getSessionDigest('sess-a');
      assert.ok(cached);
      assert.equal(cached.flag_count_at_generation, FLAG_THRESHOLD);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('returns cached content without invoking the synthesizer when flag count matches', async () => {
    const db = new Database(':memory:');
    await db.init();
    const { flagIds } = await seedSession(db, 'sess-cached', FLAG_THRESHOLD);
    await db.saveSessionDigest('sess-cached', {
      generated_at: new Date().toISOString(),
      flag_count_at_generation: FLAG_THRESHOLD,
      content: { highlights: [{ summary: 'Cached highlight', flag_ids: [flagIds[0]] }] },
      model: 'claude-haiku-4-5-20251001',
    });

    let calls = 0;
    const server = createUIServer({
      db,
      digestSynthesizer: async () => { calls++; return { highlights: [] }; },
      digestConfig: { enabled: true, flag_threshold: FLAG_THRESHOLD },
    });
    await server.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.port}/api/sessions/sess-cached/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ready');
      assert.equal(body.highlights[0].summary, 'Cached highlight');
      assert.equal(calls, 0, 'synthesizer should not be invoked for a current cache hit');
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('regenerates when live flag count has grown since the cached generation', async () => {
    const db = new Database(':memory:');
    await db.init();
    const { flagIds } = await seedSession(db, 'sess-grow', FLAG_THRESHOLD);
    await db.saveSessionDigest('sess-grow', {
      generated_at: new Date().toISOString(),
      flag_count_at_generation: FLAG_THRESHOLD,
      content: { highlights: [{ summary: 'Stale highlight', flag_ids: [flagIds[0]] }] },
      model: 'claude-haiku-4-5-20251001',
    });

    // Add one more flag so the live count no longer matches the cache.
    const recordId = (await db.getSession('sess-grow'))[0].id;
    await db.insertFlag({ record_id: recordId, type: 'risk', content: 'New risk', confidence: 0.8 });

    let calls = 0;
    const server = createUIServer({
      db,
      digestSynthesizer: async (flags) => {
        calls++;
        return { highlights: [{ summary: 'Updated highlight', flag_ids: [flags[0].id] }] };
      },
      digestConfig: { enabled: true, flag_threshold: FLAG_THRESHOLD },
    });
    await server.listen(0);
    try {
      const res = await fetch(`http://localhost:${server.port}/api/sessions/sess-grow/digest`);
      const body = await res.json();
      assert.equal(body.status, 'ready');
      assert.equal(body.highlights[0].summary, 'Updated highlight');
      assert.equal(calls, 1);

      const cached = await db.getSessionDigest('sess-grow');
      assert.equal(cached.flag_count_at_generation, FLAG_THRESHOLD + 1);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('returns below_threshold without attempting synthesis', async () => {
    let calls = 0;
    const { db, server, port } = await buildServer({
      digestSynthesizer: async () => { calls++; return { highlights: [] }; },
    });
    try {
      await seedSession(db, 'sess-below', FLAG_THRESHOLD - 1);
      const res = await fetch(`http://localhost:${port}/api/sessions/sess-below/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'below_threshold');
      assert.equal(calls, 0);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('returns unavailable (200) and writes no cache row when the synthesizer throws', async () => {
    const { db, server, port } = await buildServer({
      digestSynthesizer: async () => { throw new Error('boom'); },
    });
    try {
      await seedSession(db, 'sess-throw', FLAG_THRESHOLD);
      const res = await fetch(`http://localhost:${port}/api/sessions/sess-throw/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'unavailable');
      assert.ok(body.latest_turn_at);

      const cached = await db.getSessionDigest('sess-throw');
      assert.equal(cached, null);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('returns unavailable (200) when the synthesizer returns a failure result', async () => {
    const { db, server, port } = await buildServer({
      digestSynthesizer: async () => ({ highlights: [] }),
    });
    try {
      await seedSession(db, 'sess-empty', FLAG_THRESHOLD);
      const res = await fetch(`http://localhost:${port}/api/sessions/sess-empty/digest`);
      const body = await res.json();
      assert.equal(body.status, 'unavailable');

      const cached = await db.getSessionDigest('sess-empty');
      assert.equal(cached, null);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('drops highlights referencing unknown flag ids; treats zero survivors as unavailable', async () => {
    const { db, server, port } = await buildServer({
      digestSynthesizer: async () => ({
        highlights: [{ summary: 'Hallucinated highlight', flag_ids: ['does-not-exist'] }],
      }),
    });
    try {
      await seedSession(db, 'sess-hallucinate', FLAG_THRESHOLD);
      const res = await fetch(`http://localhost:${port}/api/sessions/sess-hallucinate/digest`);
      const body = await res.json();
      assert.equal(body.status, 'unavailable');

      const cached = await db.getSessionDigest('sess-hallucinate');
      assert.equal(cached, null);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('returns 404 for an unknown session_id', async () => {
    const { db, server, port } = await buildServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/sessions/nonexistent-session/digest`);
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.ok(body.error);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('rejects a cross-site request with 403 before reading flag counts or attempting synthesis', async () => {
    let calls = 0;
    const { db, server, port } = await buildServer({
      digestSynthesizer: async () => { calls++; return { highlights: [] }; },
    });
    try {
      await seedSession(db, 'sess-cross-site', FLAG_THRESHOLD);
      const res = await fetch(`http://localhost:${port}/api/sessions/sess-cross-site/digest`, {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      });
      assert.equal(res.status, 403);
      assert.equal(calls, 0);
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('allows a request with no Sec-Fetch-Site header (curl/tests/CLI)', async () => {
    const { db, server, port } = await buildServer({
      digestSynthesizer: async () => ({ highlights: [] }),
    });
    try {
      await seedSession(db, 'sess-no-header', FLAG_THRESHOLD - 1);
      const res = await fetch(`http://localhost:${port}/api/sessions/sess-no-header/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'below_threshold');
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('defaults to a safe disabled behavior when no digestSynthesizer is provided (backward compat)', async () => {
    const db = new Database(':memory:');
    await db.init();
    const server = createUIServer({ db }); // no digestSynthesizer, no digestConfig — legacy call site
    await server.listen(0);
    try {
      await seedSession(db, 'sess-legacy', FLAG_THRESHOLD + 10);
      const res = await fetch(`http://localhost:${server.port}/api/sessions/sess-legacy/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'unavailable');
    } finally {
      await server.close();
      await db.close();
    }
  });

  it('integration: seeds real flags via insertFlag past threshold and round-trips through real storage methods', async () => {
    const db = new Database(':memory:');
    await db.init();
    await seedSession(db, 'sess-integration', FLAG_THRESHOLD);

    // A real (non-mock-bypassed) digest function that just builds a highlight
    // referencing all the flags it was given — exercises the actual
    // read -> generate -> validate -> save round trip through U1's storage
    // methods and U3's endpoint logic together.
    const realDigestFn = async (flags) => ({
      highlights: [{ summary: `Session has ${flags.length} decisions`, flag_ids: flags.map(f => f.id) }],
    });

    const server = createUIServer({
      db,
      digestSynthesizer: realDigestFn,
      digestConfig: { enabled: true, flag_threshold: FLAG_THRESHOLD },
    });
    await server.listen(0);
    try {
      const res1 = await fetch(`http://localhost:${server.port}/api/sessions/sess-integration/digest`);
      const body1 = await res1.json();
      assert.equal(body1.status, 'ready');
      assert.equal(body1.highlights[0].flag_ids.length, FLAG_THRESHOLD);

      const savedAfterFirst = await db.getSessionDigest('sess-integration');
      assert.equal(savedAfterFirst.flag_count_at_generation, FLAG_THRESHOLD);

      // Add more flags and confirm the second request regenerates.
      const recordId = (await db.getSession('sess-integration'))[0].id;
      await db.insertFlag({ record_id: recordId, type: 'risk', content: 'One more risk', confidence: 0.9 });

      const res2 = await fetch(`http://localhost:${server.port}/api/sessions/sess-integration/digest`);
      const body2 = await res2.json();
      assert.equal(body2.status, 'ready');
      assert.equal(body2.highlights[0].flag_ids.length, FLAG_THRESHOLD + 1);

      const savedAfterSecond = await db.getSessionDigest('sess-integration');
      assert.equal(savedAfterSecond.flag_count_at_generation, FLAG_THRESHOLD + 1);
    } finally {
      await server.close();
      await db.close();
    }
  });
});
