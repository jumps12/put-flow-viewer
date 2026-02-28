#!/usr/bin/env node
// ─── Anthropic API Proxy ───────────────────────────────────────────────────────
// Keeps your API key server-side. Run before opening the app:
//   ANTHROPIC_API_KEY=sk-ant-... node server.js
//
// Listens on http://localhost:3001
// One endpoint: POST /analyze  { prompt: string } → Anthropic response JSON
// ──────────────────────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');

const PORT    = 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const MODEL   = 'claude-sonnet-4-6';

const SYSTEM_PROMPT =
  'You are an expert options flow analyst. Analyze the following institutional ' +
  'options flow data and write a concise 3-4 sentence trade narrative in the ' +
  'style of a professional trader. Focus on: what the flow implies directionally, ' +
  'key strike levels to watch, any notable patterns (repeat flow, large size, ' +
  'unusual expiry), and a specific actionable idea. Be direct and confident. ' +
  'Do not use bullet points. Write in plain conversational trader language.';

if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  console.error('Usage: ANTHROPIC_API_KEY=sk-ant-... node server.js');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method !== 'POST' || req.url !== '/analyze') {
    res.writeHead(404); res.end('Not found'); return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let prompt;
    try   { prompt = JSON.parse(body).prompt; }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad JSON' })); return; }

    if (!prompt || typeof prompt !== 'string') {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Missing prompt' })); return;
    }

    const payload = JSON.stringify({
      model:      MODEL,
      max_tokens: 400,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(payload),
      },
    };

    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });

    proxyReq.on('error', err => {
      console.error('Anthropic request error:', err.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.write(payload);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Anthropic proxy ready → http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log('Press Ctrl+C to stop.\n');
});
