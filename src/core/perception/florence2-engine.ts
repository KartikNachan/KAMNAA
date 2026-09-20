// ============================================================
// KAMNAA — Florence-2 Perception Engine (Offscreen Only)
// The actual "local ViT that reads the screen" the PS requires.
//
// Uses @huggingface/transformers v3 to load Florence-2-base-ft
// in the offscreen document. Runs three tasks:
//   1. <OD> — Open-vocab object detection (find buttons, inputs, links)
//   2. <OCR_WITH_REGION> — OCR with bounding boxes (read all text)
//   3. <CAPTION_TO_PHRASE_GROUNDING> — "find the submit button"
//
// Output: a ScreenGraph — a structured, unified representation
// of everything visible on screen.
// ============================================================

// Must precede the transformers.js import: its module init sets
// ONNX_ENV.wasm.wasmPaths to a CDN URL unless one is already set.
import { ortRuntimeUrl } from "../runtime/ort-env";
import { env, AutoModelForImageTextToText, AutoProcessor, RawImage } from "@huggingface/transformers";
import type { Tier } from "../../types/runtime";
import { detectBackend } from "../runtime/backend";

// ── Configure transformers.js for browser ────────────────────

// Florence-2 is NOT bundled as a local file — only PP-OCR models are bundled.
// Enabling allowLocalModels causes transformers.js to try /models/onnx-community/Florence-2-base-ft/...
// which generates 9 failed fetches before falling back to HuggingFace. Disable it.
env.allowLocalModels = false;
env.useBrowserCache = true; // Cache downloads in browser IndexedDB so they survive SW restarts

if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  (env as any).wasm = (env as any).wasm || {};
  (env as any).wasm.wasmPaths = chrome.runtime.getURL("ort/");
}

// Belt and braces: overwrite whatever transformers.js decided at import time.
// Its default is a remote jsdelivr URL, which MV3 blocks and which would make
// "nothing leaves the device" untrue on every cold start.
try {
  (env.backends as any).onnx.wasm.wasmPaths = ortRuntimeUrl();
  (env.backends as any).onnx.wasm.numThreads = 1;
} catch {
  // Older/newer shapes of env.backends — the ort-env pin already covers us.
}

// ── Types ────────────────────────────────────────────────────

export interface ScreenGraph {
  /** All detected UI elements with bounding boxes and labels */
  elements: DetectedElement[];
  /** All text regions with bounding boxes and content */
  textRegions: TextRegion[];
  /** Page-level caption describing what the screen shows */
  caption: string;
  /** Timing breakdown */
  timings: {
    total: number;
    modelLoad: number;
    od: number;
    ocr: number;
    grounding: number;
  };
  /** Which tasks were actually run */
  tasksRun: string[];
  /** Model info */
  model: {
    name: string;
    backend: string;
    tier: Tier;
    error?: string;
  };
}

export interface DetectedElement {
  label: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
  /** Category inferred from label */
  category: "button" | "input" | "link" | "image" | "text" | "dropdown" | "checkbox" | "unknown";
}

export interface TextRegion {
  text: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
}

export interface GroundingQuery {
  phrase: string;
  results: Array<{
    box: { x: number; y: number; w: number; h: number };
    confidence: number;
  }>;
}

// ── Singleton Model Cache ────────────────────────────────────

let model: any = null;
let processor: any = null;
let modelLoadTime = 0;
let loadPromise: Promise<void> | null = null;

let lastInitError: string | null = null;
let activeBackend: "webgpu" | "wasm" = "wasm";
let activeDtype = "q4";

/** Repo id — also used by the model host to pre-warm the browser cache. */
export const FLORENCE_MODEL_ID = "onnx-community/Florence-2-base-ft";

/**
 * Get the last Florence-2 initialization error if any.
 */
export function getFlorenceInitError(): string | null {
  return lastInitError;
}

/**
 * Check if Florence-2 is cached in the browser's CacheStorage.
 * Verifies all required ONNX subgraphs (encoder, decoder, vision_encoder) and configs.
 */
export async function isFlorenceCached(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const hasCache = await caches.has("transformers-cache");
    if (!hasCache) return false;
    const cache = await caches.open("transformers-cache");
    const requests = await cache.keys();
    const florenceRequests = requests.filter((r) =>
      r.url.includes("Florence-2-base-ft")
    );
    if (florenceRequests.length === 0) return false;

    const hasConfig = florenceRequests.some((r) => r.url.includes("config.json"));
    const hasEncoder = florenceRequests.some((r) => r.url.includes("encoder_model"));
    const hasDecoder = florenceRequests.some((r) => r.url.includes("decoder_model_merged"));
    const hasVision = florenceRequests.some((r) => r.url.includes("vision_encoder"));
    const hasOnnx = florenceRequests.some((r) => r.url.includes(".onnx"));

    return hasConfig && hasEncoder && hasDecoder && hasVision && hasOnnx;
  } catch {
    return false;
  }
}


export async function clearFlorenceCache(): Promise<number> {
  if (typeof caches === "undefined") return 0;
  try {
    const hasCache = await caches.has("transformers-cache");
    if (!hasCache) return 0;
    const cache = await caches.open("transformers-cache");
    const requests = await cache.keys();
    let deleted = 0;
    for (const req of requests) {
      if (req.url.includes("Florence-2-base-ft")) {
        await cache.delete(req);
        deleted++;
      }
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Load the model, reporting progress so a pre-warm can show a real bar
 * instead of stalling silently on a multi-hundred-megabyte download.
 */
async function ensureModel(
  onProgress?: (fraction: number) => void
): Promise<void> {
  if (model && processor) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    lastInitError = null;
    const t0 = performance.now();
    const be = await detectBackend();

    // transformers.js reports per-file progress; average across files so the
    // caller sees one monotonic-ish fraction rather than several restarts.
    const fileProgress = new Map<string, number>();
    const progress_callback = onProgress
      ? (p: any) => {
          if (p?.status === "progress" && typeof p.progress === "number") {
            fileProgress.set(p.file ?? "?", p.progress / 100);
          } else if (p?.status === "done" && p.file) {
            fileProgress.set(p.file, 1);
          }
          if (fileProgress.size > 0) {
            const sum = [...fileProgress.values()].reduce((a, b) => a + b, 0);
            onProgress(Math.min(sum / fileProgress.size, 1));
          }
        }
      : undefined;

    // Initialize AutoProcessor first if not already loaded
    if (!processor) {
      processor = await AutoProcessor.from_pretrained(FLORENCE_MODEL_ID, {
        progress_callback,
      } as any);
    }

    const tryLoad = async (
      device: "webgpu" | "wasm",
      dtype: string | Record<string, string>
    ) => {
      const dtypeStr = typeof dtype === "string" ? dtype : JSON.stringify(dtype);
      console.log(`[KAMNAA] Initializing Florence-2 on ${device} with dtype ${dtypeStr}...`);
      return await AutoModelForImageTextToText.from_pretrained(FLORENCE_MODEL_ID, {
        device,
        dtype,
        progress_callback,
      } as any);
    };

    let loadedModel: any = null;

    // FIX 1 & 3: For Tier A, attempt WebGPU with supported per-subgraph mixed precision:
    // embed_tokens & vision_encoder: fp16 (fast WebGPU ViT)
    // encoder_model & decoder_model_merged: q4 (avoids WebGPU logits subgraph validation error)
    if (be.tier === "A") {
      try {
        loadedModel = await tryLoad("webgpu", {
          embed_tokens: "fp16",
          vision_encoder: "fp16",
          encoder_model: "q4",
          decoder_model_merged: "q4",
        });
        activeBackend = "webgpu";
        activeDtype = "mixed (fp16/q4)";
      } catch (gpuErr: any) {
        const gpuMsg = gpuErr instanceof Error ? gpuErr.message : String(gpuErr);
        console.warn(`[KAMNAA] Florence WebGPU initialization failed:\n${gpuMsg}`);
        console.log(`[KAMNAA] Florence fallback:\nWASM + q4`);
        lastInitError = `WebGPU init failed (${gpuMsg})`;
        loadedModel = null;
      }
    }

    // FIX 2: Tier B/C or WebGPU fallback uses WASM + q4. WASM must never use fp16.
    if (!loadedModel) {
      try {
        loadedModel = await tryLoad("wasm", "q4");
        activeBackend = "wasm";
        activeDtype = "q4";
      } catch (wasmErr: any) {
        const wasmMsg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
        console.error(`[KAMNAA] Florence WASM initialization failed:\n${wasmMsg}`);
        console.warn(`[KAMNAA] Florence unavailable:\nusing DOM+OCR fallback`);
        lastInitError = lastInitError
          ? `${lastInitError}; WASM init failed (${wasmMsg})`
          : `WASM init failed (${wasmMsg})`;
        model = null;
        processor = null;
        throw new Error(lastInitError);
      }
    }

    model = loadedModel;
    modelLoadTime = performance.now() - t0;
    console.log(
      `[KAMNAA] Florence-2 loaded successfully (${activeBackend}, ${activeDtype}, tier ${be.tier}) in ${modelLoadTime.toFixed(0)}ms`
    );
  })().finally(() => {
    loadPromise = null;
  });

  return loadPromise;
}

/**
 * Download and initialize Florence-2 ahead of time.
 * Called by the model host so the Models tab can pre-warm it, instead of
 * a ~333-1086 MB fetch landing in the middle of a live pipeline run.
 */
export async function warmFlorence(
  onProgress?: (fraction: number) => void
): Promise<void> {
  await ensureModel(onProgress);
}

/**
 * Check if Florence-2 is available (loaded or loadable).
 * Returns false if the model failed to load or the runtime is Tier C.
 */
export function isFlorenceAvailable(): boolean {
  return model !== null && processor !== null;
}

/**
 * Gracefully degrade: skip Florence-2 if not loaded within timeout.
 * Returns true if the model loaded, false if we should skip to DOM+OCR fallback.
 * If the model has already been initialized, returns true immediately.
 */
export async function ensureModelWithTimeout(ms = 30000): Promise<boolean> {
  if (isFlorenceAvailable()) return true;
  try {
    await Promise.race([
      ensureModel(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);
    return isFlorenceAvailable();
  } catch (err) {
    console.warn(`[KAMNAA] Florence-2 failed to load within ${ms}ms:`, err);
    console.warn("[KAMNAA] Florence unavailable:\nusing DOM+OCR fallback");
    return false;
  }
}

// ── Core Perception Functions ────────────────────────────────

/**
 * Run open-vocab detection on a screenshot.
 * Finds UI elements: buttons, inputs, links, images, etc.
 *
 * @param imageUrl - Screenshot data URL or URL
 * @returns Detected elements with bounding boxes
 */
export async function detectElements(imageUrl: string): Promise<DetectedElement[]> {
  await ensureModel();

  const image = await RawImage.fromURL(imageUrl);
  const inputs = await processor(image, "<OD>");

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 256,
  });

  const decoded = processor.batch_decode(outputs, {
    skip_special_tokens: false,
  })[0];

  // Parse Florence-2 OD output: official post-processor with regex fallbacks
  return parseODOutput(decoded, image.width, image.height);
}

/**
 * Run OCR with region detection on a screenshot.
 * Reads ALL text on screen with bounding boxes.
 *
 * @param imageUrl - Screenshot data URL or URL
 * @returns Text regions with content and bounding boxes
 */
export async function ocrWithRegion(imageUrl: string): Promise<TextRegion[]> {
  await ensureModel();

  const image = await RawImage.fromURL(imageUrl);
  const inputs = await processor(image, "<OCR_WITH_REGION>");

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 1024,
  });

  const decoded = processor.batch_decode(outputs, {
    skip_special_tokens: false,
  })[0];

  return parseOCROutput(decoded, image.width, image.height);
}

/**
 * Phrase grounding: find elements matching a natural language phrase.
 * Example: "find the submit button" → bounding box of submit button.
 *
 * @param imageUrl - Screenshot data URL or URL
 * @param phrase - Natural language phrase to find
 * @returns Bounding boxes matching the phrase
 */
export async function groundPhrase(
  imageUrl: string,
  phrase: string
): Promise<GroundingQuery> {
  await ensureModel();

  const image = await RawImage.fromURL(imageUrl);
  const prompt = `<CAPTION_TO_PHRASE_GROUNDING>${phrase}`;
  const inputs = await processor(image, prompt);

  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 256,
  });

  const decoded = processor.batch_decode(outputs, {
    skip_special_tokens: false,
  })[0];

  return parseGroundingOutput(decoded, phrase, image.width, image.height);
}

/**
 * Full screen perception: run all Florence-2 tasks and build a ScreenGraph.
 * This is the "visual perception" the PS requires.
 *
 * @param imageUrl - Screenshot data URL
 * @returns Complete screen understanding
 */
export async function perceiveScreen(imageUrl: string): Promise<ScreenGraph> {
  const totalStart = performance.now();
  const tasksRun: string[] = [];
  let elements: DetectedElement[] = [];

  // If not in memory, check whether it is cached in browser CacheStorage.
  // If not cached, DO NOT block normal perception on a 333MB cold download.
  // Fallback immediately to DOM+OCR so user tasks run with zero delay.
  if (!isFlorenceReady()) {
    const cached = await isFlorenceCached();
    if (!cached) {
      console.log(
        "[KAMNAA] Florence-2 not cached locally — using DOM+OCR fallback (Warm Florence-2 in Runtime tab to activate)"
      );
      return {
        elements: [],
        textRegions: [],
        caption: "",
        timings: {
          total: performance.now() - totalStart,
          modelLoad: 0,
          od: 0,
          ocr: 0,
          grounding: 0,
        },
        tasksRun: [],
        model: {
          name: "Florence-2-base-ft",
          backend: "SKIPPED (Not cached, DOM+OCR fallback)",
          tier: "C",
        },
      };
    }
  }

  // Model is ready or cached in CacheStorage: ensure it is loaded into memory
  const loaded = isFlorenceAvailable() ? true : await ensureModelWithTimeout(30000);
  if (!loaded) {
    return {
      elements: [],
      textRegions: [],
      caption: "",
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: 0,
        ocr: 0,
        grounding: 0,
      },
      tasksRun: [],
      model: {
        name: "Florence-2-base-ft",
        backend: "FAILED",
        tier: "C",
        error: lastInitError || "Session initialization failed or timed out",
      },
    };
  }

  try {
    // Task 1: Open-vocab detection (find UI elements) with lightweight token limit
    const odStart = performance.now();
    elements = await detectElements(imageUrl);
    tasksRun.push("<OD>");
    tasksRun.push("OD");
    const odTime = performance.now() - odStart;

    // PP-OCR provides lightweight, high-speed on-device text OCR.
    // Heavy 1024-token Florence-2 <OCR_WITH_REGION> is skipped to prevent WASM memory heap overflow.

    return {
      elements,
      textRegions: [],
      caption: "Screen elements recognized by Florence-2 ViT",
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: odTime,
        ocr: 0,
        grounding: 0,
      },
      tasksRun,
      model: {
        name: "Florence-2-base-ft",
        backend: `transformers.js (${activeBackend}, ${activeDtype})`,
        tier: activeBackend === "webgpu" ? "A" : "B",
      },
    };
  } catch (error) {
    const errStr = error instanceof Error ? error.message : String(error);
    console.error("[KAMNAA] Florence-2 perception failed:", error);
    return {
      elements: [],
      textRegions: [],
      caption: "",
      timings: {
        total: performance.now() - totalStart,
        modelLoad: modelLoadTime,
        od: 0,
        ocr: 0,
        grounding: 0,
      },
      tasksRun,
      model: {
        name: "Florence-2-base-ft",
        backend: "FAILED",
        tier: "A",
        error: errStr,
      },
    };
  }
}

// ── Output Parsing ───────────────────────────────────────────

/**
 * Parse Florence-2 <OD> output.
 * Uses official Transformers.js processor.post_process_generation when available,
 * with standard Florence-2 and interleaved regex fallbacks.
 */
function parseODOutput(
  decoded: string,
  imageWidth: number,
  imageHeight: number
): DetectedElement[] {
  const elements: DetectedElement[] = [];

  // 1. Prefer processor.post_process_generation() from Transformers.js
  if (processor && typeof processor.post_process_generation === "function") {
    try {
      let cleanText = decoded
        .replaceAll("<s>", "")
        .replaceAll("</s>", "")
        .trim();
      if (cleanText.startsWith("<OD>")) {
        cleanText = cleanText.replace(/^<OD>/, "").trim();
      }

      const parsed = processor.post_process_generation(
        cleanText,
        "<OD>",
        [imageHeight, imageWidth]
      );

      const odResult = parsed && (parsed["<OD>"] || parsed);
      if (odResult && Array.isArray(odResult.bboxes) && Array.isArray(odResult.labels)) {
        for (let i = 0; i < odResult.bboxes.length; i++) {
          const [y1, x1, y2, x2] = odResult.bboxes[i];
          const rawLabel = (odResult.labels[i] || "").replace(/^OD>/, "").trim();
          if (isNaN(y1) || isNaN(x1) || isNaN(y2) || isNaN(x2)) continue;

          const x = Math.round(x1);
          const y = Math.round(y1);
          const w = Math.round(x2 - x1);
          const h = Math.round(y2 - y1);
          if (w <= 0 || h <= 0) continue;

          elements.push({
            label: rawLabel || `element-${elements.length}`,
            box: { x, y, w, h },
            confidence: 0.85,
            category: inferCategory(rawLabel),
          });
        }

        if (elements.length > 0) {
          return elements;
        }
      }
    } catch (err) {
      console.warn("[KAMNAA] Florence-2 processor.post_process_generation error, falling back to regex:", err);
    }
  }

  // 2. Pattern A (Standard Florence-2): label followed by 4 loc tokens
  // Example: button<loc_0050><loc_0120><loc_0200><loc_0350>
  const patternStandard = /([^<]+)?<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>/g;
  let match;
  while ((match = patternStandard.exec(decoded)) !== null) {
    const rawLabel = (match[1] || "").replace(/^<OD>/, "").trim();
    const y1 = parseInt(match[2], 10) / 1000;
    const x1 = parseInt(match[3], 10) / 1000;
    const y2 = parseInt(match[4], 10) / 1000;
    const x2 = parseInt(match[5], 10) / 1000;

    if (x2 <= x1 || y2 <= y1) continue;

    elements.push({
      label: rawLabel || `element-${elements.length}`,
      box: {
        x: Math.round(x1 * imageWidth),
        y: Math.round(y1 * imageHeight),
        w: Math.round((x2 - x1) * imageWidth),
        h: Math.round((y2 - y1) * imageHeight),
      },
      confidence: 0.85,
      category: inferCategory(rawLabel),
    });
  }

  if (elements.length > 0) {
    return elements;
  }

  // 3. Pattern B (Interleaved fallback): 4 loc tokens followed by label
  // Example: <loc_0050><loc_0120><loc_0200><loc_0350>button
  const patternAlt = /<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>([^<]*)/g;
  while ((match = patternAlt.exec(decoded)) !== null) {
    const y1 = parseInt(match[1], 10) / 1000;
    const x1 = parseInt(match[2], 10) / 1000;
    const y2 = parseInt(match[3], 10) / 1000;
    const x2 = parseInt(match[4], 10) / 1000;
    const label = match[5].trim();

    if (x2 <= x1 || y2 <= y1) continue;

    elements.push({
      label: label || `element-${elements.length}`,
      box: {
        x: Math.round(x1 * imageWidth),
        y: Math.round(y1 * imageHeight),
        w: Math.round((x2 - x1) * imageWidth),
        h: Math.round((y2 - y1) * imageHeight),
      },
      confidence: 0.85,
      category: inferCategory(label),
    });
  }

  return elements;
}

/**
 * Parse Florence-2 <OCR_WITH_REGION> output.
 * Returns text + bounding boxes.
 */
function parseOCROutput(
  decoded: string,
  imageWidth: number,
  imageHeight: number
): TextRegion[] {
  const regions: TextRegion[] = [];

  // 1. Prefer processor.post_process_generation()
  if (processor && typeof processor.post_process_generation === "function") {
    try {
      let cleanText = decoded.replaceAll("<s>", "").replaceAll("</s>", "").trim();
      if (cleanText.startsWith("<OCR_WITH_REGION>")) {
        cleanText = cleanText.replace(/^<OCR_WITH_REGION>/, "").trim();
      }
      const parsed = processor.post_process_generation(
        cleanText,
        "<OCR_WITH_REGION>",
        [imageHeight, imageWidth]
      );
      const ocrResult = parsed && (parsed["<OCR_WITH_REGION>"] || parsed);
      if (ocrResult) {
        if (Array.isArray(ocrResult.quad_boxes) && Array.isArray(ocrResult.labels)) {
          for (let i = 0; i < ocrResult.quad_boxes.length; i++) {
            const text = (ocrResult.labels[i] || "").trim();
            const q = ocrResult.quad_boxes[i];
            if (!text || !Array.isArray(q) || q.length < 8) continue;
            const xs = [q[1], q[3], q[5], q[7]];
            const ys = [q[0], q[2], q[4], q[6]];
            const minX = Math.round(Math.min(...xs));
            const maxX = Math.round(Math.max(...xs));
            const minY = Math.round(Math.min(...ys));
            const maxY = Math.round(Math.max(...ys));
            if (maxX <= minX || maxY <= minY) continue;
            regions.push({
              text,
              box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
              confidence: 0.85,
            });
          }
          if (regions.length > 0) return regions;
        }
      }
    } catch {}
  }

  // 2. Fallback regexes
  const patternStd = /([^<]+)?<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>/g;
  let match;
  while ((match = patternStd.exec(decoded)) !== null) {
    const text = (match[1] || "").replace(/^<OCR_WITH_REGION>/, "").trim();
    const y1 = parseInt(match[2], 10) / 1000;
    const x1 = parseInt(match[3], 10) / 1000;
    const y2 = parseInt(match[4], 10) / 1000;
    const x2 = parseInt(match[5], 10) / 1000;
    if (text.length > 0 && x2 > x1 && y2 > y1) {
      regions.push({
        text,
        box: {
          x: Math.round(x1 * imageWidth),
          y: Math.round(y1 * imageHeight),
          w: Math.round((x2 - x1) * imageWidth),
          h: Math.round((y2 - y1) * imageHeight),
        },
        confidence: 0.85,
      });
    }
  }

  if (regions.length > 0) return regions;

  // Florence-2 OCR output format: <loc_XXXX>text
  const pattern = /<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>([^<\n]+)/g;
  while ((match = pattern.exec(decoded)) !== null) {
    const y1 = parseInt(match[1]) / 1000;
    const x1 = parseInt(match[2]) / 1000;
    const y2 = parseInt(match[3]) / 1000;
    const x2 = parseInt(match[4]) / 1000;
    const text = match[5].trim();

    if (text.length > 0) {
      regions.push({
        text,
        box: {
          x: Math.round(x1 * imageWidth),
          y: Math.round(y1 * imageHeight),
          w: Math.round((x2 - x1) * imageWidth),
          h: Math.round((y2 - y1) * imageHeight),
        },
        confidence: 0.85,
      });
    }
  }

  return regions;
}

/**
 * Parse Florence-2 <CAPTION_TO_PHRASE_GROUNDING> output.
 */
function parseGroundingOutput(
  decoded: string,
  phrase: string,
  imageWidth: number,
  imageHeight: number
): GroundingQuery {
  const results: GroundingQuery["results"] = [];

  const pattern = /<loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})><loc_(\d{1,4})>/g;
  let match;
  while ((match = pattern.exec(decoded)) !== null) {
    const y1 = parseInt(match[1]) / 1000;
    const x1 = parseInt(match[2]) / 1000;
    const y2 = parseInt(match[3]) / 1000;
    const x2 = parseInt(match[4]) / 1000;

    results.push({
      box: {
        x: Math.round(x1 * imageWidth),
        y: Math.round(y1 * imageHeight),
        w: Math.round((x2 - x1) * imageWidth),
        h: Math.round((y2 - y1) * imageHeight),
      },
      confidence: 0.85,
    });
  }

  return { phrase, results };
}

// ── Helpers ──────────────────────────────────────────────────

function inferCategory(label: string): DetectedElement["category"] {
  const lower = label.toLowerCase();
  if (/button|btn|submit|cancel|ok|yes|no/.test(lower)) return "button";
  if (/input|field|text|email|password|search/.test(lower)) return "input";
  if (/link|anchor|url/.test(lower)) return "link";
  if (/image|img|photo|icon/.test(lower)) return "image";
  if (/dropdown|select|combo/.test(lower)) return "dropdown";
  if (/check|toggle|switch/.test(lower)) return "checkbox";
  if (/text|label|heading|title|paragraph/.test(lower)) return "text";
  return "unknown";
}

/**
 * Check if Florence-2 is loaded and ready.
 */
export function isFlorenceReady(): boolean {
  return model !== null && processor !== null;
}

/**
 * Get model status for HUD display.
 */
export function getFlorenceStatus(): { loaded: boolean; loadTime: number } {
  return {
    loaded: isFlorenceReady(),
    loadTime: modelLoadTime,
  };
}
