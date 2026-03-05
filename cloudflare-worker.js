// ─── Cloudflare Worker — Anthropic API Proxy ──────────────────────────────────
// Deploy this worker to Cloudflare and set the ANTHROPIC_API_KEY secret.
// See README-WORKER.md for full deployment instructions.
// ──────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN  = 'https://jumps12.github.io';
const ANTHROPIC_URL   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER   = '2023-06-01';
const ANTHROPIC_BETA  = 'prompt-caching-2024-07-31';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    // Validate origin
    const origin = request.headers.get('Origin') ?? '';
    if (origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
    }

    let parsed;
    try {
      parsed = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Inject cache_control into the system prompt so Anthropic caches it between
    // requests. This avoids re-billing the full system prompt token count every call.
    // A string system becomes a single-block array; an existing array gets cache_control
    // added to its last block (caching applies from that point backward).
    const { system: rawSystem, ...rest } = parsed;
    let system;
    if (typeof rawSystem === 'string' && rawSystem) {
      system = [{ type: 'text', text: rawSystem, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(rawSystem) && rawSystem.length) {
      system = rawSystem.map((block, i) =>
        i === rawSystem.length - 1 ? { ...block, cache_control: { type: 'ephemeral' } } : block
      );
    } else {
      system = rawSystem; // null / undefined — pass through unchanged
    }

    const outBody = JSON.stringify({ ...rest, ...(system != null && { system }) });

    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VER,
        'anthropic-beta':    ANTHROPIC_BETA,
      },
      body: outBody,
    });

    const upstreamBody = await upstream.text();

    return new Response(upstreamBody, {
      status:  upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
      },
    });
  },
};
