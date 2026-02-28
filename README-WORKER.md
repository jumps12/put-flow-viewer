# AI Analysis — Cloudflare Worker Setup

The signals page uses an AI analysis feature powered by Claude. Because the Anthropic API
blocks direct browser requests (CORS), a small Cloudflare Worker acts as a proxy.

---

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) installed

---

## 1. Install Wrangler (Cloudflare CLI)

```bash
npm install -g wrangler
wrangler login
```

---

## 2. Create the Worker

```bash
# From the repo root
wrangler init options-ai --no-bundle
```

When prompted:
- **Type**: `"Hello World" worker`
- **TypeScript**: No

Replace the generated `src/index.js` content with the contents of `cloudflare-worker.js`
from this repo.

---

## 3. Set the API Key Secret

```bash
wrangler secret put ANTHROPIC_API_KEY
```

Paste your Anthropic API key (`sk-ant-...`) when prompted. It is stored encrypted in
Cloudflare — it never appears in your code or repo.

---

## 4. Deploy

```bash
wrangler deploy
```

Wrangler will print your worker URL, which looks like:

```
https://options-ai.<your-subdomain>.workers.dev
```

---

## 5. Update config.js

Open `config.js` and set the worker URL:

```js
const CONFIG = {
  CORS_PROXY:  'https://corsproxy.io/?',
  AI_WORKER:   'https://options-ai.<your-subdomain>.workers.dev',
};
```

Commit and push — the signals page will now use your worker for AI analysis.

---

## How It Works

```
Browser (GitHub Pages)
  → POST https://options-ai.<subdomain>.workers.dev
      ↓ (Cloudflare Worker adds x-api-key from secret)
  → POST https://api.anthropic.com/v1/messages
      ↓
  ← JSON response
      ↓ (Worker adds CORS headers)
  ← Response to browser
```

The `ANTHROPIC_API_KEY` secret is only ever visible inside the Worker — it is never
sent to the browser or committed to the repo.

---

## Free Tier Limits

Cloudflare Workers free plan allows **100,000 requests/day**, which is more than enough
for personal use.
