# Streg

**Draw a scribble. Describe it. Watch AI turn it into art.**

Streg (Danish for "line" / "stroke") is a simple drawing app for kids. It uses [ControlNet Scribble](https://replicate.com/jagilley/controlnet-scribble) via Replicate to transform children's drawings into detailed images. No dark patterns, no infinite scroll, no ads - just drawing and imagination.

## How it works

1. Enter the family PIN to unlock
2. Draw something on the canvas (works great on tablets!)
3. Type what you drew - e.g. *"a castle on a hill"* or *"a dog in space"*
4. Tap **"Make it real!"** and wait a few seconds
5. See your scribble come to life

Drafts auto-save to the browser, so nothing gets lost if the page is closed.

## Architecture

```
frontend/          Plain HTML/CSS/JS - no build step, no framework
worker/            Cloudflare Worker - keeps the API key safe, handles auth
```

The Cloudflare Worker acts as a thin proxy between the browser and Replicate. It stores the API key as a secret so it's never exposed to the client. Auth is a simple shared family PIN - no accounts, no emails, no passwords.

## Setup

### 1. Get a Replicate API token

Sign up at [replicate.com](https://replicate.com) and grab an API token from your [account settings](https://replicate.com/account/api-tokens).

### 2. Deploy the Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login

# Set your secrets (you'll be prompted to enter each value)
npx wrangler secret put REPLICATE_API_TOKEN
npx wrangler secret put FAMILY_PIN
npx wrangler secret put AUTH_SECRET    # any random string, used to sign tokens

# Deploy
npm run deploy
```

Wrangler will print your worker URL, e.g. `https://streg-api.<you>.workers.dev`.

### 3. Configure and serve the frontend

Set the worker URL in the browser console after opening the app:

```js
localStorage.setItem("streg_worker_url", "https://streg-api.<you>.workers.dev")
```

Or hardcode it in `frontend/app.js` (line 3).

**Local development:**
```bash
cd frontend
npx serve .
```

**Production:** deploy to [Cloudflare Pages](https://pages.cloudflare.com/), Netlify, or any static host.

### 4. (Optional) Lock down CORS

In `worker/wrangler.toml`, uncomment the `[vars]` section and set `ALLOWED_ORIGIN` to your frontend domain to restrict API access.

## Local development with the worker

Create a `worker/.dev.vars` file with your secrets:

```
REPLICATE_API_TOKEN=r8_your_token_here
FAMILY_PIN=1234
AUTH_SECRET=some-random-string
```

Then run `cd worker && npx wrangler dev` alongside the frontend.

## Cost

ControlNet Scribble costs roughly **$0.005 per image** on Replicate. Even a kid going wild would be hard-pressed to spend more than $1-2/day.

## License

MIT
