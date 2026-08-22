import process from 'node:process';

const runtimeMode = String(process.env.NODE_ENV || '').trim().toLowerCase();
// Fail closed: an omitted or misspelled NODE_ENV must never silently disable
// production security checks. Only explicitly declared development/test modes
// are allowed to use the relaxed local contract.
const production = runtimeMode !== 'development' && runtimeMode !== 'test';
const adapterSecret = String(process.env.CODEX_DEEPSEEK_ADAPTER_SECRET || '').trim();
const deepSeekKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
const openClawToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
const corsOrigin = String(process.env.CORS_ORIGIN || '').trim();

if (production) {
  if (adapterSecret.length < 32) {
    throw new Error('Production AI backend requires CODEX_DEEPSEEK_ADAPTER_SECRET with at least 32 characters');
  }
  if (deepSeekKey && deepSeekKey.length < 24) {
    throw new Error('Configured DEEPSEEK_API_KEY is unexpectedly short');
  }
  if (openClawToken && openClawToken.length < 24) {
    throw new Error('Configured OPENCLAW_GATEWAY_TOKEN is unexpectedly short');
  }
  if (!corsOrigin || corsOrigin === '*') {
    throw new Error('Production AI backend requires an explicit CORS_ORIGIN allowlist');
  }
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 8) {
    throw new Error('Production AI backend requires TRUST_PROXY_HOPS between 0 and 8');
  }
}

if (adapterSecret && adapterSecret.length < 32) {
  throw new Error('CODEX_DEEPSEEK_ADAPTER_SECRET must be at least 32 characters');
}

await import('./server.js');
