// Streg API Worker
// Proxies drawing requests to Replicate's ControlNet Scribble model
// with simple PIN-based family auth.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === "/auth" && request.method === "POST") {
        return handleAuth(request, env, corsHeaders);
      }

      if (url.pathname === "/describe" && request.method === "POST") {
        return handleDescribe(request, env, corsHeaders);
      }

      if (url.pathname.startsWith("/describe/status/") && request.method === "GET") {
        const id = url.pathname.split("/describe/status/")[1];
        return handleDescribeStatus(request, env, corsHeaders, id);
      }

      if (url.pathname === "/generate" && request.method === "POST") {
        return handleGenerate(request, env, corsHeaders);
      }

      if (url.pathname.startsWith("/status/") && request.method === "GET") {
        const id = url.pathname.split("/status/")[1];
        return handleStatus(request, env, corsHeaders, id);
      }

      if (url.pathname === "/costs" && request.method === "GET") {
        return handleCosts(request, env, corsHeaders);
      }

      return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    } catch (err) {
      console.error("Unhandled worker error:", err?.message, err?.stack);
      return jsonResponse({ error: "Internal error", detail: err?.message || "Unknown" }, 500, corsHeaders);
    }
  },
};

// === Auth: verify PIN, return a simple signed token ===

async function handleAuth(request, env, cors) {
  const { pin } = await request.json();

  if (!pin || pin !== env.FAMILY_PIN) {
    return jsonResponse({ ok: false }, 401, cors);
  }

  // Create a simple token: timestamp + HMAC
  const timestamp = Date.now().toString();
  const token = timestamp + "." + await sign(timestamp, env.AUTH_SECRET);

  return jsonResponse({ ok: true, token }, 200, cors);
}

async function verifyToken(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace("Bearer ", "");

  if (!token || !token.includes(".")) return false;

  const [timestamp, signature] = token.split(".");
  const expected = await sign(timestamp, env.AUTH_SECRET);

  if (signature !== expected) return false;

  // Tokens valid for 24 hours
  const age = Date.now() - parseInt(timestamp, 10);
  return age < 24 * 60 * 60 * 1000;
}

async function sign(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// === Describe: use BLIP to caption a scribble drawing (async) ===

async function handleDescribe(request, env, cors) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  const { image } = await request.json();

  if (!image) {
    return jsonResponse({ error: "Need an image" }, 400, cors);
  }

  // Use BLIP-2 in VQA mode to identify subjects without medium/style words
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
      "Content-Type": "application/json",
      "Prefer": "respond-async",
    },
    body: JSON.stringify({
      version: "2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746",
      input: {
        image,
        task: "visual_question_answering",
        question: "What are the main objects? Answer with the nouns/objects, no mention of drawing/sketch/black-and-white or other medium style words.",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const detail = parseReplicateError(res.status, body);
    console.error("Replicate describe error:", res.status, body);
    return jsonResponse({
      error: "AI service error",
      step: "describe",
      detail,
      replicate_status: res.status,
    }, 502, cors);
  }

  const prediction = await res.json();

  return jsonResponse({
    id: prediction.id,
    status: prediction.status || "starting",
    type: "describe",
  }, 200, cors);
}

// === Describe Status: poll BLIP prediction, enrich when done ===

async function handleDescribeStatus(request, env, cors, predictionId) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  if (!/^[a-z0-9]+$/.test(predictionId)) {
    return jsonResponse({ error: "Invalid ID" }, 400, cors);
  }

  const res = await fetch(
    `https://api.replicate.com/v1/predictions/${predictionId}`,
    { headers: { "Authorization": "Bearer " + env.REPLICATE_API_TOKEN } }
  );

  if (!res.ok) {
    const body = await res.text();
    const detail = parseReplicateError(res.status, body);
    console.error("Replicate describe status check error:", res.status, body);
    return jsonResponse({ error: "Could not check status", step: "describe-status", detail }, 502, cors);
  }

  const prediction = await res.json();

  // Track cost when prediction completes
  if (prediction.status === "succeeded" || prediction.status === "failed") {
    try { await trackCost(prediction, env); } catch (e) { console.error("Cost tracking error:", e); }
  }

  if (prediction.status === "failed" || prediction.status === "canceled") {
    console.error("Describe prediction failed:", prediction.id, prediction.error);
    return jsonResponse({
      id: prediction.id,
      status: prediction.status,
      type: "describe",
      error: prediction.error || "Could not describe the drawing",
    }, 200, cors);
  }

  if (prediction.status === "succeeded" && prediction.output) {
    const rawCaption = (typeof prediction.output === "string" ? prediction.output : prediction.output.toString())
      .replace(/^(Caption|Answer):\s*/i, "").trim();

    // If frontend passed an enrich ID from a previous poll, check it
    const enrichId = new URL(request.url).searchParams.get("enrich");
    if (enrichId) {
      const enrichResult = await checkEnrichment(enrichId, rawCaption, env);
      return jsonResponse({
        id: prediction.id,
        status: "succeeded",
        type: "describe",
        subject: rawCaption,
        prompt: enrichResult,
      }, 200, cors);
    }

    // First time BLIP succeeded — kick off enrichment async, don't wait
    const enrichPredictionId = await startEnrichment(rawCaption, env);

    if (enrichPredictionId) {
      return jsonResponse({
        id: prediction.id,
        status: "enriching",
        type: "describe",
        subject: rawCaption,
        enrich_id: enrichPredictionId,
      }, 200, cors);
    }

    // Enrichment failed to start — return raw caption as prompt
    return jsonResponse({
      id: prediction.id,
      status: "succeeded",
      type: "describe",
      subject: rawCaption,
      prompt: rawCaption,
    }, 200, cors);
  }

  // Still processing
  return jsonResponse({
    id: prediction.id,
    status: prediction.status,
    type: "describe",
  }, 200, cors);
}

// === Enrich caption with a contrasting background using an LLM (async, non-blocking) ===

const LLAMA_MODEL_NAME = "meta-llama-3-8b";

// Fire off LLM enrichment, return prediction ID without waiting for result
async function startEnrichment(caption, env) {
  try {
    const res = await fetch("https://api.replicate.com/v1/models/meta/meta-llama-3-8b-instruct/predictions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
        "Content-Type": "application/json",
        "Prefer": "respond-async",
      },
      body: JSON.stringify({
        input: {
          prompt: `A child drew "${caption}". Write a short image generation prompt (under 30 words) that describes this subject with a fitting, colorful background that contrasts with the subject so it stands out clearly. Specify children's picture book illustration, bright colors, clean edges. No filler words. Only output the prompt, nothing else.`,
          max_tokens: 60,
          temperature: 0.7,
        },
      }),
    });

    if (!res.ok) return null;

    const prediction = await res.json();

    // If completed synchronously (rare but possible)
    if (prediction.status === "succeeded") return prediction.id;

    return prediction.id || null;
  } catch {
    return null;
  }
}

// Check enrichment prediction once — return enriched prompt or fallback to raw caption
async function checkEnrichment(enrichId, fallback, env) {
  if (!/^[a-z0-9]+$/.test(enrichId)) return fallback;

  try {
    const res = await fetch(
      `https://api.replicate.com/v1/predictions/${enrichId}`,
      { headers: { "Authorization": "Bearer " + env.REPLICATE_API_TOKEN } }
    );

    if (!res.ok) return fallback;

    const result = await res.json();

    if (result.status === "succeeded" && result.output) {
      try { await trackCost({ ...result, _model_name: LLAMA_MODEL_NAME }, env); } catch (e) { console.error("Cost tracking error:", e); }
      const text = Array.isArray(result.output) ? result.output.join("") : result.output;
      return text.trim().replace(/^["']|["']$/g, "") || fallback;
    }

    // Still processing or failed — return raw caption, don't block
    return fallback;
  } catch {
    return fallback;
  }
}

// === Generate: send drawing to Replicate ===

async function handleGenerate(request, env, cors) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  const { image, prompt } = await request.json();

  if (!image || !prompt) {
    return jsonResponse({ error: "Need both image and prompt" }, 400, cors);
  }

  // Call Replicate API to create a prediction
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
      "Content-Type": "application/json",
      "Prefer": "respond-async",
    },
    body: JSON.stringify({
      version: "435061a1b5a4c1e26740464bf786efdfa9cb3a3ac488595a2de23e143fdb0117",
      input: {
        image,
        prompt,
        num_samples: "1",
        image_resolution: "512",
        ddim_steps: 20,
        scale: 9,
        seed: Math.floor(Math.random() * 2147483647),
        eta: 0,
        a_prompt: "best quality, extremely detailed, colorful, vibrant, subject clearly distinct from background, contrasting background, well-defined edges",
        n_prompt: "longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, subject blending into background, uniform texture, monochrome background",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const detail = parseReplicateError(res.status, body);
    console.error("Replicate generate error:", res.status, body);
    return jsonResponse({
      error: "AI service error",
      step: "generate",
      detail,
      replicate_status: res.status,
    }, 502, cors);
  }

  const prediction = await res.json();
  return jsonResponse({
    id: prediction.id,
    status: prediction.status,
    output: prediction.output,
  }, 200, cors);
}

// === Status: poll for prediction result ===

async function handleStatus(request, env, cors, predictionId) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  // Sanitize prediction ID
  if (!/^[a-z0-9]+$/.test(predictionId)) {
    return jsonResponse({ error: "Invalid ID" }, 400, cors);
  }

  const res = await fetch(
    `https://api.replicate.com/v1/predictions/${predictionId}`,
    {
      headers: {
        "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    const detail = parseReplicateError(res.status, body);
    console.error("Replicate status check error:", res.status, body);
    return jsonResponse({ error: "Could not check status", step: "poll-status", detail }, 502, cors);
  }

  const prediction = await res.json();

  // Track cost when prediction completes
  if (prediction.status === "succeeded" || prediction.status === "failed") {
    try { await trackCost(prediction, env); } catch (e) { console.error("Cost tracking error:", e); }
  }

  return jsonResponse({
    id: prediction.id,
    status: prediction.status,
    output: prediction.output,
    error: prediction.error,
  }, 200, cors);
}

// === Cost tracking ===

// Replicate per-second costs by model version (approximate)
const MODEL_COSTS = {
  // ControlNet Scribble
  "435061a1b5a4c1e26740464bf786efdfa9cb3a3ac488595a2de23e143fdb0117": { name: "controlnet-scribble", costPerSec: 0.00115 },
  // BLIP-2
  "2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746": { name: "blip-2", costPerSec: 0.00115 },
};

// Default cost for models not in the map (e.g. Llama via model endpoint)
const DEFAULT_COST_PER_SEC = 0.00050;

async function trackCost(prediction, env) {
  if (!env.COST_LOG) return;
  if (prediction.status !== "succeeded") return;

  const predictTime = prediction.metrics?.predict_time;
  if (!predictTime) return;

  // Determine model cost rate
  const version = prediction.version || "unknown";
  const modelName = prediction._model_name;
  const model = modelName
    ? { name: modelName, costPerSec: DEFAULT_COST_PER_SEC }
    : MODEL_COSTS[version] || { name: "unknown", costPerSec: DEFAULT_COST_PER_SEC };
  const cost = predictTime * model.costPerSec;

  const entry = {
    id: prediction.id,
    model: model.name,
    version,
    predict_time: predictTime,
    cost: Math.round(cost * 100000) / 100000, // 5 decimal places
    timestamp: new Date().toISOString(),
  };

  // Structured log for wrangler tail
  console.log("COST_TRACK", JSON.stringify(entry));

  // Deduplicate: skip if already tracked
  const existingEntry = await env.COST_LOG.get(`cost:${prediction.id}`);
  if (existingEntry) return;

  // Store individual entry (expires after 90 days)
  await env.COST_LOG.put(`cost:${prediction.id}`, JSON.stringify(entry), { expirationTtl: 90 * 24 * 3600 });

  // Update monthly total
  const monthKey = `totals:${entry.timestamp.slice(0, 7)}`;
  const existing = await env.COST_LOG.get(monthKey, "json") || { cost: 0, count: 0 };
  existing.cost = Math.round((existing.cost + entry.cost) * 100000) / 100000;
  existing.count += 1;
  await env.COST_LOG.put(monthKey, JSON.stringify(existing));
}

// === Costs endpoint ===

async function handleCosts(request, env, cors) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  if (!env.COST_LOG) {
    return jsonResponse({ error: "Cost tracking not configured" }, 501, cors);
  }

  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);

  // Get monthly totals for current and previous month
  const [currentTotals, prevMonth] = await Promise.all([
    env.COST_LOG.get(`totals:${currentMonth}`, "json"),
    env.COST_LOG.get(`totals:${prevMonthKey(now)}`, "json"),
  ]);

  // List recent cost entries
  const list = await env.COST_LOG.list({ prefix: "cost:", limit: 20 });
  const recent = await Promise.all(
    list.keys.map(k => env.COST_LOG.get(k.name, "json"))
  );

  return jsonResponse({
    current_month: { month: currentMonth, ...(currentTotals || { cost: 0, count: 0 }) },
    previous_month: { month: prevMonthKey(now), ...(prevMonth || { cost: 0, count: 0 }) },
    recent: recent.filter(Boolean).sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
  }, 200, cors);
}

function prevMonthKey(date) {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return d.toISOString().slice(0, 7);
}

// === Helpers ===

function parseReplicateError(httpStatus, body) {
  try {
    const json = JSON.parse(body);
    // Replicate returns { detail: "..." } on most errors
    if (json.detail) return `Replicate ${httpStatus}: ${json.detail}`;
    if (json.title) return `Replicate ${httpStatus}: ${json.title}`;
  } catch {
    // not JSON
  }
  const trimmed = body.slice(0, 200).trim();
  return trimmed ? `Replicate ${httpStatus}: ${trimmed}` : `Replicate returned HTTP ${httpStatus}`;
}

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors,
    },
  });
}
