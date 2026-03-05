// Streg API Worker
// Proxies drawing requests to Replicate's ControlNet Scribble model
// with simple PIN-based family auth.

// Medium/style words that BLIP uses to describe the drawing itself rather than the subject.
// These leak into the generation prompt and force unwanted styles (e.g. monochrome output).
const MEDIUM_NOUNS = "drawing|sketch|doodle|scribble|picture|illustration|image|artwork|painting|cartoon|outline|diagram|depiction|rendition|rendering";
const MEDIUM_ADJECTIVES = "black\\s+and\\s+white|monochrome|grayscale|grey|gray|simple|hand[- ]?drawn|hand[- ]?sketched|rough|crude|basic|pencil|ink|pen|charcoal|crayon|chalk|line|stick\\s+figure|childish|child's|children's|kid's";

// Subset of MEDIUM_ADJECTIVES that describe the scribble's colorlessness rather than the subject.
// These are stripped even when not followed by a medium noun (e.g. "a black and white house").
const COLOR_ADJECTIVES = "black\\s+and\\s+white|monochrome|grayscale|grey|gray";

/**
 * Strip medium/style phrases that describe the scribble rather than the subject.
 * BLIP often says things like "a black and white drawing of a cat" — we want just "a cat".
 */
export function cleanCaption(raw) {
  let text = raw;

  // 1. Strip "Caption:" / "Answer:" prefix
  text = text.replace(/^(Caption|Answer):\s*/i, "");

  // 2. Strip leading preamble: "this is|there is|it is|it looks like" etc.
  text = text.replace(/^(this|there|it)\s+(is|looks like|appears to be|seems to be)\s+/i, "");

  // 3. Strip leading article + optional medium adjectives + medium noun + "of"
  //    e.g. "a black and white drawing of" / "an ink sketch of" / "a simple doodle of"
  const mediumPrefixRe = new RegExp(
    `^(a|an|the)\\s+((${MEDIUM_ADJECTIVES})\\s+)*(${MEDIUM_NOUNS})\\s+(of\\s+)?`,
    "i"
  );
  text = text.replace(mediumPrefixRe, "");

  // 4. Also without a leading article: "black and white drawing of a cat"
  const noArticlePrefixRe = new RegExp(
    `^((${MEDIUM_ADJECTIVES})\\s+)+(${MEDIUM_NOUNS})\\s+(of\\s+)?`,
    "i"
  );
  text = text.replace(noArticlePrefixRe, "");

  // 5. Strip standalone color adjectives that describe the medium, not the subject.
  //    e.g. "a black and white house" -> "a house"
  const colorAdjLeadRe = new RegExp(
    `^(a|an|the)\\s+(${COLOR_ADJECTIVES})\\s+`,
    "i"
  );
  text = text.replace(colorAdjLeadRe, "$1 ");
  // Without article: "black and white house" -> "house"
  const colorAdjBareRe = new RegExp(
    `^(${COLOR_ADJECTIVES})\\s+`,
    "i"
  );
  text = text.replace(colorAdjBareRe, "");

  // 6. Strip ", drawn/sketched/rendered in ..." suffixes
  text = text.replace(/[,.]?\s+(drawn|sketched|rendered|depicted|shown)\s+(in|on|with)\s+.*$/i, "");

  // 7. Strip trailing medium phrases: "..., in black and white"
  const trailingRe = new RegExp(
    `[,.]?\\s+(in\\s+)?(${MEDIUM_ADJECTIVES})\\s*$`,
    "i"
  );
  text = text.replace(trailingRe, "");

  // 8. Strip standalone medium phrases that might remain mid-sentence
  //    e.g. "a cat, black and white drawing" -> "a cat"
  const midRe = new RegExp(
    `[,.]?\\s*(${MEDIUM_ADJECTIVES})\\s+(${MEDIUM_NOUNS})\\s*[,.]?`,
    "gi"
  );
  text = text.replace(midRe, " ");

  // 9. Clean up whitespace and dangling punctuation
  text = text.replace(/^[\s,.:;]+|[\s,.:;]+$/g, "").replace(/\s{2,}/g, " ");

  return text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

      if (url.pathname.startsWith("/eval/")) {
        return handleEvalRoutes(url, request, env, corsHeaders);
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

// === Replicate API helpers (shared by main app + eval) ===

const BLIP_VERSION = "f677695e5e89f8b236e52ecd1d3f01beb44c34606419bcc19345e046d8f786f9";
const CONTROLNET_VERSION = "435061a1b5a4c1e26740464bf786efdfa9cb3a3ac488595a2de23e143fdb0117";
const LLAMA_MODEL_NAME = "meta-llama-3-8b";

const DEFAULT_BLIP_QUESTION = "What are the main objects? Answer with the nouns/objects, no mention of drawing/sketch/black-and-white or other medium style words.";
const DEFAULT_LLM_ENRICHMENT = 'A child drew "{{caption}}". Write a short image generation prompt (under 30 words) that describes this subject with a fitting, colorful background that contrasts with the subject so it stands out clearly. Specify children\'s picture book illustration, bright colors, clean edges. No filler words. Only output the prompt, nothing else.';
const DEFAULT_A_PROMPT = "best quality, extremely detailed, colorful, vibrant, subject clearly distinct from background, contrasting background, well-defined edges";
const DEFAULT_N_PROMPT = "longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, subject blending into background, uniform texture, monochrome background";

async function callBlip(env, image, question) {
  const q = question || DEFAULT_BLIP_QUESTION;
  console.log("REPLICATE_PROMPT", JSON.stringify({ step: "blip-2", question: q }));
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
      "Content-Type": "application/json",
      "Prefer": "wait",
    },
    body: JSON.stringify({
      version: BLIP_VERSION,
      input: { image, task: "visual_question_answering", question: q },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(parseReplicateError(res.status, body));
  }

  const prediction = await res.json();
  try { await trackCost(prediction, env); } catch (e) { console.error("Cost tracking error:", e); }

  if (prediction.status === "failed" || prediction.status === "canceled") {
    throw new Error(prediction.error || "BLIP prediction failed");
  }

  const output = (typeof prediction.output === "string" ? prediction.output : (prediction.output || "").toString()).trim();
  return cleanCaption(output);
}

async function callLlmEnrich(env, caption, template) {
  const tmpl = template || DEFAULT_LLM_ENRICHMENT;
  const llmPrompt = tmpl.replace("{{caption}}", caption);
  console.log("REPLICATE_PROMPT", JSON.stringify({ step: "llm-enrichment", prompt: llmPrompt }));

  const res = await fetch("https://api.replicate.com/v1/models/meta/meta-llama-3-8b-instruct/predictions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
      "Content-Type": "application/json",
      "Prefer": "wait",
    },
    body: JSON.stringify({
      input: { prompt: llmPrompt, max_tokens: 60, temperature: 0.7 },
    }),
  });

  if (!res.ok) return caption; // fallback

  const prediction = await res.json();
  try { await trackCost({ ...prediction, _model_name: LLAMA_MODEL_NAME }, env); } catch (e) { console.error("Cost tracking error:", e); }

  if (prediction.status === "succeeded" && prediction.output) {
    const text = Array.isArray(prediction.output) ? prediction.output.join("") : prediction.output;
    return text.trim().replace(/^["']|["']$/g, "") || caption;
  }
  return caption;
}

async function callControlNet(env, { image, prompt, a_prompt, n_prompt, ddim_steps, scale, image_resolution, seed }) {
  const input = {
    image,
    prompt,
    num_samples: "1",
    image_resolution: image_resolution || "512",
    ddim_steps: ddim_steps || 20,
    scale: scale || 9,
    seed: seed ?? Math.floor(Math.random() * 2147483647),
    eta: 0,
    a_prompt: a_prompt || DEFAULT_A_PROMPT,
    n_prompt: n_prompt || DEFAULT_N_PROMPT,
  };
  console.log("REPLICATE_PROMPT", JSON.stringify({ step: "controlnet-generate", prompt, image_resolution: input.image_resolution, ddim_steps: input.ddim_steps, scale: input.scale }));

  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.REPLICATE_API_TOKEN,
      "Content-Type": "application/json",
      "Prefer": "respond-async",
    },
    body: JSON.stringify({ version: CONTROLNET_VERSION, input }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(parseReplicateError(res.status, body));
  }

  return res.json();
}

// === Describe: use BLIP to caption a scribble drawing, then enrich with LLM ===

async function handleDescribe(request, env, cors) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  const { image } = await request.json();
  if (!image) {
    return jsonResponse({ error: "Need an image" }, 400, cors);
  }

  try {
    const rawCaption = await callBlip(env, image);
    if (!rawCaption) {
      return jsonResponse({ error: "AI returned empty caption", step: "describe" }, 502, cors);
    }

    const llmPrompt = DEFAULT_LLM_ENRICHMENT.replace("{{caption}}", rawCaption);
    let enrichedPrompt;
    try {
      enrichedPrompt = await callLlmEnrich(env, rawCaption);
    } catch (e) {
      console.error("Enrichment error (using raw caption):", e?.message);
      enrichedPrompt = rawCaption;
    }

    return jsonResponse({
      subject: rawCaption,
      prompt: enrichedPrompt,
      prompt_details: {
        blip_question: DEFAULT_BLIP_QUESTION,
        blip_raw_caption: rawCaption,
        llm_prompt: llmPrompt,
        enriched_prompt: enrichedPrompt,
      },
    }, 200, cors);
  } catch (e) {
    console.error("Describe error:", e?.message);
    return jsonResponse({ error: "AI service error", step: "describe", detail: e?.message }, 502, cors);
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

  try {
    const prediction = await callControlNet(env, { image, prompt });
    return jsonResponse({
      id: prediction.id,
      status: prediction.status,
      output: prediction.output,
      prompt_details: {
        prompt,
        a_prompt: DEFAULT_A_PROMPT,
        n_prompt: DEFAULT_N_PROMPT,
      },
    }, 200, cors);
  } catch (e) {
    console.error("Generate error:", e?.message);
    return jsonResponse({ error: "AI service error", step: "generate", detail: e?.message }, 502, cors);
  }
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

// === Eval mode: test images, prompt variants, results ===

async function handleEvalRoutes(url, request, env, cors) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  if (!env.EVAL_STORE) {
    return jsonResponse({ error: "Eval store not configured" }, 501, cors);
  }

  const kv = env.EVAL_STORE;
  const path = url.pathname;
  const method = request.method;

  // --- Test Images ---
  if (path === "/eval/images" && method === "GET") {
    const index = await kvGetIndex(kv, "eval:images");
    const items = await Promise.all(
      index.map(id => kv.get(`eval:images:${id}`, "json"))
    );
    // Return metadata only (no dataUrl) for listing
    return jsonResponse(items.filter(Boolean).map(({ dataUrl, ...rest }) => rest), 200, cors);
  }

  if (path === "/eval/images" && method === "POST") {
    const { name, dataUrl } = await request.json();
    if (!dataUrl) return jsonResponse({ error: "Need dataUrl" }, 400, cors);
    const id = crypto.randomUUID();
    const item = { id, name: name || id, dataUrl, createdAt: new Date().toISOString() };
    await kv.put(`eval:images:${id}`, JSON.stringify(item));
    await kvAddToIndex(kv, "eval:images", id);
    const { dataUrl: _, ...meta } = item;
    return jsonResponse(meta, 201, cors);
  }

  const imageMatch = path.match(/^\/eval\/images\/([a-z0-9-]+)$/);
  if (imageMatch && method === "GET") {
    const item = await kv.get(`eval:images:${imageMatch[1]}`, "json");
    if (!item) return jsonResponse({ error: "Not found" }, 404, cors);
    return jsonResponse(item, 200, cors);
  }

  if (imageMatch && method === "DELETE") {
    await kv.delete(`eval:images:${imageMatch[1]}`);
    await kvRemoveFromIndex(kv, "eval:images", imageMatch[1]);
    return jsonResponse({ ok: true }, 200, cors);
  }

  // --- Prompt Variants ---
  if (path === "/eval/variants" && method === "GET") {
    const index = await kvGetIndex(kv, "eval:variants");
    const items = await Promise.all(
      index.map(id => kv.get(`eval:variants:${id}`, "json"))
    );
    return jsonResponse(items.filter(Boolean), 200, cors);
  }

  if (path === "/eval/variants" && method === "POST") {
    const body = await request.json();
    const id = crypto.randomUUID();
    const item = { id, ...body, createdAt: new Date().toISOString() };
    await kv.put(`eval:variants:${id}`, JSON.stringify(item));
    await kvAddToIndex(kv, "eval:variants", id);
    return jsonResponse(item, 201, cors);
  }

  if (path === "/eval/variants/seed" && method === "POST") {
    // Seed default variants if none exist
    const index = await kvGetIndex(kv, "eval:variants");
    if (index.length > 0) {
      return jsonResponse({ ok: false, message: "Variants already exist" }, 200, cors);
    }
    const defaults = {
      current: {
        name: "current", description: "Current production prompts",
        blip_question: DEFAULT_BLIP_QUESTION,
        llm_enrichment: DEFAULT_LLM_ENRICHMENT,
        a_prompt: DEFAULT_A_PROMPT, n_prompt: DEFAULT_N_PROMPT,
        ddim_steps: 20, scale: 9, image_resolution: "512",
      },
      storybook: {
        name: "storybook", description: "Watercolor storybook style",
        blip_question: "What is in this picture? Name only the subject, no style or medium words.",
        llm_enrichment: 'A child drew "{{caption}}". Write a vivid image prompt (under 25 words): the subject in a whimsical storybook scene with a complementary colorful background. Style: watercolor children\'s book illustration. Only output the prompt.',
        a_prompt: "children's book illustration, watercolor, soft lighting, whimsical, colorful, detailed, charming, storybook art style",
        n_prompt: "photo, realistic, 3d render, dark, scary, violent, ugly, blurry, lowres, bad anatomy, bad hands, extra fingers, cropped, worst quality, low quality, monochrome",
        ddim_steps: 30, scale: 7.5, image_resolution: "512",
      },
      lower_guidance: {
        name: "lower_guidance", description: "Lower guidance scale, less saturation",
        blip_question: DEFAULT_BLIP_QUESTION,
        llm_enrichment: DEFAULT_LLM_ENRICHMENT,
        a_prompt: "best quality, colorful, vibrant, children's illustration, clean lines, well-defined edges",
        n_prompt: "lowres, bad anatomy, worst quality, low quality, monochrome, blurry, cropped",
        ddim_steps: 25, scale: 6, image_resolution: "512",
      },
    };
    for (const v of Object.values(defaults)) {
      const id = crypto.randomUUID();
      v.id = id;
      v.createdAt = new Date().toISOString();
      await kv.put(`eval:variants:${id}`, JSON.stringify(v));
      await kvAddToIndex(kv, "eval:variants", id);
    }
    return jsonResponse({ ok: true, count: Object.keys(defaults).length }, 201, cors);
  }

  const variantMatch = path.match(/^\/eval\/variants\/([a-z0-9-]+)$/);
  if (variantMatch && method === "PUT") {
    const body = await request.json();
    const existing = await kv.get(`eval:variants:${variantMatch[1]}`, "json");
    if (!existing) return jsonResponse({ error: "Not found" }, 404, cors);
    const updated = { ...existing, ...body, id: variantMatch[1] };
    await kv.put(`eval:variants:${variantMatch[1]}`, JSON.stringify(updated));
    return jsonResponse(updated, 200, cors);
  }

  if (variantMatch && method === "DELETE") {
    await kv.delete(`eval:variants:${variantMatch[1]}`);
    await kvRemoveFromIndex(kv, "eval:variants", variantMatch[1]);
    return jsonResponse({ ok: true }, 200, cors);
  }

  // --- Eval Describe (variant-aware) ---
  if (path === "/eval/describe" && method === "POST") {
    const { image, blip_question, llm_enrichment } = await request.json();
    if (!image) return jsonResponse({ error: "Need image" }, 400, cors);

    try {
      const caption = await callBlip(env, image, blip_question);
      if (!caption) return jsonResponse({ error: "Empty caption", step: "describe" }, 502, cors);

      let enrichedPrompt;
      try {
        enrichedPrompt = await callLlmEnrich(env, caption, llm_enrichment);
      } catch (e) {
        enrichedPrompt = caption;
      }

      return jsonResponse({ caption, prompt: enrichedPrompt }, 200, cors);
    } catch (e) {
      return jsonResponse({ error: "AI service error", step: "describe", detail: e?.message }, 502, cors);
    }
  }

  // --- Eval Generate (variant-aware) ---
  if (path === "/eval/generate" && method === "POST") {
    const { image, prompt, a_prompt, n_prompt, ddim_steps, scale, image_resolution } = await request.json();
    if (!image || !prompt) return jsonResponse({ error: "Need image and prompt" }, 400, cors);

    try {
      const prediction = await callControlNet(env, {
        image, prompt, a_prompt, n_prompt,
        ddim_steps: ddim_steps || 20,
        scale: scale || 9,
        image_resolution: image_resolution || "512",
        seed: 42, // fixed seed for eval comparison
      });
      return jsonResponse({ id: prediction.id, status: prediction.status }, 200, cors);
    } catch (e) {
      return jsonResponse({ error: "AI service error", step: "generate", detail: e?.message }, 502, cors);
    }
  }

  // --- Eval Results ---
  if (path === "/eval/results" && method === "GET") {
    const list = await kv.list({ prefix: "eval:results:" });
    const items = await Promise.all(
      list.keys.map(k => kv.get(k.name, "json"))
    );
    return jsonResponse(items.filter(Boolean), 200, cors);
  }

  const resultMatch = path.match(/^\/eval\/results\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (resultMatch && method === "PUT") {
    const body = await request.json();
    const key = `eval:results:${resultMatch[1]}:${resultMatch[2]}`;
    const item = { imageId: resultMatch[1], variantId: resultMatch[2], ...body, updatedAt: new Date().toISOString() };
    await kv.put(key, JSON.stringify(item));
    return jsonResponse(item, 200, cors);
  }

  if (resultMatch && method === "DELETE") {
    await kv.delete(`eval:results:${resultMatch[1]}:${resultMatch[2]}`);
    return jsonResponse({ ok: true }, 200, cors);
  }

  return jsonResponse({ error: "Not found" }, 404, cors);
}

// --- KV index helpers ---

async function kvGetIndex(kv, prefix) {
  const data = await kv.get(`${prefix}:_index`, "json");
  return data || [];
}

async function kvAddToIndex(kv, prefix, id) {
  const index = await kvGetIndex(kv, prefix);
  if (!index.includes(id)) {
    index.push(id);
    await kv.put(`${prefix}:_index`, JSON.stringify(index));
  }
}

async function kvRemoveFromIndex(kv, prefix, id) {
  const index = await kvGetIndex(kv, prefix);
  const filtered = index.filter(x => x !== id);
  await kv.put(`${prefix}:_index`, JSON.stringify(filtered));
}

// === Cost tracking ===

// Replicate per-second costs by model version (approximate)
const MODEL_COSTS = {
  // ControlNet Scribble
  "435061a1b5a4c1e26740464bf786efdfa9cb3a3ac488595a2de23e143fdb0117": { name: "controlnet-scribble", costPerSec: 0.00115 },
  // BLIP-2
  "f677695e5e89f8b236e52ecd1d3f01beb44c34606419bcc19345e046d8f786f9": { name: "blip-2", costPerSec: 0.00115 },
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
