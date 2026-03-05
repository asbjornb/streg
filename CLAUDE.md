# Streg

A kid-friendly drawing app that uses AI (ControlNet Scribble via Replicate) to turn scribbles into art.

## Project structure

```
frontend/           Static HTML/CSS/JS drawing app (no build step, no framework)
  index.html        Main page - PIN screen + drawing canvas + results
  style.css         All styles - warm, kid-friendly palette
  app.js            Drawing logic, auth, API calls, draft saving

worker/             Cloudflare Worker - API proxy
  src/index.js      Routes: /auth, /generate, /status/:id
  wrangler.toml     Worker config (secrets configured via `wrangler secret put`)
  package.json      Just wrangler as a dev dependency
```

## Key design decisions

- **No frameworks, no build step.** The frontend is plain HTML/CSS/JS served as static files. Keep it that way.
- **No dark patterns.** No analytics, no tracking, no infinite scroll, no notifications. This is a creativity tool for kids.
- **Credentials stay server-side.** The Replicate API token is stored as a Cloudflare Worker secret. The frontend never sees it.
- **PIN auth is intentionally simple.** Family shares a PIN; the worker returns a 24h HMAC-signed token. No user accounts, no passwords, no email.
- **Drafts auto-save to localStorage.** Canvas state saves every second after a stroke. History of generated images also stored in localStorage.
- **Touch-first.** The canvas supports touch events for tablets/phones. The viewport disables pinch-to-zoom to avoid interfering with drawing.

## Worker secrets

These are set via `npx wrangler secret put <NAME>`, not in code:
- `REPLICATE_API_TOKEN` - Replicate API key
- `FAMILY_PIN` - The shared family PIN
- `AUTH_SECRET` - Random string used to HMAC-sign auth tokens

## How the API flow works

1. Frontend sends PIN to `POST /auth` -> gets back an HMAC-signed token
2. Frontend sends canvas (base64 PNG) + prompt to `POST /generate` with the token
3. Worker proxies to Replicate's predictions API, returns a prediction ID
4. Frontend polls `GET /status/:id` every 2s until the prediction succeeds or fails
5. Result images (URLs from Replicate) are displayed and saved to localStorage history

## Development

Serve the frontend locally:
```bash
cd frontend && npx serve .
```

Run the worker locally:
```bash
cd worker && npm install && npx wrangler dev
```
For local dev, create `worker/.dev.vars` with the three secrets (one per line, `KEY=value` format).

## Tests

Run frontend tests:
```bash
cd frontend && npm install && npm test
```

Tests use vitest + jsdom to exercise `app.js` in a simulated browser environment.
