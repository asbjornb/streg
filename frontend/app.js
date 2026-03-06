// === Configuration ===
const WORKER_URL = localStorage.getItem("streg_worker_url") || "https://streg-api.asbjoernbrandt.workers.dev";

// === Color palette - a nice set for kids ===
const COLORS = [
  "#2d2a26", // black
  "#c44",    // red
  "#e8a849", // orange/yellow
  "#4a7c59", // green
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#78716c", // gray
  "#92400e", // brown
];

// === State ===
let isDrawing = false;
let isEraser = false;
let currentColor = COLORS[0];
let brushSize = 6;
let strokeHistory = []; // array of ImageData snapshots for undo
let authToken = "";
let canvas, ctx;

// === Boot ===
document.addEventListener("DOMContentLoaded", init);

function init() {
  canvas = document.getElementById("drawing-canvas");
  ctx = canvas.getContext("2d");

  updateMobileLayoutState();
  setupCanvas();
  setupPalette();
  setupToolbar();
  setupDrawing();
  setupPIN();
  setupSubmit();
  setupMobileToggles();
  restoreDraft();
  loadHistory();

  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);

  // If already authed, skip PIN
  const saved = sessionStorage.getItem("streg_token");
  if (saved) {
    authToken = saved;
    showDrawScreen();
  }
}

// === Canvas sizing ===
function isMobileViewport() {
  return window.matchMedia("(max-width: 600px)").matches;
}

function isLandscapeViewport() {
  return window.matchMedia("(orientation: landscape)").matches;
}

function shouldForceLandscapeCanvas() {
  return isMobileViewport() && isLandscapeViewport();
}

function updateMobileLayoutState() {
  document.body.classList.toggle("mobile-force-landscape", shouldForceLandscapeCanvas());
}

function setupCanvas() {
  const area = document.querySelector(".canvas-area");
  const forceLandscape = shouldForceLandscapeCanvas();
  const w = forceLandscape ? window.innerWidth : area.clientWidth;
  // On landscape mobile: fill viewport for max drawing area
  // On portrait mobile: use most of the viewport height for drawing
  // On desktop: fill most of the viewport height
  const h = forceLandscape
    ? window.innerHeight
    : (isMobileViewport()
      ? Math.min(w, window.innerHeight * 0.7)
      : Math.min(w * 0.75, window.innerHeight * 0.7));

  canvas.width = w;
  canvas.height = h;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function handleResize() {
  updateMobileLayoutState();
  // Save current drawing, resize, restore
  const data = canvas.toDataURL();
  const oldW = canvas.width;
  const oldH = canvas.height;
  setupCanvas();
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, oldW, oldH, 0, 0, canvas.width, canvas.height);
  };
  img.src = data;
}

// === Color palette ===
function setupPalette() {
  const palette = document.getElementById("color-palette");
  COLORS.forEach((color, i) => {
    const swatch = document.createElement("button");
    swatch.className = "color-swatch" + (i === 0 ? " active" : "");
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener("click", () => {
      document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
      currentColor = color;
      isEraser = false;
      document.getElementById("eraser-btn").classList.remove("active");
    });
    palette.appendChild(swatch);
  });
}

// === Toolbar ===
function setupToolbar() {
  document.getElementById("brush-size").addEventListener("input", (e) => {
    brushSize = parseInt(e.target.value, 10);
  });

  document.getElementById("eraser-btn").addEventListener("click", () => {
    isEraser = !isEraser;
    document.getElementById("eraser-btn").classList.toggle("active", isEraser);
    if (isEraser) {
      document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
    } else {
      // Re-select current color swatch
      document.querySelectorAll(".color-swatch").forEach(s => {
        if (s.style.background === currentColor || rgbToHex(s.style.background) === currentColor) {
          s.classList.add("active");
        }
      });
    }
  });

  document.getElementById("undo-btn").addEventListener("click", undo);
  document.getElementById("clear-btn").addEventListener("click", clearCanvas);

  // Photo upload
  const photoBtn = document.getElementById("photo-btn");
  const photoInput = document.getElementById("photo-input");
  if (photoBtn && photoInput) {
    photoBtn.addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", handlePhotoUpload);
  }

  // Export drawing as PNG
  const exportBtn = document.getElementById("export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", exportDrawing);
  }

}

// === Mobile panel toggles ===
function setupMobileToggles() {
  const toolbarToggle = document.getElementById("toggle-toolbar");
  const promptToggle = document.getElementById("toggle-prompt");
  const toolbarPanel = document.getElementById("toolbar-panel");
  const promptPanel = document.getElementById("prompt-panel");

  if (!toolbarToggle || !promptToggle) return;

  toolbarToggle.addEventListener("click", () => {
    const isOpen = toolbarPanel.classList.toggle("panel-open");
    toolbarToggle.classList.toggle("active", isOpen);
    // Close the other panel
    if (isOpen) {
      promptPanel.classList.remove("panel-open");
      promptToggle.classList.remove("active");
    }
  });

  promptToggle.addEventListener("click", () => {
    const isOpen = promptPanel.classList.toggle("panel-open");
    promptToggle.classList.toggle("active", isOpen);
    // Close the other panel
    if (isOpen) {
      toolbarPanel.classList.remove("panel-open");
      toolbarToggle.classList.remove("active");
      document.getElementById("prompt-input").focus();
    }
  });
}

function rgbToHex(rgb) {
  // Helper to compare colors - browser may convert hex to rgb
  if (rgb.startsWith("#")) return rgb;
  const match = rgb.match(/\d+/g);
  if (!match) return rgb;
  return "#" + match.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, "0")).join("");
}

// === Drawing ===
function setupDrawing() {
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if (e.touches) {
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top) * scaleY,
      };
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function startStroke(e) {
    e.preventDefault();
    isDrawing = true;
    // Save state for undo before starting new stroke
    saveSnapshot();
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    // Draw a dot for single clicks/taps
    ctx.strokeStyle = isEraser ? "#ffffff" : currentColor;
    ctx.lineWidth = isEraser ? brushSize * 2 : brushSize;
    ctx.lineTo(pos.x + 0.1, pos.y + 0.1);
    ctx.stroke();
  }

  function moveStroke(e) {
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getPos(e);
    ctx.strokeStyle = isEraser ? "#ffffff" : currentColor;
    ctx.lineWidth = isEraser ? brushSize * 2 : brushSize;
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
  }

  function endStroke(e) {
    if (!isDrawing) return;
    isDrawing = false;
    ctx.closePath();
    scheduleSaveDraft();
  }

  // Mouse events
  canvas.addEventListener("mousedown", startStroke);
  canvas.addEventListener("mousemove", moveStroke);
  canvas.addEventListener("mouseup", endStroke);
  canvas.addEventListener("mouseleave", endStroke);

  // Touch events
  canvas.addEventListener("touchstart", startStroke, { passive: false });
  canvas.addEventListener("touchmove", moveStroke, { passive: false });
  canvas.addEventListener("touchend", endStroke);
  canvas.addEventListener("touchcancel", endStroke);
}

// === Undo ===
function saveSnapshot() {
  strokeHistory.push(canvas.toDataURL());
  // Keep max 30 undo steps
  if (strokeHistory.length > 30) strokeHistory.shift();
}

function undo() {
  if (strokeHistory.length === 0) return;
  const dataUrl = strokeHistory.pop();
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    scheduleSaveDraft();
  };
  img.src = dataUrl;
}

function clearCanvas() {
  saveSnapshot();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  document.getElementById("prompt-input").value = "";
  scheduleSaveDraft();
}

function isCanvasEmpty() {
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) {
      return false;
    }
  }
  return true;
}


// === Photo upload ===
function handlePhotoUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  // Reset the input so the same file can be re-selected
  e.target.value = "";

  const reader = new FileReader();
  reader.onload = function (ev) {
    const img = new Image();
    img.onload = function () {
      // Save current state for undo
      saveSnapshot();

      // Clear canvas to white
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Scale image to fit canvas while preserving aspect ratio
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (canvas.width - w) / 2;
      const y = (canvas.height - h) / 2;

      ctx.drawImage(img, x, y, w, h);
      scheduleSaveDraft();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// === Export drawing as PNG ===
function exportDrawing() {
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  link.download = "streg-" + timestamp + ".png";
  link.href = canvas.toDataURL("image/png");
  link.click();
}

// === Draft saving (localStorage) ===
let saveTimer = null;

function scheduleSaveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 1000);
}

function saveDraft() {
  try {
    localStorage.setItem("streg_draft", canvas.toDataURL());
    localStorage.setItem("streg_prompt", document.getElementById("prompt-input").value);
    showSaveIndicator();
  } catch (e) {
    // localStorage full or unavailable - no big deal
  }
}

function restoreDraft() {
  const draft = localStorage.getItem("streg_draft");
  if (!draft) return;
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = draft;

  const prompt = localStorage.getItem("streg_prompt");
  if (prompt) {
    document.getElementById("prompt-input").value = prompt;
  }
}

function showSaveIndicator() {
  const indicator = document.getElementById("saving-indicator");
  indicator.hidden = false;
  indicator.classList.add("visible");
  setTimeout(() => {
    indicator.classList.remove("visible");
    setTimeout(() => { indicator.hidden = true; }, 300);
  }, 1000);
}

// === PIN Auth ===
function setupPIN() {
  const input = document.getElementById("pin-input");
  const btn = document.getElementById("pin-submit");
  const error = document.getElementById("pin-error");

  async function tryAuth() {
    const pin = input.value.trim();
    if (!pin) return;

    if (!WORKER_URL) {
      error.textContent = "Worker URL not configured. See README for setup.";
      error.hidden = false;
      return;
    }

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
        showDrawScreen();
      } else {
        error.hidden = false;
        input.value = "";
        input.focus();
      }
    } catch (err) {
      error.textContent = "Could not connect. Try again!";
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener("click", tryAuth);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryAuth();
  });
}

function showDrawScreen() {
  document.getElementById("pin-screen").hidden = true;
  document.getElementById("draw-screen").hidden = false;
  // Re-measure canvas now that it's visible
  setupCanvas();
  restoreDraft();
}

// === Submit to API ===
function setupSubmit() {
  const btn = document.getElementById("submit-btn");
  const btnText = btn.querySelector(".btn-text");
  const btnLoading = btn.querySelector(".btn-loading");

  btn.addEventListener("click", async () => {
    console.warn("[replicate] Submit button clicked");
    if (isCanvasEmpty()) {
      alert("Draw something first!");
      return;
    }

    let prompt = document.getElementById("prompt-input").value.trim();

    if (!WORKER_URL) {
      alert("Worker URL not configured. See README for setup instructions.");
      return;
    }

    btn.disabled = true;
    btnText.hidden = true;
    btnLoading.hidden = false;
    // Clear previous prompt info
    const promptInfoEl = document.getElementById("prompt-info");
    if (promptInfoEl) { promptInfoEl.hidden = true; promptInfoEl.textContent = ""; }

    try {
      // Get the canvas as a base64 PNG
      const imageData = canvas.toDataURL("image/png");

      if (!prompt) {
        // If no prompt, auto-detect what the drawing looks like
        btnLoading.textContent = "Looking at your drawing...";
        const described = await describeDrawing(imageData);
        if (described.failed) {
          // Don't auto-submit a bad fallback — let the user type their own
          document.getElementById("prompt-input").value = "";
          document.getElementById("prompt-input").setAttribute("placeholder", "Auto-describe didn't work — type what you drew!");
          document.getElementById("prompt-input").focus();
          btn.disabled = false;
          btnText.hidden = false;
          btnLoading.hidden = true;
          return;
        }
        // Show the full enriched prompt so users can see what the AI came up with
        prompt = described.prompt;
        document.getElementById("prompt-input").value = prompt;
      }

      // Send to worker
      console.warn("[replicate] Sending generate request with prompt:", prompt);
      btnLoading.textContent = "Working the magic...";
      let res;
      try {
        res = await fetch(WORKER_URL + "/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + authToken,
          },
          body: JSON.stringify({ image: imageData, prompt }),
        });
      } catch (fetchErr) {
        throw new Error("[generate] Network error: " + (fetchErr.message || "could not reach server"));
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const step = err.step || "generate";
        const detail = err.detail ? ` (${err.detail})` : "";
        throw new Error(`[${step}] ` + (err.error || "Something went wrong") + detail);
      }

      const data = await res.json();

      // Log and show prompt details
      if (data.prompt_details) {
        console.warn("[replicate] Generate prompt:", data.prompt_details.prompt);
        console.warn("[replicate] Generate positive:", data.prompt_details.a_prompt);
        console.warn("[replicate] Generate negative:", data.prompt_details.n_prompt);
        showPromptDetails(data.prompt_details);
      }

      // Poll for result if we got a prediction ID
      if (data.id && !data.output) {
        await pollForResult(data.id, prompt);
      } else if (data.output) {
        showResult(data.output, prompt);
      }
    } catch (err) {
      console.error("Generation error:", err.message || err);
      const msg = err.message || "Unknown error";
      if (msg.includes("Not authorized") || msg.includes("401")) {
        alert("Your session expired. Refresh the page to log in again.");
      } else {
        alert("Oops! " + msg);
      }
    } finally {
      btn.disabled = false;
      btnText.hidden = false;
      btnLoading.hidden = true;
    }
  });
}

async function describeDrawing(imageData) {
  const fallback = "a colorful children's drawing";

  console.warn("[replicate] Sending describe request (BLIP + LLM enrichment)");
  const res = await fetch(WORKER_URL + "/describe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + authToken,
    },
    body: JSON.stringify({ image: imageData }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const reason = err.detail || err.error || "HTTP " + res.status;
    console.warn("[describe] Request failed:", res.status, reason);
    showPromptInfo("Describe failed: " + reason);
    return { caption: fallback, prompt: fallback, failed: true };
  }

  const data = await res.json();

  // Log describe prompts for debug view
  if (data.prompt_details) {
    console.warn("[replicate] BLIP question:", data.prompt_details.blip_question);
    console.warn("[replicate] BLIP raw caption:", data.prompt_details.blip_raw_caption);
    console.warn("[replicate] LLM enrichment prompt:", data.prompt_details.llm_prompt);
    console.warn("[replicate] Enriched prompt:", data.prompt_details.enriched_prompt);
  }

  return {
    caption: data.subject || fallback,
    prompt: data.prompt || data.subject || fallback,
  };
}

async function pollForResult(predictionId, prompt) {
  const btn = document.getElementById("submit-btn");
  const btnLoading = btn.querySelector(".btn-loading");
  const maxAttempts = 60; // 2 minutes max

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    btnLoading.textContent = "Still working...";

    try {
      const res = await fetch(WORKER_URL + "/status/" + predictionId, {
        headers: { "Authorization": "Bearer " + authToken },
      });
      const data = await res.json();

      if (data.status === "succeeded" && data.output) {
        showResult(data.output, prompt);
        btnLoading.textContent = "Working the magic...";
        return;
      } else if (data.status === "failed" || data.status === "canceled") {
        console.error("[poll] Generation prediction failed:", data.error);
        throw new Error("[poll] " + (data.error || "The magic didn't work this time. Try again!"));
      }
      // else still processing, keep polling
    } catch (err) {
      if (err.message.includes("magic")) throw err;
      // network error, keep trying
    }
  }
  throw new Error("[poll] This is taking too long. Try again with a simpler drawing!");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showResult(output, prompt) {
  const resultsArea = document.getElementById("results-area");
  const gallery = document.getElementById("results-gallery");

  // output is an array of image URLs
  const images = Array.isArray(output) ? output : [output];
  gallery.innerHTML = "";

  images.forEach(url => {
    const card = document.createElement("div");
    card.className = "result-card";
    card.innerHTML = `
      <img src="${escapeHtml(url)}" alt="AI generated image">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
    `;
    gallery.appendChild(card);
  });

  resultsArea.hidden = false;
  resultsArea.scrollIntoView({ behavior: "smooth" });

  // Save to history
  saveToHistory(images, prompt);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// === Prompt info display (visible on mobile instead of console) ===
function showPromptInfo(text) {
  const el = document.getElementById("prompt-info");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
}

function showPromptDetails(promptDetails) {
  if (!promptDetails) return;
  const el = document.getElementById("prompt-info");
  if (!el) return;
  const lines = [
    "Prompt: " + promptDetails.prompt,
    "Positive: " + promptDetails.a_prompt,
    "Negative: " + promptDetails.n_prompt,
  ];
  el.textContent = lines.join("\n");
  el.hidden = false;
}

// === History (localStorage) ===
function saveToHistory(images, prompt) {
  try {
    const history = JSON.parse(localStorage.getItem("streg_history") || "[]");
    history.unshift({
      images,
      prompt,
      timestamp: Date.now(),
      drawing: canvas.toDataURL("image/png"),
    });
    // Keep last 20
    if (history.length > 20) history.length = 20;
    localStorage.setItem("streg_history", JSON.stringify(history));
    loadHistory();
  } catch (e) {
    // localStorage full
  }
}

function loadHistory() {
  try {
    const history = JSON.parse(localStorage.getItem("streg_history") || "[]");
    if (history.length === 0) return;

    const area = document.getElementById("history-area");
    const gallery = document.getElementById("history-gallery");
    gallery.innerHTML = "";

    history.forEach(item => {
      item.images.forEach(url => {
        const card = document.createElement("div");
        card.className = "result-card";
        card.innerHTML = `
          <img src="${escapeHtml(url)}" alt="Past creation" loading="lazy">
          <div class="result-prompt">${escapeHtml(item.prompt)}</div>
        `;
        gallery.appendChild(card);
      });
    });

    area.hidden = false;
  } catch (e) {
    // corrupt history, ignore
  }
}
