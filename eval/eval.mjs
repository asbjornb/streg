#!/usr/bin/env node
/**
 * Streg Prompt Eval Harness
 *
 * Runs test scribble images through different prompt variants via Replicate,
 * then generates an HTML comparison page.
 *
 * Usage:
 *   REPLICATE_API_TOKEN=r8_xxx node eval.mjs
 *   REPLICATE_API_TOKEN=r8_xxx node eval.mjs --variants current,storybook_style
 *   REPLICATE_API_TOKEN=r8_xxx node eval.mjs --prompt "a cat on a hill"
 *
 * Options:
 *   --variants <names>   Comma-separated variant names to run (default: all)
 *   --prompt <text>      Skip BLIP/LLM — use this prompt for all images
 *   --images <dir>       Directory with test PNGs (default: ./test-images)
 *   --out <dir>          Output directory (default: ./results)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_API_TOKEN) {
  console.error("Error: Set REPLICATE_API_TOKEN environment variable");
  process.exit(1);
}

const CONTROLNET_VERSION = "435061a1b5a4c1e26740464bf786efdfa9cb3a3ac488595a2de23e143fdb0117";
const BLIP_VERSION = "f677695e5e89f8b236e52ecd1d3f01beb44c34606419bcc19345e046d8f786f9";

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf("--" + name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const configPath = path.join(__dirname, "prompt-variants.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const variantFilter = getArg("variants")?.split(",");
const manualPrompt = getArg("prompt");
const imagesDir = path.resolve(getArg("images") || path.join(__dirname, "test-images"));
const outDir = path.resolve(getArg("out") || path.join(__dirname, "results"));

// --- Collect test images ---
const imageFiles = fs.readdirSync(imagesDir)
  .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
  .sort();

if (imageFiles.length === 0) {
  console.error(`No images found in ${imagesDir}`);
  console.error("Draw some scribbles in the app and use the export button (download icon) to save them as PNGs.");
  process.exit(1);
}

console.log(`Found ${imageFiles.length} test image(s): ${imageFiles.join(", ")}`);

// --- Select variants ---
const variants = Object.entries(config.variants)
  .filter(([name]) => !variantFilter || variantFilter.includes(name));

if (variants.length === 0) {
  console.error("No matching variants found. Available:", Object.keys(config.variants).join(", "));
  process.exit(1);
}

console.log(`Running ${variants.length} variant(s): ${variants.map(([n]) => n).join(", ")}`);

// --- Replicate helpers ---
async function replicatePredict(body, waitSync = false) {
  const url = body.version
    ? "https://api.replicate.com/v1/predictions"
    : `https://api.replicate.com/v1/models/${body.model}/predictions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + REPLICATE_API_TOKEN,
      "Content-Type": "application/json",
      ...(waitSync ? { Prefer: "wait" } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Replicate ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function pollPrediction(id) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: "Bearer " + REPLICATE_API_TOKEN },
    });
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error("Prediction failed: " + (data.error || data.status));
    }
  }
  throw new Error("Prediction timed out");
}

async function downloadImage(url, filepath) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
}

// --- Caption cleaning (matches worker/src/index.js) ---
const MEDIUM_NOUNS = "drawing|sketch|doodle|scribble|picture|illustration|image|artwork|painting|cartoon|outline|diagram|depiction|rendition|rendering";
const MEDIUM_ADJECTIVES = "black\\s+and\\s+white|monochrome|grayscale|grey|gray|simple|hand[- ]?drawn|hand[- ]?sketched|rough|crude|basic|pencil|ink|pen|charcoal|crayon|chalk|line|stick\\s+figure|childish|child's|children's|kid's";
const COLOR_ADJECTIVES = "black\\s+and\\s+white|monochrome|grayscale|grey|gray";

function cleanCaption(raw) {
  let text = raw;
  text = text.replace(/^(Caption|Answer):\s*/i, "");
  text = text.replace(/^(this|there|it)\s+(is|looks like|appears to be|seems to be)\s+/i, "");
  const mediumPrefixRe = new RegExp(`^(a|an|the)\\s+((${MEDIUM_ADJECTIVES})\\s+)*(${MEDIUM_NOUNS})\\s+(of\\s+)?`, "i");
  text = text.replace(mediumPrefixRe, "");
  const noArticlePrefixRe = new RegExp(`^((${MEDIUM_ADJECTIVES})\\s+)+(${MEDIUM_NOUNS})\\s+(of\\s+)?`, "i");
  text = text.replace(noArticlePrefixRe, "");
  const colorAdjLeadRe = new RegExp(`^(a|an|the)\\s+(${COLOR_ADJECTIVES})\\s+`, "i");
  text = text.replace(colorAdjLeadRe, "$1 ");
  const colorAdjBareRe = new RegExp(`^(${COLOR_ADJECTIVES})\\s+`, "i");
  text = text.replace(colorAdjBareRe, "");
  text = text.replace(/[,.]?\s+(drawn|sketched|rendered|depicted|shown)\s+(in|on|with)\s+.*$/i, "");
  const trailingRe = new RegExp(`[,.]?\\s+(in\\s+)?(${MEDIUM_ADJECTIVES})\\s*$`, "i");
  text = text.replace(trailingRe, "");
  const midRe = new RegExp(`[,.]?\\s*(${MEDIUM_ADJECTIVES})\\s+(${MEDIUM_NOUNS})\\s*[,.]?`, "gi");
  text = text.replace(midRe, " ");
  text = text.replace(/^[\s,.:;]+|[\s,.:;]+$/g, "").replace(/\s{2,}/g, " ");
  return text;
}

// --- Describe pipeline (BLIP + LLM) ---
async function describeImage(imageDataUrl, variant) {
  // Step 1: BLIP caption
  console.log("    BLIP captioning...");
  const blipPrediction = await replicatePredict({
    version: BLIP_VERSION,
    input: {
      image: imageDataUrl,
      task: "visual_question_answering",
      question: variant.blip_question,
    },
  }, true);

  const blipOutput = (typeof blipPrediction.output === "string"
    ? blipPrediction.output
    : (blipPrediction.output || "").toString()
  ).trim();
  const cleaned = cleanCaption(blipOutput);
  console.log(`    BLIP raw: "${blipOutput}"`);
  console.log(`    BLIP cleaned: "${cleaned}"`);

  if (!cleaned) return { caption: blipOutput, cleanedCaption: "", prompt: "a colorful children's drawing" };

  // Step 2: LLM enrichment
  const llmPrompt = variant.llm_enrichment.replace("{{caption}}", cleaned);
  console.log("    LLM enriching...");

  try {
    const llmPrediction = await replicatePredict({
      model: "meta/meta-llama-3-8b-instruct",
      input: { prompt: llmPrompt, max_tokens: 60, temperature: 0.7 },
    }, true);

    if (llmPrediction.status === "succeeded" && llmPrediction.output) {
      const text = Array.isArray(llmPrediction.output)
        ? llmPrediction.output.join("")
        : llmPrediction.output;
      const enriched = text.trim().replace(/^["']|["']$/g, "");
      console.log(`    Enriched: "${enriched}"`);
      return { caption: blipOutput, cleanedCaption: cleaned, prompt: enriched || cleaned };
    }
  } catch (e) {
    console.log(`    LLM enrichment failed, using cleaned caption: ${e.message}`);
  }

  return { caption: blipOutput, cleanedCaption: cleaned, prompt: cleaned };
}

// --- Main ---
async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  // Results: { imageName -> { variantName -> { prompt, outputPath, ... } } }
  const results = {};

  for (const imageFile of imageFiles) {
    const imageName = path.parse(imageFile).name;
    results[imageName] = {};
    const imagePath = path.join(imagesDir, imageFile);
    const imageBuffer = fs.readFileSync(imagePath);
    const imageDataUrl = "data:image/png;base64," + imageBuffer.toString("base64");

    // Copy input image to results
    const inputCopyPath = path.join(outDir, `${imageName}_input.png`);
    fs.copyFileSync(imagePath, inputCopyPath);

    for (const [variantName, variant] of variants) {
      console.log(`\n[${imageName}] x [${variantName}]`);

      // Determine prompt
      let prompt, caption, cleanedCaption;
      if (manualPrompt) {
        prompt = manualPrompt;
        caption = "";
        cleanedCaption = "";
        console.log(`  Using manual prompt: "${prompt}"`);
      } else {
        const desc = await describeImage(imageDataUrl, variant);
        prompt = desc.prompt;
        caption = desc.caption;
        cleanedCaption = desc.cleanedCaption;
      }

      // Generate with ControlNet
      console.log("  Generating with ControlNet...");
      const prediction = await replicatePredict({
        version: CONTROLNET_VERSION,
        input: {
          image: imageDataUrl,
          prompt,
          num_samples: "1",
          image_resolution: variant.image_resolution || "512",
          ddim_steps: variant.ddim_steps || 20,
          scale: variant.scale || 9,
          seed: 42, // fixed seed for comparison
          eta: 0,
          a_prompt: variant.a_prompt,
          n_prompt: variant.n_prompt,
        },
      });

      // Poll for result
      console.log("  Waiting for result...");
      const result = await pollPrediction(prediction.id);
      const outputUrls = Array.isArray(result.output) ? result.output : [result.output];

      // Download output image
      const outputFilename = `${imageName}_${variantName}.png`;
      const outputPath = path.join(outDir, outputFilename);
      await downloadImage(outputUrls[0], outputPath);
      console.log(`  Saved: ${outputFilename}`);

      results[imageName][variantName] = {
        caption,
        cleanedCaption,
        prompt,
        outputFile: outputFilename,
        inputFile: `${imageName}_input.png`,
        variant: { ...variant, name: variantName },
      };
    }
  }

  // Generate HTML comparison
  generateHTML(results);
  console.log(`\nDone! Open ${path.join(outDir, "compare.html")} to see results.`);
}

// --- HTML report ---
function generateHTML(results) {
  const imageNames = Object.keys(results);
  const variantNames = variants.map(([n]) => n);

  const rows = imageNames.map(imageName => {
    const inputFile = `${imageName}_input.png`;
    const cells = variantNames.map(vn => {
      const r = results[imageName][vn];
      if (!r) return "<td>—</td>";
      return `<td>
        <img src="${r.outputFile}" alt="${vn}" loading="lazy">
        ${r.caption ? `<div class="caption"><b>Caption:</b> ${escapeHtml(r.caption)}</div>` : ""}
        ${r.cleanedCaption ? `<div class="caption"><b>Cleaned:</b> ${escapeHtml(r.cleanedCaption)}</div>` : ""}
        <div class="prompt"><b>Prompt:</b> ${escapeHtml(r.prompt)}</div>
        <div class="params">steps=${r.variant.ddim_steps} scale=${r.variant.scale}</div>
      </td>`;
    }).join("\n");

    return `<tr>
      <td class="input-cell">
        <img src="${inputFile}" alt="input">
        <div class="label">${escapeHtml(imageName)}</div>
      </td>
      ${cells}
    </tr>`;
  }).join("\n");

  const variantHeaders = variantNames.map(vn => {
    const v = config.variants[vn];
    return `<th>${escapeHtml(vn)}<br><small>${escapeHtml(v.description || "")}</small></th>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Streg Prompt Eval</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; padding: 16px; }
  h1 { margin-bottom: 8px; }
  .meta { color: #666; margin-bottom: 16px; font-size: 0.9rem; }
  table { border-collapse: collapse; width: 100%; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th, td { border: 1px solid #e0e0e0; padding: 8px; text-align: center; vertical-align: top; }
  th { background: #fafafa; font-size: 0.85rem; }
  td img { max-width: 100%; border-radius: 4px; }
  .input-cell { background: #fff9f0; min-width: 150px; }
  .caption { font-size: 0.75rem; color: #777; margin-top: 4px; word-break: break-word; }
  .prompt { font-size: 0.75rem; color: #555; margin-top: 4px; word-break: break-word; }
  .params { font-size: 0.7rem; color: #999; margin-top: 2px; }
  .label { font-weight: 600; font-size: 0.8rem; margin-top: 4px; }
  /* Mobile: stack vertically */
  @media (max-width: 700px) {
    table, thead, tbody, th, td, tr { display: block; }
    tr { margin-bottom: 16px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
    th { text-align: left; }
    td { border: none; border-top: 1px solid #eee; }
    td img { max-width: 80%; }
  }
</style>
</head>
<body>
<h1>Streg Prompt Eval</h1>
<p class="meta">Generated ${new Date().toISOString().slice(0, 19)} &mdash; ${imageNames.length} image(s) × ${variantNames.length} variant(s)</p>
<table>
<thead>
  <tr>
    <th>Input</th>
    ${variantHeaders}
  </tr>
</thead>
<tbody>
  ${rows}
</tbody>
</table>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "compare.html"), html);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
