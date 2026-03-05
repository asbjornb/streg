// Integration tests for Replicate API calls.
// These hit the real Replicate API and cost real money — run deliberately.
//
// Required env var: REPLICATE_API_TOKEN
//
// Run:  cd worker && npm test
// Skip: omit the env var and tests auto-skip.

import { describe, it, expect, beforeAll } from "vitest";

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const BASE = "https://api.replicate.com/v1";

// Tiny 8×8 white PNG with a black diagonal stroke (valid base64 data URI).
// Small enough to inline, large enough for models to accept.
const TEST_IMAGE = (() => {
  // Build a minimal 8×8 PNG programmatically isn't practical in a one-liner,
  // so we use a pre-encoded 4×4 red-pixel PNG (smallest valid PNG).
  // Models accept any valid image — the content doesn't matter for integration smoke tests.
  return "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAADklEQVQI12P4z8BQDwAEgAF/" +
    "QualNQAAAABJRU5ErkJggg==";
})();

// Model versions used in production
const BLIP2_VERSION = "f677695e5e89f8b236e52ecd1d3f01beb44c34606419bcc19345e046d8f786f9";
const CONTROLNET_VERSION = "435061a1b5a4c1e26740464bf786efdfa9cb3a3ac488595a2de23e143fdb0117";

function replicateHeaders(prefer) {
  const h = {
    "Authorization": "Bearer " + REPLICATE_API_TOKEN,
    "Content-Type": "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

// Retry-aware fetch: waits and retries on 429 (rate limit) responses.
// The Replicate account has a burst limit of 1 when credits are low,
// so sequential tests need to respect retry_after between requests.
async function fetchWithRetry(url, options, { maxRetries = 3 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt === maxRetries) return res;
    const body = await res.json();
    const waitSec = body.retry_after || 10;
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }
}

// Cancel a prediction so we don't burn GPU time waiting for full generation.
async function cancelPrediction(id) {
  try {
    await fetch(`${BASE}/predictions/${id}/cancel`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + REPLICATE_API_TOKEN },
    });
  } catch { /* best-effort */ }
}

// Helper: poll a prediction until it reaches a terminal state or timeout.
async function pollUntilDone(id, { timeoutMs = 120_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/predictions/${id}`, {
      headers: { "Authorization": "Bearer " + REPLICATE_API_TOKEN },
    });
    expect(res.ok).toBe(true);
    const prediction = await res.json();
    if (["succeeded", "failed", "canceled"].includes(prediction.status)) {
      return prediction;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Prediction ${id} did not complete within ${timeoutMs}ms`);
}

describe.skipIf(!REPLICATE_API_TOKEN)("Replicate integration tests", () => {

  // ── BLIP-2: visual question answering (synchronous) ─────────────────

  describe("BLIP-2 caption", () => {
    it("returns a text caption for an image", async () => {
      const res = await fetchWithRetry(`${BASE}/predictions`, {
        method: "POST",
        headers: replicateHeaders("wait"),
        body: JSON.stringify({
          version: BLIP2_VERSION,
          input: {
            image: TEST_IMAGE,
            task: "visual_question_answering",
            question: "What are the main objects? Answer with the nouns/objects, no mention of drawing/sketch/black-and-white or other medium style words.",
          },
        }),
      });

      const prediction = await res.json();
      expect(res.ok, `BLIP-2 HTTP ${res.status}: ${JSON.stringify(prediction)}`).toBe(true);
      expect(prediction.status, `BLIP-2 prediction failed: ${JSON.stringify(prediction.error || prediction)}`).toBe("succeeded");
      expect(prediction.output).toBeTruthy();
      // Output should be a non-empty string
      const caption = typeof prediction.output === "string"
        ? prediction.output
        : String(prediction.output);
      expect(caption.length).toBeGreaterThan(0);

      // Verify metrics are present (used for cost tracking)
      expect(prediction.metrics).toBeDefined();
      expect(typeof prediction.metrics.predict_time).toBe("number");
    }, 60_000);
  });

  // ── Llama 3 8B: prompt enrichment (synchronous) ─────────────────────

  describe("Llama 3 8B enrichment", () => {
    it("generates an enriched prompt from a caption", async () => {
      const llmPrompt = `A child drew "a cat". Write a short image generation prompt (under 30 words) that describes this subject with a fitting, colorful background that contrasts with the subject so it stands out clearly. Specify children's picture book illustration, bright colors, clean edges. No filler words. Only output the prompt, nothing else.`;

      const res = await fetchWithRetry(`${BASE}/models/meta/meta-llama-3-8b-instruct/predictions`, {
        method: "POST",
        headers: replicateHeaders("wait"),
        body: JSON.stringify({
          input: {
            prompt: llmPrompt,
            max_tokens: 60,
            temperature: 0.7,
          },
        }),
      });

      const prediction = await res.json();
      expect(res.ok, `Llama HTTP ${res.status}: ${JSON.stringify(prediction)}`).toBe(true);
      expect(prediction.status, `Llama prediction failed: ${JSON.stringify(prediction.error || prediction)}`).toBe("succeeded");
      expect(prediction.output).toBeTruthy();

      // Output is an array of token strings
      const text = Array.isArray(prediction.output)
        ? prediction.output.join("")
        : String(prediction.output);
      expect(text.trim().length).toBeGreaterThan(0);

      expect(prediction.metrics).toBeDefined();
      expect(typeof prediction.metrics.predict_time).toBe("number");
    }, 60_000);
  });

  // ── ControlNet Scribble: image generation (async + poll) ────────────

  describe("ControlNet Scribble generation", () => {
    it("creates an async prediction and returns a valid prediction ID", async () => {
      const res = await fetchWithRetry(`${BASE}/predictions`, {
        method: "POST",
        headers: replicateHeaders("respond-async"),
        body: JSON.stringify({
          version: CONTROLNET_VERSION,
          input: {
            image: TEST_IMAGE,
            prompt: "a colorful cat, children's picture book illustration",
            num_samples: "1",
            image_resolution: "512",
            ddim_steps: 20,
            scale: 9,
            seed: 42,
            eta: 0,
            a_prompt: "best quality, extremely detailed, colorful, vibrant",
            n_prompt: "lowres, bad anatomy, worst quality, low quality",
          },
        }),
      });

      const prediction = await res.json();
      expect(res.ok, `ControlNet HTTP ${res.status}: ${JSON.stringify(prediction)}`).toBe(true);
      expect(prediction.id).toBeTruthy();
      expect(typeof prediction.id).toBe("string");
      // Async predictions start in "starting" or "processing"
      expect(["starting", "processing"]).toContain(prediction.status);

      // Poll until done to verify full pipeline works
      const result = await pollUntilDone(prediction.id);
      expect(result.status).toBe("succeeded");
      expect(Array.isArray(result.output)).toBe(true);
      expect(result.output.length).toBeGreaterThan(0);
      // Output should be image URLs
      expect(result.output[0]).toMatch(/^https?:\/\//);
    }, 180_000);
  });

  // ── Status polling: GET /predictions/:id ────────────────────────────

  describe("Status polling", () => {
    it("returns prediction status for a known prediction", async () => {
      // Create a quick sync prediction (BLIP-2) to get a real ID
      const createRes = await fetchWithRetry(`${BASE}/predictions`, {
        method: "POST",
        headers: replicateHeaders("wait"),
        body: JSON.stringify({
          version: BLIP2_VERSION,
          input: {
            image: TEST_IMAGE,
            task: "image_captioning",
          },
        }),
      });

      const created = await createRes.json();
      expect(createRes.ok, `Status-poll BLIP-2 HTTP ${createRes.status}: ${JSON.stringify(created)}`).toBe(true);
      const predictionId = created.id;
      expect(predictionId).toBeTruthy();

      // Now poll for its status (it should already be succeeded)
      const statusRes = await fetch(`${BASE}/predictions/${predictionId}`, {
        headers: { "Authorization": "Bearer " + REPLICATE_API_TOKEN },
      });

      expect(statusRes.ok).toBe(true);
      const status = await statusRes.json();
      expect(status.id).toBe(predictionId);
      expect(status.status).toBe("succeeded");
      // The full prediction object should include output and metrics
      expect(status.output).toBeTruthy();
      expect(status.metrics).toBeDefined();
    }, 60_000);

    it("returns 404 for a nonexistent prediction ID", async () => {
      const res = await fetch(`${BASE}/predictions/nonexistent000000`, {
        headers: { "Authorization": "Bearer " + REPLICATE_API_TOKEN },
      });

      // Replicate returns 404 for unknown IDs
      expect(res.status).toBe(404);
    }, 15_000);
  });
});
