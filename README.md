# Streg

A simple drawing app for kids. Draw a scribble, describe it, and AI fills it in using [ControlNet Scribble](https://replicate.com/jagilley/controlnet-scribble).

No dark patterns, no infinite scroll, no ads. Just drawing and imagination.

## How it works

1. Enter the family PIN
2. Draw something on the canvas
3. Type what you drew (e.g. "a castle on a hill")
4. Hit "Make it real!" and watch the AI turn your scribble into art
5. Drafts auto-save to your browser so nothing gets lost

## Architecture

```
frontend/          Static HTML/CSS/JS - the drawing app
worker/            Cloudflare Worker - API proxy with auth
```

The worker stores the Replicate API key securely and handles simple PIN-based auth so you don't expose credentials in the browser.

## Setup

### 1. Get a Replicate API token

Sign up at [replicate.com](https://replicate.com) and grab an API token from your account settings.

### 2. Deploy the Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login

# Set your secrets
npx wrangler secret put REPLICATE_API_TOKEN   # paste your Replicate token
npx wrangler secret put FAMILY_PIN             # choose a family PIN (e.g. 1234)
npx wrangler secret put AUTH_SECRET            # any random string

# Deploy
npm run deploy
```

After deploying, Wrangler will print your worker URL (e.g. `https://streg-api.<you>.workers.dev`).

### 3. Configure the frontend

Open the app in a browser, then set the worker URL in the browser console:

```js
localStorage.setItem("streg_worker_url", "https://streg-api.<you>.workers.dev")
```

Or edit `frontend/app.js` line 3 to hardcode it.

### 4. Serve the frontend

For local development:
```bash
cd frontend
npx serve .
```

For production, deploy to Cloudflare Pages, Netlify, or any static host.

### Optional: Lock down CORS

In `worker/wrangler.toml`, uncomment and set `ALLOWED_ORIGIN` to your frontend domain to restrict API access.

## Cost

ControlNet Scribble costs ~$0.005 per image on Replicate. A kid going wild with it might generate $1-2/day worth of images.
