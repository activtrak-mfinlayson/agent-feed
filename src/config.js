import fs from 'node:fs';
import TOML from 'toml';

export const defaultConfig = {
  proxy: {
    port: 18080,
    upstream_timeout: 120000,
    max_capture_size: 10 * 1024 * 1024, // 10MB — skip capture (not truncate) above this
  },
  ui: {
    port: 3000,
  },
  classifier: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    base_url: '',
    timeout_ms: 30_000, // outbound LLM fetch timeout; classifier call is fire-and-forget so this just bounds worst-case latency
  },
  storage: {
    path: '~/.agent-feed/feed.db',
  },
  otel: {
    enabled: true,
    host: '127.0.0.1',
    port: 4318,
    max_body_bytes: 1_000_000,
  },
  digest: {
    enabled: true,
    flag_threshold: 20,
    active_window_minutes: 10,
    model: '', // empty = use the classifier's resolved model as-is; non-empty overrides only the model name
    timeout_ms: null, // null = inherit the classifier's timeout_ms; non-null overrides only the digest call's timeout. Matters more here than for the classifier: this call is awaited synchronously by a live HTTP request the UI polls and blocks on.
  },
};

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object'
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

export function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { ...defaultConfig };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = TOML.parse(raw);
  return deepMerge(defaultConfig, parsed);
}
