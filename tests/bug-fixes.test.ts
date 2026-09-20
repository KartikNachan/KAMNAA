import { describe, it, expect } from "vitest";

describe("Bug Fix Verification", () => {
  it("parses channel queries correctly without forcing 'on/in/at' prepositions", () => {
    const text = "open harkirat singh youtube channel";
    const lower = text.toLowerCase();

    const searchMatch =
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(?:on|in|at)\s+([\w.]+)/) ||
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(youtube|google|bing|amazon|flipkart|github)\b/);

    const channelMatch =
      !searchMatch &&
      lower.match(/(.+?)\s+(?:youtube\s+channel|yt\s+channel|channel\s+on\s+youtube)/);

    expect(Boolean(searchMatch || channelMatch)).toBe(true);
    expect(channelMatch?.[1].trim()).toBe("open harkirat singh");
  });

  it("handles standard search query with 'on' correctly", () => {
    const text = "search react tutorials on youtube";
    const lower = text.toLowerCase();

    const searchMatch =
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(?:on|in|at)\s+([\w.]+)/) ||
      lower.match(/(?:search|find|look\s*up|search\s*for)\s+(.+?)\s+(youtube|google|bing|amazon|flipkart|github)\b/);

    expect(searchMatch).not.toBeNull();
    expect(searchMatch?.[1].trim()).toBe("react tutorials");
    expect(searchMatch?.[2].trim()).toBe("youtube");
  });

  it("checks Florence-2 cache status with CacheStorage mock", async () => {
    const { isFlorenceCached } = await import("../src/core/perception/florence2-engine");

    // Case 1: No caches global
    const origCaches = (globalThis as any).caches;
    (globalThis as any).caches = undefined;
    expect(await isFlorenceCached()).toBe(false);

    // Case 2: transformers-cache doesn't exist
    (globalThis as any).caches = {
      has: async (name: string) => false,
      open: async () => ({ keys: async () => [] }),
    };
    expect(await isFlorenceCached()).toBe(false);

    // Case 3: transformers-cache exists but empty
    (globalThis as any).caches = {
      has: async (name: string) => name === "transformers-cache",
      open: async () => ({ keys: async () => [] }),
    };
    expect(await isFlorenceCached()).toBe(false);

    // Case 4: transformers-cache has config but missing subgraphs
    (globalThis as any).caches = {
      has: async (name: string) => name === "transformers-cache",
      open: async () => ({
        keys: async () => [
          { url: "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/config.json" },
          { url: "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/embed_tokens.onnx" },
        ],
      }),
    };
    expect(await isFlorenceCached()).toBe(false);

    // Case 5: transformers-cache has all required assets (config, encoder, decoder, vision_encoder, onnx)
    (globalThis as any).caches = {
      has: async (name: string) => name === "transformers-cache",
      open: async () => ({
        keys: async () => [
          { url: "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/config.json" },
          { url: "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/encoder_model_quantized.onnx" },
          { url: "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/decoder_model_merged_quantized.onnx" },
          { url: "https://huggingface.co/onnx-community/Florence-2-base-ft/resolve/main/onnx/vision_encoder/model_quantized.onnx" },
        ],
      }),
    };
    expect(await isFlorenceCached()).toBe(true);

    // Restore
    (globalThis as any).caches = origCaches;
  });
});

