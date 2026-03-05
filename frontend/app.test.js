import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = fs.readFileSync(path.join(__dirname, "app.js"), "utf-8");

// Minimal HTML that app.js expects
const HTML = `<!DOCTYPE html><html><body>
  <div id="pin-screen"></div>
  <div id="draw-screen" hidden></div>
  <div id="color-palette"></div>
  <input type="range" id="brush-size" value="6">
  <button id="eraser-btn"></button>
  <button id="undo-btn"></button>
  <button id="clear-btn"></button>
  <button id="photo-btn"></button>
  <input type="file" id="photo-input" accept="image/*" hidden>
  <div class="canvas-area" style="width:200px"><canvas id="drawing-canvas"></canvas></div>
  <div id="saving-indicator" hidden></div>
  <input id="pin-input"><button id="pin-submit"></button><p id="pin-error" hidden></p>
  <input id="prompt-input">
  <button id="submit-btn"><span class="btn-text"></span><span class="btn-loading" hidden></span></button>
  <pre id="prompt-info" hidden></pre>
  <div id="results-area" hidden><div id="results-gallery"></div></div>
  <div id="history-area" hidden><div id="history-gallery"></div></div>
  <script>/* placeholder for debug.js */</script>
</body></html>`;

function createEnv() {
  const dom = new JSDOM(HTML, {
    url: "http://localhost",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
  const win = dom.window;
  const doc = win.document;

  // Track alert calls
  const alertCalls = [];
  win.alert = (...args) => alertCalls.push(args);
  win.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

  // jsdom doesn't implement canvas — provide a stub
  const canvasEl = doc.getElementById("drawing-canvas");
  let pixelData = null;

  const ctxStub = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "",
    lineJoin: "",
    fillRect(x, y, w, h) {
      if (this.fillStyle === "#ffffff" && pixelData) {
        for (let i = 0; i < pixelData.length; i += 4) {
          pixelData[i] = 255;
          pixelData[i + 1] = 255;
          pixelData[i + 2] = 255;
          pixelData[i + 3] = 255;
        }
      }
    },
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    closePath() {},
    drawImage() {},
    getImageData(x, y, w, h) {
      if (!pixelData) {
        pixelData = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < pixelData.length; i += 4) {
          pixelData[i] = 255;
          pixelData[i + 1] = 255;
          pixelData[i + 2] = 255;
          pixelData[i + 3] = 255;
        }
      }
      return { data: pixelData };
    },
  };

  canvasEl.getContext = () => ctxStub;
  canvasEl.toDataURL = () => "data:image/png;base64,fake";

  // Stub clientWidth on the canvas-area div
  const area = doc.querySelector(".canvas-area");
  Object.defineProperty(area, "clientWidth", { get: () => 200 });

  // Execute app.js inside the jsdom window (runScripts: "dangerously" allows this)
  const script = doc.createElement("script");
  script.textContent = APP_JS;
  doc.body.appendChild(script);

  // Fire DOMContentLoaded to initialize the app
  doc.dispatchEvent(new win.Event("DOMContentLoaded"));

  return {
    win,
    doc,
    ctxStub,
    alertCalls,
    getPixelData: () => pixelData,
  };
}

describe("empty canvas guard", () => {
  it("does not submit when canvas is blank white", () => {
    const env = createEnv();
    const btn = env.doc.getElementById("submit-btn");

    btn.click();

    expect(env.alertCalls.length).toBe(1);
    expect(env.alertCalls[0][0]).toBe("Draw something first!");
    expect(env.win.fetch).not.toHaveBeenCalled();
  });

  it("proceeds past empty check when canvas has drawing", () => {
    const env = createEnv();

    // Init pixel buffer then paint a non-white pixel
    env.ctxStub.getImageData(0, 0, 200, 150);
    env.getPixelData()[0] = 0; // R channel of first pixel -> black

    const btn = env.doc.getElementById("submit-btn");
    btn.click();

    // Should NOT have shown the empty canvas alert
    const emptyAlerts = env.alertCalls.filter((a) => a[0] === "Draw something first!");
    expect(emptyAlerts.length).toBe(0);
  });

  it("blocks submit after clearing the canvas", () => {
    const env = createEnv();

    // Simulate some drawing then clear
    env.ctxStub.getImageData(0, 0, 200, 150);
    env.getPixelData()[0] = 0; // draw something

    // Clear button resets to all-white via fillRect
    env.doc.getElementById("clear-btn").click();

    env.doc.getElementById("submit-btn").click();

    expect(env.alertCalls.some((a) => a[0] === "Draw something first!")).toBe(true);
  });
});

describe("photo upload", () => {
  it("clicking the photo button triggers the file input", () => {
    const env = createEnv();
    const photoInput = env.doc.getElementById("photo-input");
    const clickSpy = vi.spyOn(photoInput, "click");

    env.doc.getElementById("photo-btn").click();

    expect(clickSpy).toHaveBeenCalled();
  });

  it("photo input exists with correct accept attribute", () => {
    const env = createEnv();
    const photoInput = env.doc.getElementById("photo-input");

    expect(photoInput).toBeTruthy();
    expect(photoInput.getAttribute("accept")).toBe("image/*");
  });
});
