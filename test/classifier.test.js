import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildClassifier, CLASSIFICATION_PROMPT } from '../src/classifier/index.js';

describe('CLASSIFICATION_PROMPT', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof CLASSIFICATION_PROMPT, 'string');
    assert.ok(CLASSIFICATION_PROMPT.length > 100);
  });

  it('instructs JSON-only output', () => {
    assert.ok(CLASSIFICATION_PROMPT.toLowerCase().includes('json'));
  });

  it('includes all flag types', () => {
    const types = [
      'decision',
      'assumption',
      'architecture',
      'pattern',
      'dependency',
      'tradeoff',
      'constraint',
      'workaround',
      'risk',
    ];
    for (const type of types) {
      assert.ok(CLASSIFICATION_PROMPT.includes(type), `prompt should mention flag type: ${type}`);
    }
  });
});

describe('buildClassifier', () => {
  it('returns a function', () => {
    const classifier = buildClassifier({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      base_url: '',
    });
    assert.equal(typeof classifier, 'function');
  });

  it('returned function accepts content string and returns a promise', () => {
    // We mock the fetch to avoid real API calls in unit tests
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              response_summary: 'Agent decided to use JWT for authentication',
              flags: [
                { type: 'decision', content: 'Use JWT over session cookies', confidence: 0.95 },
                {
                  type: 'assumption',
                  content: 'Stateless architecture is preferred',
                  confidence: 0.8,
                },
              ],
            }),
          },
        ],
      }),
    });

    const classifier = buildClassifier(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = classifier('I decided to use JWT for auth because it is stateless');
    assert.ok(result instanceof Promise);
  });

  it('parses classifier response into summary and flags', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              response_summary: 'Agent chose JWT for auth',
              flags: [{ type: 'decision', content: 'Use JWT', confidence: 0.95 }],
            }),
          },
        ],
      }),
    });

    const classifier = buildClassifier(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await classifier('I will use JWT for authentication');
    assert.equal(typeof result.response_summary, 'string');
    assert.ok(Array.isArray(result.flags));
    assert.equal(result.flags[0].type, 'decision');
    assert.equal(result.flags[0].confidence, 0.95);
  });

  it('returns empty flags array when classifier returns none', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              response_summary: 'Agent listed some files',
              flags: [],
            }),
          },
        ],
      }),
    });

    const classifier = buildClassifier(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await classifier('ls -la');
    assert.deepEqual(result.flags, []);
  });

  it('handles malformed JSON from classifier gracefully', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'not valid json at all' }],
      }),
    });

    const classifier = buildClassifier(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await classifier('some content');
    assert.ok(typeof result.response_summary === 'string');
    assert.deepEqual(result.flags, []);
  });

  it('returns empty result (not an unhandled rejection) when the fetch hangs past timeout_ms', async () => {
    // fetchFn that never resolves unless aborted -- simulates a hung local
    // (ollama/lmstudio) endpoint. Rejects on abort like real fetch does.
    const hangingFetch = (_url, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    const classifier = buildClassifier(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '', timeout_ms: 50 },
      hangingFetch,
    );

    const result = await classifier('some content');
    assert.equal(result.response_summary, '');
    assert.deepEqual(result.flags, []);
  });

  it('builds correct endpoint for ollama provider', () => {
    let capturedUrl = null;
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"response_summary":"ok","flags":[]}' }],
        }),
      };
    };

    const classifier = buildClassifier(
      { provider: 'ollama', model: 'llama3.1', base_url: 'http://localhost:11434' },
      mockFetch,
    );

    return classifier('test').then(() => {
      assert.ok(
        capturedUrl.startsWith('http://localhost:11434'),
        `expected ollama URL, got ${capturedUrl}`,
      );
    });
  });

  it('requests the default max_tokens budget (single-turn output is small; the digest synthesizer overrides this separately)', async () => {
    let capturedBody;
    const mockFetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: '{"response_summary":"ok","flags":[]}' }],
        }),
      };
    };

    const classifier = buildClassifier(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    await classifier('test');
    assert.equal(capturedBody.max_tokens, 1000);
  });
});
