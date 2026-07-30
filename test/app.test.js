import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';

describe('App', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-app-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('starts and reports ready state', async () => {
    const app = new App({
      config: {
        proxy: { port: 0 },
        ui: { port: 0 },
        classifier: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
        storage: { path: path.join(tmpDir, 'app-test.db') },
      },
      skipClassifierValidation: true,
    });

    await app.start();
    assert.ok(app.isRunning());
    assert.ok(app.proxyPort > 0);
    assert.ok(app.uiPort > 0);
    await app.stop();
  });

  it('stops cleanly and reports not running', async () => {
    const app = new App({
      config: {
        proxy: { port: 0 },
        ui: { port: 0 },
        classifier: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
        storage: { path: path.join(tmpDir, 'app-stop-test.db') },
      },
      skipClassifierValidation: true,
    });

    await app.start();
    assert.ok(app.isRunning());
    await app.stop();
    assert.ok(!app.isRunning());
  });

  it('reports db size on start', async () => {
    const app = new App({
      config: {
        proxy: { port: 0 },
        ui: { port: 0 },
        classifier: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
        storage: { path: path.join(tmpDir, 'app-size-test.db') },
      },
      skipClassifierValidation: true,
    });

    await app.start();
    const status = app.getStatus();
    assert.ok(typeof status.dbSizeBytes === 'number');
    assert.ok(status.dbSizeBytes >= 0);
    await app.stop();
  });

  it('when digest.model is unset, the digest synthesizer resolves to the classifier model (resolvedDigestModel = digestCfg.model || classifierCfg.model)', async () => {
    // This exercises App.start()'s real resolution logic end-to-end
    // (skipClassifierValidation: false), rather than re-deriving the
    // expression in isolation. Every other test in this file uses
    // skipClassifierValidation: true, which forces digestSynthesizer to
    // null and short-circuits before resolvedDigestModel/resolvedDigestTimeout
    // are ever computed — leaving that logic with zero coverage.
    //
    // Using provider 'anthropic' with ANTHROPIC_API_KEY set lets
    // validateClassifierWithFallback's primary check succeed without any
    // real network call (validateClassifier's anthropic branch only checks
    // the env var). The digest synthesis call itself does go through
    // global fetch, so we stub globalThis.fetch for the one URL that
    // matters (the Anthropic messages endpoint) and pass everything else
    // (including this test's own request to the local UI server) through
    // to the real fetch.
    const classifierModel = 'claude-test-digest-resolution-model';
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key-for-digest-resolution-test';

    // `buildDigestSynthesizer(config, fetchFn = fetch)` resolves its default
    // `fetchFn` argument to whatever `globalThis.fetch` is at the moment
    // App.start() calls it — so the stub must be installed *before*
    // start(), not after. `flagId` is filled in once we know it (after
    // start(), once the DB exists) and read by reference from inside the
    // stub when the actual digest request comes in later.
    let flagId = null;
    let capturedRequestModel = null;
    globalThis.fetch = async (url, init) => {
      if (url === 'https://api.anthropic.com/v1/messages') {
        capturedRequestModel = JSON.parse(init.body).model;
        return new Response(
          JSON.stringify({
            content: [{
              type: 'text',
              text: JSON.stringify({ highlights: [{ summary: 'A highlight', flag_ids: [flagId] }] }),
            }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(url, init);
    };

    const app = new App({
      config: {
        proxy: { port: 0 },
        ui: { port: 0 },
        classifier: { provider: 'anthropic', model: classifierModel, base_url: '', timeout_ms: 12_345 },
        storage: { path: path.join(tmpDir, 'app-digest-resolution-test.db') },
        // digest.model intentionally omitted — this is exactly the unset
        // case resolvedDigestModel's `||` fallback exists for.
        digest: { flag_threshold: 1 },
      },
      skipClassifierValidation: false,
    });

    try {
      await app.start();

      // Seed a session with one real flag directly through the running
      // app's own database, then request its digest through the running
      // app's own UI server — no mocked db, no mocked createUIServer.
      const recordId = await app._db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: 'sess-digest-resolution',
        turn_index: 1,
        working_directory: '/tmp/project',
        response_summary: 'summary',
        raw_response: JSON.stringify({ content: 'x' }),
        model: 'claude-sonnet-4-6',
      });
      flagId = await app._db.insertFlag({
        record_id: recordId,
        type: 'decision',
        content: 'A decision',
        confidence: 0.9,
      });

      const res = await fetch(`http://127.0.0.1:${app.uiPort}/api/sessions/sess-digest-resolution/digest`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ready', `expected ready, got: ${JSON.stringify(body)}`);

      // The direct proof: the request the digest synthesizer actually sent
      // to the (stubbed) Anthropic endpoint used the classifier's model,
      // because digest.model was unset.
      assert.equal(capturedRequestModel, classifierModel);

      // Secondary confirmation via the persisted digest row's `model`
      // column, which app.js populates from the same resolvedDigestModel.
      const saved = await app._db.getSessionDigest('sess-digest-resolution');
      assert.equal(saved.model, classifierModel);
    } finally {
      await app.stop();
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });
});
