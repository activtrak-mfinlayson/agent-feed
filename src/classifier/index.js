export const CLASSIFICATION_PROMPT = `You are analyzing a response from a coding agent.
Your job is to extract structured information about decisions, assumptions, and other notable items.

Return ONLY a JSON object with no preamble, explanation, or markdown formatting. No backticks.

The JSON must have this exact shape:
{
  "response_summary": "2-3 sentence summary of what the agent did or said",
  "flags": [
    {
      "type": "one of the types listed below",
      "content": "specific item that was decided, assumed, introduced, etc.",
      "context": "1-2 sentences quoting or paraphrasing the specific part of the response that justifies this flag",
      "confidence": 0.0 to 1.0
    }
  ]
}

Flag types (use exactly these strings):
- decision: a choice the agent made between alternatives
- assumption: something the agent assumed to be true without verifying
- architecture: a structural or design choice about the system
- pattern: a design pattern or coding convention the agent applied
- dependency: a library, service, or external system the agent introduced
- tradeoff: an explicit acknowledgment that option A was chosen over option B
- constraint: a hard limit the agent identified as shaping the approach
- workaround: a temporary or non-ideal solution the agent knowingly applied
- risk: something the agent flagged as potentially problematic

Extract every qualifying flag you find. Include all flags with confidence >= 0.7.
If there are no qualifying flags, return an empty array.`;

export const DIGEST_SYNTHESIS_PROMPT = `You are condensing a coding agent session's extracted flags into a short digest for a human reviewer.

Return ONLY a JSON object with no preamble, explanation, or markdown formatting. No backticks.

The JSON must have this exact shape:
{
  "highlights": [
    {
      "summary": "1-2 sentence highlight describing a significant decision, risk, or pattern from the session",
      "flag_ids": ["id of each underlying flag this highlight summarizes"]
    }
  ]
}

You will be given a JSON array of flags, each with an "id", "type", "content", and "confidence".

Condense the flags into roughly a half-dozen (around 4-8) of the most significant highlights. Prioritize
flags of type decision, risk, architecture, tradeoff, and constraint over routine or duplicate-looking
flags (e.g. repeated assumption/pattern/dependency flags that don't materially change the reviewer's
understanding of the session). Group related or duplicate flags into a single highlight referencing all
of their ids where appropriate, rather than producing one highlight per flag.

Every flag_ids value must be an id that actually appears in the input flags. If there are no significant
flags, return an empty highlights array.`;

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function buildAnthropicBody(model, promptText, userMessage) {
  return {
    model,
    max_tokens: 1000,
    messages: [{ role: 'user', content: `${promptText}\n\n${userMessage}` }],
  };
}

function buildOpenAICompatibleBody(model, promptText, userMessage) {
  return {
    model,
    max_tokens: 1000,
    messages: [
      { role: 'system', content: promptText },
      { role: 'user', content: userMessage },
    ],
  };
}

/**
 * Shared provider-branching request/response plumbing for Anthropic vs.
 * OpenAI-compatible (ollama/lmstudio) LLM calls. Builds the provider-specific
 * request, sends it, and extracts the raw text of the model's reply.
 *
 * Returns the response text on success, or `null` if the upstream request
 * failed (non-ok HTTP status, network error, or timeout) -- callers are
 * responsible for turning `null` into their own empty/failure result shape,
 * since that shape differs between the classifier and the digest synthesizer.
 *
 * `config.timeout_ms` (falsy = no timeout) bounds how long the fetch is
 * allowed to hang before it's aborted and treated as a failure. This matters
 * most for the digest synthesizer, which -- unlike the fire-and-forget
 * classifier -- is awaited synchronously inside a live HTTP request.
 */
async function callLLMProvider(config, fetchFn, promptText, userMessage) {
  const { provider, model, base_url, timeout_ms } = config;

  let url;
  let body;
  const headers = { 'Content-Type': 'application/json' };

  if (provider === 'anthropic') {
    url = ANTHROPIC_API_URL;
    body = buildAnthropicBody(model, promptText, userMessage);
    // API key injected by environment at runtime
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    // ollama and lmstudio both expose OpenAI-compatible /v1/chat/completions
    url = `${base_url}/v1/chat/completions`;
    body = buildOpenAICompatibleBody(model, promptText, userMessage);
  }

  const controller = new AbortController();
  const timer = timeout_ms ? setTimeout(() => controller.abort(), timeout_ms) : null;

  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Covers both abort-on-timeout and ordinary network failures -- both are
    // treated the same as a non-ok response so callers' null-handling is
    // unchanged and no unhandled rejection escapes this call.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    return null;
  }

  const data = await response.json();

  // Handle both Anthropic and OpenAI response shapes
  if (provider === 'anthropic') {
    return data.content?.find(b => b.type === 'text')?.text ?? '';
  }
  return data.choices?.[0]?.message?.content ?? '';
}

// Shared by both response parsers below: strips markdown code fences (models
// sometimes wrap JSON in ```json blocks despite being told not to) and parses
// the result, returning null on any failure so callers apply their own
// field-specific defaults rather than duplicating this try/catch.
function parseFencedJson(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

function parseClassifierResponse(text) {
  const parsed = parseFencedJson(text);
  return {
    response_summary: parsed?.response_summary ?? '',
    flags: Array.isArray(parsed?.flags) ? parsed.flags : [],
  };
}

function parseDigestResponse(text) {
  const parsed = parseFencedJson(text);
  return {
    highlights: Array.isArray(parsed?.highlights) ? parsed.highlights : [],
  };
}

export function buildClassifier(config, fetchFn = fetch) {
  return async function classify(content) {
    const text = await callLLMProvider(
      config,
      fetchFn,
      CLASSIFICATION_PROMPT,
      `Agent response to analyze:\n\n${content}`,
    );

    if (text === null) {
      return { response_summary: '', flags: [] };
    }

    return parseClassifierResponse(text);
  };
}

/**
 * Builds a digest synthesizer: an async function that condenses a session's
 * flags into a small set of validated, highlight-worthy summaries. Reuses
 * the same provider-branching plumbing as `buildClassifier`, with a
 * different prompt and expected response shape.
 */
export function buildDigestSynthesizer(config, fetchFn = fetch) {
  return async function synthesize(flags) {
    if (!Array.isArray(flags) || flags.length === 0) {
      return { highlights: [] };
    }

    const text = await callLLMProvider(
      config,
      fetchFn,
      DIGEST_SYNTHESIS_PROMPT,
      `Flags to synthesize:\n\n${JSON.stringify(flags)}`,
    );

    if (text === null) {
      return { highlights: [] };
    }

    return parseDigestResponse(text);
  };
}

const FALLBACK_PROVIDERS = [
  { provider: 'ollama',    base_url: 'http://localhost:11434', model: 'llama3.1' },
  { provider: 'lmstudio', base_url: 'http://localhost:1234',  model: 'local-model' },
];

export async function validateClassifierWithFallback(config, fetchFn = fetch) {
  const tried = [];

  // 1. Try configured provider first
  const primary = await validateClassifier(config, fetchFn);
  if (primary.ok) {
    return { ...primary, provider: config.provider, base_url: config.base_url, effectiveConfig: config };
  }
  tried.push({ provider: config.provider, reason: primary.reason });

  // 2. Try local fallbacks (skip if configured provider is already that local provider)
  for (const fallback of FALLBACK_PROVIDERS) {
    if (fallback.provider === config.provider) continue;
    const result = await validateClassifier(fallback, fetchFn);
    if (result.ok) {
      const effectiveConfig = { ...config, ...fallback };
      return {
        ok: true,
        label: result.label,
        provider: fallback.provider,
        base_url: fallback.base_url,
        effectiveConfig,
      };
    }
    tried.push({ provider: fallback.provider, reason: result.reason });
  }

  // 3. Try Anthropic API key directly (covers SSO-adjacent setups with a separate classifier key)
  if (config.provider !== 'anthropic') {
    const anthropicConfig = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      base_url: '',
      timeout_ms: 30_000,
    };
    const result = await validateClassifier(anthropicConfig, fetchFn);
    if (result.ok) {
      return {
        ok: true,
        label: result.label,
        provider: 'anthropic',
        base_url: '',
        effectiveConfig: anthropicConfig,
      };
    }
    tried.push({ provider: 'anthropic', reason: result.reason });
  }

  // All failed
  const summary = tried.map(t => `${t.provider}: ${t.reason}`).join('; ');
  return {
    ok: false,
    reason: `No classifier available. Tried: ${summary}`,
  };
}


export async function validateClassifier(config, fetchFn = fetch) {
  const { provider, model, base_url } = config;

  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, reason: 'ANTHROPIC_API_KEY environment variable not set' };
    }
    return { ok: true, label: `anthropic/${model}` };
  }

  // For local providers, ping the models endpoint
  try {
    const url = provider === 'ollama'
      ? `${base_url}/api/tags`
      : `${base_url}/v1/models`;

    const res = await fetchFn(url);
    if (!res.ok) {
      return { ok: false, reason: `${provider} returned status ${res.status}` };
    }
    return { ok: true, label: `${provider}/${model} at ${base_url}` };
  } catch (err) {
    return { ok: false, reason: `${provider} unreachable at ${base_url}: ${err.message}` };
  }
}
