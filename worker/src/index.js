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

      if (url.pathname === "/generate" && request.method === "POST") {
        return handleGenerate(request, env, corsHeaders);
      }

      if (url.pathname.startsWith("/status/") && request.method === "GET") {
        const id = url.pathname.split("/status/")[1];
        return handleStatus(request, env, corsHeaders, id);
      }

      return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: "Internal error" }, 500, corsHeaders);
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

// === Describe: use BLIP to caption a scribble drawing ===

async function handleDescribe(request, env, cors) {
  if (!(await verifyToken(request, env))) {
    return jsonResponse({ error: "Not authorized" }, 401, cors);
  }

  const { image } = await request.json();

  if (!image) {
    return jsonResponse({ error: "Need an image" }, 400, cors);
  }

  // Use BLIP-2 to caption the drawing
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
        task: "image_captioning",
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Replicate describe error:", err);
    return jsonResponse({ error: "AI service error" }, 502, cors);
  }

  const prediction = await res.json();

  // Get the raw caption from BLIP
  let rawCaption = null;

  if (prediction.status === "succeeded" && prediction.output) {
    rawCaption = prediction.output.replace(/^Caption:\s*/i, "").trim();
  } else if (prediction.id) {
    // Poll for BLIP result (usually fast)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await fetch(
        `https://api.replicate.com/v1/predictions/${prediction.id}`,
        { headers: { "Authorization": "Bearer " + env.REPLICATE_API_TOKEN } }
      );
      const result = await poll.json();
      if (result.status === "succeeded" && result.output) {
        rawCaption = (typeof result.output === "string" ? result.output : result.output.toString())
          .replace(/^Caption:\s*/i, "").trim();
        break;
      }
      if (result.status === "failed" || result.status === "canceled") {
        return jsonResponse({ error: "Could not describe the drawing" }, 502, cors);
      }
    }
  }

  if (!rawCaption) {
    return jsonResponse({ error: "Could not describe the drawing" }, 502, cors);
  }

  // Use an LLM to enrich the caption with a fitting, contrasting background
  const enriched = await enrichCaption(rawCaption, env);

  return jsonResponse({ caption: rawCaption, prompt: enriched }, 200, cors);
}

// === Enrich caption with a contrasting background using an LLM ===

async function enrichCaption(caption, env) {
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
          prompt: `A child drew "${caption}". Write a short image generation prompt (under 20 words) that describes this subject with a fitting, colorful background that contrasts with the subject so it stands out clearly. Only output the prompt, nothing else.`,
          max_tokens: 60,
          temperature: 0.7,
        },
      }),
    });

    if (!res.ok) return caption;

    const prediction = await res.json();

    // If completed synchronously
    if (prediction.status === "succeeded" && prediction.output) {
      const text = Array.isArray(prediction.output) ? prediction.output.join("") : prediction.output;
      return text.trim().replace(/^["']|["']$/g, "") || caption;
    }

    // Poll for result
    if (prediction.id) {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const poll = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          { headers: { "Authorization": "Bearer " + env.REPLICATE_API_TOKEN } }
        );
        const result = await poll.json();
        if (result.status === "succeeded" && result.output) {
          const text = Array.isArray(result.output) ? result.output.join("") : result.output;
          return text.trim().replace(/^["']|["']$/g, "") || caption;
        }
        if (result.status === "failed" || result.status === "canceled") {
          return caption;
        }
      }
    }

    return caption;
  } catch {
    // If LLM enrichment fails for any reason, just use the raw caption
    return caption;
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
    const err = await res.text();
    console.error("Replicate error:", err);
    return jsonResponse({ error: "AI service error" }, 502, cors);
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
    return jsonResponse({ error: "Could not check status" }, 502, cors);
  }

  const prediction = await res.json();
  return jsonResponse({
    id: prediction.id,
    status: prediction.status,
    output: prediction.output,
    error: prediction.error,
  }, 200, cors);
}

// === Helpers ===

function jsonResponse(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...cors,
    },
  });
}
