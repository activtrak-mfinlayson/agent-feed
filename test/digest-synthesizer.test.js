import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDigestSynthesizer, DIGEST_SYNTHESIS_PROMPT } from '../src/classifier/index.js';

const MOCK_FLAGS = [
  { id: 1, type: 'decision', content: 'Use JWT over session cookies', confidence: 0.95 },
  { id: 2, type: 'risk', content: 'No rate limiting on the login endpoint', confidence: 0.85 },
  { id: 3, type: 'assumption', content: 'Stateless architecture is preferred', confidence: 0.8 },
];

describe('DIGEST_SYNTHESIS_PROMPT', () => {
  it('is a non-empty string', () => {
    assert.equal(typeof DIGEST_SYNTHESIS_PROMPT, 'string');
    assert.ok(DIGEST_SYNTHESIS_PROMPT.length > 100);
  });

  it('instructs JSON-only output', () => {
    assert.ok(DIGEST_SYNTHESIS_PROMPT.toLowerCase().includes('json'));
  });

  it('mentions the highlight-worthy flag types', () => {
    const types = ['decision', 'risk', 'architecture', 'tradeoff', 'constraint'];
    for (const type of types) {
      assert.ok(DIGEST_SYNTHESIS_PROMPT.includes(type), `prompt should mention flag type: ${type}`);
    }
  });
});

describe('buildDigestSynthesizer', () => {
  it('returns a function', () => {
    const synthesizer = buildDigestSynthesizer({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      base_url: '',
    });
    assert.equal(typeof synthesizer, 'function');
  });

  it('parses highlights from an Anthropic-shaped response', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              highlights: [
                { summary: 'Chose JWT auth over sessions', flag_ids: [1] },
                { summary: 'Login endpoint lacks rate limiting', flag_ids: [2] },
              ],
            }),
          },
        ],
      }),
    });

    const synthesizer = buildDigestSynthesizer(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await synthesizer(MOCK_FLAGS);
    assert.ok(Array.isArray(result.highlights));
    assert.equal(result.highlights.length, 2);
    assert.equal(result.highlights[0].summary, 'Chose JWT auth over sessions');
    assert.deepEqual(result.highlights[0].flag_ids, [1]);
  });

  it('parses highlights from an OpenAI-compatible (ollama/lmstudio) response', async () => {
    let capturedUrl = null;
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  highlights: [{ summary: 'Chose JWT auth over sessions', flag_ids: [1, 3] }],
                }),
              },
            },
          ],
        }),
      };
    };

    const synthesizer = buildDigestSynthesizer(
      { provider: 'ollama', model: 'llama3.1', base_url: 'http://localhost:11434' },
      mockFetch,
    );

    const result = await synthesizer(MOCK_FLAGS);
    assert.ok(
      capturedUrl.startsWith('http://localhost:11434'),
      `expected ollama URL, got ${capturedUrl}`,
    );
    assert.equal(result.highlights.length, 1);
    assert.deepEqual(result.highlights[0].flag_ids, [1, 3]);
  });

  it('returns empty highlights for empty flags input without calling the provider', async () => {
    let called = false;
    const mockFetch = async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    };

    const synthesizer = buildDigestSynthesizer(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await synthesizer([]);
    assert.deepEqual(result, { highlights: [] });
    assert.equal(called, false);
  });

  it('returns empty highlights when the provider responds with a non-ok status', async () => {
    const mockFetch = async () => ({ ok: false, status: 500 });

    const synthesizer = buildDigestSynthesizer(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await synthesizer(MOCK_FLAGS);
    assert.deepEqual(result, { highlights: [] });
  });

  it('returns empty highlights (not an unhandled rejection) when the fetch hangs past timeout_ms', async () => {
    // A hung local endpoint (e.g. ollama/lmstudio) is exactly the failure
    // mode this timeout exists for: the digest route awaits this call
    // synchronously inside a live HTTP request the UI polls and blocks on.
    const hangingFetch = (_url, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    const synthesizer = buildDigestSynthesizer(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '', timeout_ms: 50 },
      hangingFetch,
    );

    const result = await synthesizer(MOCK_FLAGS);
    assert.deepEqual(result, { highlights: [] });
  });

  it('returns empty highlights when the provider returns malformed/non-JSON text', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'not valid json at all' }],
      }),
    });

    const synthesizer = buildDigestSynthesizer(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    const result = await synthesizer(MOCK_FLAGS);
    assert.deepEqual(result, { highlights: [] });
  });

  it('requests a larger max_tokens budget than the classifier default, to avoid truncating large sessions mid-JSON', async () => {
    // Regression test: a real 860-flag session truncated at max_tokens 1000
    // (stop_reason "max_tokens"), producing unparseable JSON and a silent
    // "unavailable" digest. See DIGEST_MAX_TOKENS in src/classifier/index.js.
    let capturedBody;
    const mockFetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ highlights: [] }) }],
        }),
      };
    };

    const synthesizer = buildDigestSynthesizer(
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', base_url: '' },
      mockFetch,
    );

    await synthesizer(MOCK_FLAGS);
    assert.ok(
      capturedBody.max_tokens > 1000,
      `expected max_tokens > 1000, got ${capturedBody.max_tokens}`,
    );
  });
});
