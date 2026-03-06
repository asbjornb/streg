// === Streg Prompt Eval ===
// Mobile-friendly UI for testing prompt variants against saved scribbles.

const WORKER_URL = localStorage.getItem("streg_worker_url") || "https://streg-api.asbjoernbrandt.workers.dev";

let authToken = "";
let testImages = [];     // { id, name, createdAt } (no dataUrl in list)
let variants = [];       // full variant objects
let results = {};        // key "imageId:variantId" -> result
let selectedImageIds = new Set();
let selectedVariantIds = new Set();
let isRunning = false;

// === Init ===
document.addEventListener("DOMContentLoaded", init);

function init() {
  setupPIN();
  setupTabs();
  setupImageUpload();
  setupVariantButtons();
  setupRunButton();

  const saved = sessionStorage.getItem("streg_token");
  if (saved) {
    authToken = saved;
    showEvalScreen();
  }
}

// === PIN Auth (same logic as main app) ===
function setupPIN() {
  const input = document.getElementById("pin-input");
  const btn = document.getElementById("pin-submit");
  const error = document.getElementById("pin-error");

  async function tryAuth() {
    const pin = input.value.trim();
    if (!pin) return;
    btn.disabled = true;
    error.hidden = true;
    try {
      const res = await fetch(WORKER_URL + "/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (data.ok) {
        authToken = data.token;
        sessionStorage.setItem("streg_token", authToken);
        showEvalScreen();
      } else {
        error.hidden = false;
        input.value = "";
        input.focus();
      }
    } catch {
      error.textContent = "Could not connect. Try again!";
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", tryAuth);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryAuth(); });
}

function showEvalScreen() {
  document.getElementById("pin-screen").hidden = true;
  document.getElementById("eval-screen").hidden = false;
  loadAll();
}

async function loadAll() {
  await Promise.all([loadImages(), loadVariants(), loadResults()]);
  updateRunSummary();
}

// === Tabs ===
function setupTabs() {
  document.querySelectorAll(".eval-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".eval-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".eval-tab-content").forEach(c => c.hidden = true);
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).hidden = false;
    });
  });
}

// === Test Images ===
async function loadImages() {
  try {
    const res = await apiFetch("/eval/images");
    testImages = await res.json();
  } catch (e) {
    testImages = [];
  }
  renderImages();
}

function setupImageUpload() {
  const input = document.getElementById("image-upload");
  input.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = "";

    const btn = document.getElementById("upload-image-btn");
    btn.textContent = "Uploading...";

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const name = file.name.replace(/\.[^.]+$/, "") || "drawing";
      const res = await apiFetch("/eval/images", {
        method: "POST",
        body: JSON.stringify({ name, dataUrl }),
      });
      const item = await res.json();
      testImages.push(item);
      selectedImageIds.add(item.id);
      renderImages();
      updateRunSummary();
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      btn.textContent = "Upload PNG";
    }
  });
}

function renderImages() {
  const grid = document.getElementById("image-grid");
  if (testImages.length === 0) {
    grid.innerHTML = '<p class="eval-empty">No test images yet. Draw in the <a href="/">main app</a>, download as PNG, and upload here.</p>';
    return;
  }

  grid.innerHTML = testImages.map(img => `
    <div class="eval-image-card ${selectedImageIds.has(img.id) ? "selected" : ""}" data-id="${img.id}">
      <img src="${WORKER_URL}/eval/images/${img.id}" alt="${esc(img.name)}" loading="lazy"
           onerror="this.style.background='#eee'; this.alt='Loading...'">
      <div class="eval-image-meta">
        <label class="eval-check">
          <input type="checkbox" ${selectedImageIds.has(img.id) ? "checked" : ""}>
          <span>${esc(img.name)}</span>
        </label>
        <button class="eval-delete" title="Delete">&times;</button>
      </div>
    </div>
  `).join("");

  // The image src points to the API which returns JSON — we need to fetch and use the dataUrl
  grid.querySelectorAll(".eval-image-card").forEach(card => {
    const id = card.dataset.id;
    const imgEl = card.querySelector("img");

    // Fetch actual image data
    apiFetch("/eval/images/" + id).then(r => r.json()).then(data => {
      if (data.dataUrl) imgEl.src = data.dataUrl;
    }).catch(() => {});

    card.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      if (e.target.checked) selectedImageIds.add(id);
      else selectedImageIds.delete(id);
      card.classList.toggle("selected", e.target.checked);
      updateRunSummary();
    });

    card.querySelector(".eval-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this test image?")) return;
      await apiFetch("/eval/images/" + id, { method: "DELETE" });
      testImages = testImages.filter(i => i.id !== id);
      selectedImageIds.delete(id);
      renderImages();
      updateRunSummary();
    });
  });
}

// === Variants ===
async function loadVariants() {
  try {
    const res = await apiFetch("/eval/variants");
    variants = await res.json();
  } catch {
    variants = [];
  }
  // Auto-select all
  variants.forEach(v => selectedVariantIds.add(v.id));
  renderVariants();
}

function setupVariantButtons() {
  document.getElementById("add-variant-btn").addEventListener("click", () => {
    openVariantEditor(null);
  });

  document.getElementById("seed-variants-btn").addEventListener("click", async () => {
    const btn = document.getElementById("seed-variants-btn");
    btn.disabled = true;
    btn.textContent = "Seeding...";
    try {
      await apiFetch("/eval/variants/seed", { method: "POST", body: "{}" });
      await loadVariants();
      updateRunSummary();
    } catch (e) {
      alert("Seed failed: " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Seed Defaults";
    }
  });
}

function renderVariants() {
  const list = document.getElementById("variant-list");
  if (variants.length === 0) {
    list.innerHTML = '<p class="eval-empty">No variants yet. Tap "Seed Defaults" to load starter configs, or create your own.</p>';
    return;
  }

  list.innerHTML = variants.map(v => `
    <div class="eval-variant-card ${selectedVariantIds.has(v.id) ? "selected" : ""}" data-id="${v.id}">
      <div class="eval-variant-header">
        <label class="eval-check">
          <input type="checkbox" ${selectedVariantIds.has(v.id) ? "checked" : ""}>
          <strong>${esc(v.name || "Unnamed")}</strong>
        </label>
        <div class="eval-variant-actions">
          <button class="eval-edit-btn" title="Edit">Edit</button>
          <button class="eval-delete" title="Delete">&times;</button>
        </div>
      </div>
      <div class="eval-variant-desc">${esc(v.description || "")}</div>
      <div class="eval-variant-params">steps=${v.ddim_steps || 20} scale=${v.scale || 9} res=${v.image_resolution || "512"}</div>
    </div>
  `).join("");

  list.querySelectorAll(".eval-variant-card").forEach(card => {
    const id = card.dataset.id;
    const variant = variants.find(v => v.id === id);

    card.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
      if (e.target.checked) selectedVariantIds.add(id);
      else selectedVariantIds.delete(id);
      card.classList.toggle("selected", e.target.checked);
      updateRunSummary();
    });

    card.querySelector(".eval-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openVariantEditor(variant);
    });

    card.querySelector(".eval-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete variant '" + (variant.name || "unnamed") + "'?")) return;
      await apiFetch("/eval/variants/" + id, { method: "DELETE" });
      variants = variants.filter(v => v.id !== id);
      selectedVariantIds.delete(id);
      renderVariants();
      updateRunSummary();
    });
  });
}

function openVariantEditor(variant) {
  const isNew = !variant;
  const v = variant || {
    name: "", description: "",
    blip_question: "What are the main objects? Answer with the nouns/objects, no mention of drawing/sketch/black-and-white or other medium style words.",
    llm_enrichment: 'A child drew "{{caption}}". Write a short image generation prompt (under 30 words) that describes this subject with a fitting, colorful background that contrasts with the subject so it stands out clearly. Specify children\'s picture book illustration, bright colors, clean edges. No filler words. Only output the prompt, nothing else.',
    a_prompt: "best quality, extremely detailed, colorful, vibrant, subject clearly distinct from background, contrasting background, well-defined edges",
    n_prompt: "longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, subject blending into background, uniform texture, monochrome background",
    ddim_steps: 20, scale: 9, image_resolution: "512",
  };

  // Create modal overlay
  const overlay = document.createElement("div");
  overlay.className = "eval-modal-overlay";
  overlay.innerHTML = `
    <div class="eval-modal">
      <h3>${isNew ? "New Variant" : "Edit Variant"}</h3>
      <div class="eval-form">
        <label>Name<input type="text" id="ve-name" value="${esc(v.name)}"></label>
        <label>Description<input type="text" id="ve-desc" value="${esc(v.description || "")}"></label>
        <label>BLIP Question<textarea id="ve-blip" rows="2">${esc(v.blip_question || "")}</textarea></label>
        <label>LLM Enrichment Template<textarea id="ve-llm" rows="3">${esc(v.llm_enrichment || "")}</textarea></label>
        <label>Positive Prompt (a_prompt)<textarea id="ve-aprompt" rows="2">${esc(v.a_prompt || "")}</textarea></label>
        <label>Negative Prompt (n_prompt)<textarea id="ve-nprompt" rows="2">${esc(v.n_prompt || "")}</textarea></label>
        <div class="eval-form-row">
          <label>Steps<input type="number" id="ve-steps" value="${v.ddim_steps || 20}" min="1" max="50"></label>
          <label>Scale<input type="number" id="ve-scale" value="${v.scale || 9}" min="1" max="20" step="0.5"></label>
          <label>Resolution<input type="text" id="ve-res" value="${v.image_resolution || "512"}"></label>
        </div>
      </div>
      <div class="eval-modal-buttons">
        <button class="btn btn-primary btn-sm" id="ve-save">Save</button>
        <button class="btn btn-tool btn-sm" id="ve-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#ve-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#ve-save").addEventListener("click", async () => {
    const data = {
      name: overlay.querySelector("#ve-name").value.trim(),
      description: overlay.querySelector("#ve-desc").value.trim(),
      blip_question: overlay.querySelector("#ve-blip").value.trim(),
      llm_enrichment: overlay.querySelector("#ve-llm").value.trim(),
      a_prompt: overlay.querySelector("#ve-aprompt").value.trim(),
      n_prompt: overlay.querySelector("#ve-nprompt").value.trim(),
      ddim_steps: parseInt(overlay.querySelector("#ve-steps").value) || 20,
      scale: parseFloat(overlay.querySelector("#ve-scale").value) || 9,
      image_resolution: overlay.querySelector("#ve-res").value.trim() || "512",
    };

    if (!data.name) { alert("Name is required"); return; }

    try {
      let result;
      if (isNew) {
        const res = await apiFetch("/eval/variants", { method: "POST", body: JSON.stringify(data) });
        result = await res.json();
        variants.push(result);
        selectedVariantIds.add(result.id);
      } else {
        const res = await apiFetch("/eval/variants/" + v.id, { method: "PUT", body: JSON.stringify(data) });
        result = await res.json();
        const idx = variants.findIndex(x => x.id === v.id);
        if (idx !== -1) variants[idx] = result;
      }
      renderVariants();
      updateRunSummary();
      overlay.remove();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
  });
}

// === Run Eval ===
function setupRunButton() {
  document.getElementById("run-eval-btn").addEventListener("click", runEval);
}

function updateRunSummary() {
  const imgs = selectedImageIds.size;
  const vars = selectedVariantIds.size;
  document.getElementById("run-summary").textContent =
    `${imgs} image${imgs !== 1 ? "s" : ""} × ${vars} variant${vars !== 1 ? "s" : ""} = ${imgs * vars} cells`;
  renderResultsGrid();
}

async function loadResults() {
  try {
    const res = await apiFetch("/eval/results");
    const items = await res.json();
    results = {};
    items.forEach(r => {
      results[r.imageId + ":" + r.variantId] = r;
    });
  } catch {
    results = {};
  }
}

async function runEval() {
  if (isRunning) return;
  if (selectedImageIds.size === 0 || selectedVariantIds.size === 0) {
    alert("Select at least one image and one variant first.");
    return;
  }

  isRunning = true;
  const btn = document.getElementById("run-eval-btn");
  btn.disabled = true;
  btn.textContent = "Running...";

  const progressEl = document.getElementById("run-progress");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  progressEl.hidden = false;

  const imageIds = [...selectedImageIds];
  const variantIds = [...selectedVariantIds];
  const total = imageIds.length * variantIds.length;
  let completed = 0;

  // Load image data for all selected images
  const imageDataCache = {};
  for (const imageId of imageIds) {
    try {
      const res = await apiFetch("/eval/images/" + imageId);
      const data = await res.json();
      imageDataCache[imageId] = data.dataUrl;
    } catch (e) {
      console.error("Failed to load image " + imageId, e);
    }
  }

  // Run cells sequentially to avoid rate limits
  for (const imageId of imageIds) {
    const imageDataUrl = imageDataCache[imageId];
    if (!imageDataUrl) continue;

    for (const variantId of variantIds) {
      const cellKey = imageId + ":" + variantId;
      const variant = variants.find(v => v.id === variantId);
      if (!variant) continue;

      // Update progress
      progressText.textContent = `${completed + 1}/${total}`;
      progressFill.style.width = ((completed / total) * 100) + "%";

      // Mark as running
      results[cellKey] = { imageId, variantId, status: "running" };
      renderResultsGrid();

      try {
        // Step 1: Describe
        const descRes = await apiFetch("/eval/describe", {
          method: "POST",
          body: JSON.stringify({
            image: imageDataUrl,
            blip_question: variant.blip_question,
            llm_enrichment: variant.llm_enrichment,
          }),
        });
        const desc = await descRes.json();
        if (desc.error) throw new Error(desc.detail || desc.error);

        results[cellKey] = { ...results[cellKey], caption: desc.caption, prompt: desc.prompt, status: "generating" };
        renderResultsGrid();

        // Step 2: Generate
        const genRes = await apiFetch("/eval/generate", {
          method: "POST",
          body: JSON.stringify({
            image: imageDataUrl,
            prompt: desc.prompt,
            a_prompt: variant.a_prompt,
            n_prompt: variant.n_prompt,
            ddim_steps: variant.ddim_steps,
            scale: variant.scale,
            image_resolution: variant.image_resolution,
          }),
        });
        const gen = await genRes.json();
        if (gen.error) throw new Error(gen.detail || gen.error);

        // Step 3: Poll
        const output = await pollPrediction(gen.id);
        const outputUrl = Array.isArray(output) ? output[0] : output;

        results[cellKey] = {
          imageId, variantId,
          caption: desc.caption,
          prompt: desc.prompt,
          outputImageUrl: outputUrl,
          status: "done",
        };

        // Save result to KV
        await apiFetch(`/eval/results/${imageId}/${variantId}`, {
          method: "PUT",
          body: JSON.stringify(results[cellKey]),
        });
      } catch (e) {
        results[cellKey] = { imageId, variantId, status: "error", error: e.message };
      }

      completed++;
      renderResultsGrid();
    }
  }

  progressFill.style.width = "100%";
  progressText.textContent = `${total}/${total} done`;
  isRunning = false;
  btn.disabled = false;
  btn.textContent = "Run Eval";
}

async function pollPrediction(predictionId) {
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const res = await apiFetch("/status/" + predictionId);
    const data = await res.json();
    if (data.status === "succeeded" && data.output) return data.output;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(data.error || "Generation failed");
    }
  }
  throw new Error("Timed out");
}

async function rerunCell(imageId, variantId) {
  if (isRunning) return;
  const cellKey = imageId + ":" + variantId;
  const variant = variants.find(v => v.id === variantId);
  if (!variant) return;

  results[cellKey] = { imageId, variantId, status: "running" };
  renderResultsGrid();

  try {
    const imgRes = await apiFetch("/eval/images/" + imageId);
    const imgData = await imgRes.json();

    const descRes = await apiFetch("/eval/describe", {
      method: "POST",
      body: JSON.stringify({
        image: imgData.dataUrl,
        blip_question: variant.blip_question,
        llm_enrichment: variant.llm_enrichment,
      }),
    });
    const desc = await descRes.json();
    if (desc.error) throw new Error(desc.detail || desc.error);

    results[cellKey] = { ...results[cellKey], caption: desc.caption, prompt: desc.prompt, status: "generating" };
    renderResultsGrid();

    const genRes = await apiFetch("/eval/generate", {
      method: "POST",
      body: JSON.stringify({
        image: imgData.dataUrl,
        prompt: desc.prompt,
        a_prompt: variant.a_prompt,
        n_prompt: variant.n_prompt,
        ddim_steps: variant.ddim_steps,
        scale: variant.scale,
        image_resolution: variant.image_resolution,
      }),
    });
    const gen = await genRes.json();
    if (gen.error) throw new Error(gen.detail || gen.error);

    const output = await pollPrediction(gen.id);
    const outputUrl = Array.isArray(output) ? output[0] : output;

    results[cellKey] = { imageId, variantId, caption: desc.caption, prompt: desc.prompt, outputImageUrl: outputUrl, status: "done" };

    await apiFetch(`/eval/results/${imageId}/${variantId}`, {
      method: "PUT",
      body: JSON.stringify(results[cellKey]),
    });
  } catch (e) {
    results[cellKey] = { imageId, variantId, status: "error", error: e.message };
  }

  renderResultsGrid();
}

// === Results Grid ===
function renderResultsGrid() {
  const grid = document.getElementById("results-grid");
  const imageIds = [...selectedImageIds];
  const variantIds = [...selectedVariantIds];

  if (imageIds.length === 0 || variantIds.length === 0) {
    grid.innerHTML = '<p class="eval-empty">Select images and variants, then tap "Run Eval".</p>';
    return;
  }

  // Find image/variant metadata
  const imgMap = Object.fromEntries(testImages.map(i => [i.id, i]));
  const varMap = Object.fromEntries(variants.map(v => [v.id, v]));

  // Mobile-first: group by image, stack variants vertically
  grid.innerHTML = imageIds.map(imgId => {
    const img = imgMap[imgId];
    if (!img) return "";

    const cells = variantIds.map(varId => {
      const v = varMap[varId];
      if (!v) return "";
      const key = imgId + ":" + varId;
      const r = results[key];
      return renderCell(r, v, imgId, varId);
    }).join("");

    return `
      <div class="eval-result-group">
        <div class="eval-result-input">
          <div class="eval-result-input-label">${esc(img.name)}</div>
        </div>
        <div class="eval-result-cells">${cells}</div>
      </div>
    `;
  }).join("");

  // Load input image thumbnails
  grid.querySelectorAll(".eval-result-input").forEach((el, i) => {
    const imgId = imageIds[i];
    if (!imgId) return;
    apiFetch("/eval/images/" + imgId).then(r => r.json()).then(data => {
      if (data.dataUrl) {
        const thumb = document.createElement("img");
        thumb.src = data.dataUrl;
        thumb.alt = "input";
        el.prepend(thumb);
      }
    }).catch(() => {});
  });

  // Attach rerun handlers
  grid.querySelectorAll("[data-rerun]").forEach(btn => {
    btn.addEventListener("click", () => {
      const [imgId, varId] = btn.dataset.rerun.split(":");
      rerunCell(imgId, varId);
    });
  });
}

function renderCell(r, variant, imageId, variantId) {
  const key = imageId + ":" + variantId;

  if (!r) {
    return `
      <div class="eval-cell eval-cell-empty">
        <div class="eval-cell-variant">${esc(variant.name)}</div>
        <div class="eval-cell-status">Not run yet</div>
        <button class="btn btn-tool btn-sm" data-rerun="${key}">Run</button>
      </div>
    `;
  }

  if (r.status === "running" || r.status === "generating") {
    return `
      <div class="eval-cell eval-cell-running">
        <div class="eval-cell-variant">${esc(variant.name)}</div>
        <div class="eval-cell-spinner"></div>
        <div class="eval-cell-status">${r.status === "generating" ? "Generating..." : "Describing..."}</div>
        ${r.caption ? `<div class="eval-cell-caption">Caption: ${esc(r.caption)}</div>` : ""}
        ${r.prompt ? `<div class="eval-cell-prompt">Prompt: ${esc(r.prompt)}</div>` : ""}
      </div>
    `;
  }

  if (r.status === "error") {
    return `
      <div class="eval-cell eval-cell-error">
        <div class="eval-cell-variant">${esc(variant.name)}</div>
        <div class="eval-cell-status">Error: ${esc(r.error || "Unknown")}</div>
        <button class="btn btn-tool btn-sm" data-rerun="${key}">Retry</button>
      </div>
    `;
  }

  // done
  return `
    <div class="eval-cell eval-cell-done">
      <div class="eval-cell-variant">${esc(variant.name)}</div>
      ${r.outputImageUrl ? `<img src="${esc(r.outputImageUrl)}" alt="result" loading="lazy">` : ""}
      <div class="eval-cell-caption">Caption: ${esc(r.caption || "—")}</div>
      <div class="eval-cell-prompt">Prompt: ${esc(r.prompt || "—")}</div>
      <button class="btn btn-tool btn-sm" data-rerun="${key}">Re-run</button>
    </div>
  `;
}

// === Helpers ===
async function apiFetch(path, opts = {}) {
  const res = await fetch(WORKER_URL + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + authToken,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok && res.status === 401) {
    alert("Session expired. Refresh to log in again.");
    throw new Error("Not authorized");
  }
  return res;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
