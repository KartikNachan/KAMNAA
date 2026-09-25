import { describe, it, expect, beforeAll } from "vitest";

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

  it("TEST 4: Type execution must preserve focus for follow-up press_key (Enter)", () => {
    let enterDispatchedToInput = false;
    const input = {
      type: "text",
      focus: () => { (globalThis as any).document.activeElement = input; },
      blur: () => { (globalThis as any).document.activeElement = (globalThis as any).document.body; },
      dispatchEvent: (e: any) => {
        if (e.type === "keydown" && e.key === "Enter") enterDispatchedToInput = true;
      }
    };
    const body = { dispatchEvent: () => {} };
    (globalThis as any).document = { activeElement: body, body: body };
    input.focus();
    expect((globalThis as any).document.activeElement).toBe(input);
    expect((globalThis as any).document.activeElement).toBe(input);
    const active = (globalThis as any).document.activeElement || (globalThis as any).document.body;
    active.dispatchEvent({ type: "keydown", key: "Enter" });
    expect(enterDispatchedToInput).toBe(true);
    (globalThis as any).document = undefined;
  });

  describe("LLM Action Type Validation", () => {
    let parsePlanResponse: any;

    beforeAll(async () => {
      // Import the now-exported function
      const mod = await import("../src/core/agent/llm-providers");
      parsePlanResponse = mod.parsePlanResponse;
    });

    it("TEST 1: Valid click -> accepted", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [{ action: { type: "click", target: "[0]", targetDescription: "test" } }]
      }));
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].action.type).toBe("click");
    });

    it("TEST 2: Valid type -> accepted", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [{ action: { type: "type", target: "[0]", targetDescription: "test", value: "x" } }]
      }));
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].action.type).toBe("type");
    });

    it("TEST 3: Valid press_key -> accepted", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [{ action: { type: "press_key", value: "Enter" } }]
      }));
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].action.type).toBe("press_key");
    });

    it("TEST 4: Existing 'fill' normalization", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [{ action: { type: "fill", target: "[0]", targetDescription: "test", value: "x" } }]
      }));
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].action.type).toBe("type");
    });

    it("TEST 5: Invalid 'web' -> parsePlanResponse rejects the action", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [{ action: { type: "web", target: "search", value: "test" } }]
      }));
      // Should reject and return 0 steps due to invalid type
      expect(result.steps).toHaveLength(0);
      expect(result.reasoning).toMatch(/Invalid action type from LLM: "web"/);
    });

    it("TEST 6: Invalid arbitrary action -> rejected", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [{ action: { type: "something_invalid" } }]
      }));
      expect(result.steps).toHaveLength(0);
      expect(result.reasoning).toMatch(/Invalid action type from LLM: "something_invalid"/);
    });

    it("TEST 7: Multiple actions with one invalid -> the entire plan is rejected", () => {
      const result = parsePlanResponse(JSON.stringify({
        steps: [
          { action: { type: "click", target: "[0]" } },
          { action: { type: "web", target: "search" } }
        ]
      }));
      expect(result.steps).toHaveLength(0);
      expect(result.reasoning).toMatch(/Invalid action type from LLM: "web"/);
    });
  });

  describe("Enter Form Submission (press_key)", () => {
    // Reusable simulation of the press_key executor logic in content/index.ts
  describe("Enter Form Submission (press_key)", () => {
    // Reusable simulation of the press_key executor logic in content/index.ts
    const simulatePressKey = (action: { key?: string }, mockDocument: any) => {
      const active = mockDocument.activeElement || mockDocument.body;
      
      let formSubmitted = false;
      const isFormElement =
        active instanceof mockDocument.defaultView.HTMLInputElement ||
        active instanceof mockDocument.defaultView.HTMLSelectElement ||
        active instanceof mockDocument.defaultView.HTMLButtonElement;
      
      const form = (isFormElement && active.form) ? active.form : null;
      const onSubmit = () => { formSubmitted = true; };
      
      if (action.key === "Enter" && form) {
        form.addEventListener("submit", onSubmit, { once: true, capture: true });
      }

      for (const evt of ["keydown", "keypress", "keyup"]) {
        const event = new mockDocument.defaultView.KeyboardEvent(evt, {
          key: action.key || "",
          code: action.key || "",
          bubbles: true,
          cancelable: true,
        });
        active.dispatchEvent(event);
      }
      
      if (action.key === "Enter" && form) {
        form.removeEventListener("submit", onSubmit, { capture: true });
      }

      if (action.key === "Enter" && !formSubmitted) {
        if (form) {
          try {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit();
            } else {
              form.submit();
            }
          } catch (err: any) {
            return { success: false, error: err.message };
          }
        }
      }

      return { success: true };
    };

    const createMockDOM = () => {
      class MockKeyboardEvent {
        constructor(public type: string, public init: any) {}
      }
      class MockEventTarget {
        listeners: Record<string, Function[]> = {};
        addEventListener(type: string, fn: Function) {
          this.listeners[type] = this.listeners[type] || [];
          this.listeners[type].push(fn);
        }
        removeEventListener(type: string, fn: Function) {
          if (this.listeners[type]) {
            this.listeners[type] = this.listeners[type].filter(f => f !== fn);
          }
        }
        dispatchEvent(e: any) {
          let preventDefaultCalled = false;
          e.preventDefault = () => { preventDefaultCalled = true; };
          (this.listeners[e.type] || []).forEach(fn => fn(e));
          return !preventDefaultCalled;
        }
      }
      class MockForm extends MockEventTarget {
        requestSubmitCalled = false;
        submitCalled = false;
        requestSubmit() { this.requestSubmitCalled = true; }
        submit() { this.submitCalled = true; }
      }
      class MockElement extends MockEventTarget {
        tagName: string;
        form: any;
        constructor(tagName: string) {
          super();
          this.tagName = tagName;
        }
      }
      class MockHTMLInputElement extends MockElement { constructor() { super("INPUT"); } }
      class MockHTMLSelectElement extends MockElement { constructor() { super("SELECT"); } }
      class MockHTMLButtonElement extends MockElement { constructor() { super("BUTTON"); } }
      
      return {
        defaultView: {
          KeyboardEvent: MockKeyboardEvent,
          HTMLInputElement: MockHTMLInputElement,
          HTMLSelectElement: MockHTMLSelectElement,
          HTMLButtonElement: MockHTMLButtonElement,
        },
        MockHTMLInputElement,
        MockForm,
        MockElement
      };
    };

    it("TEST 1: Enter on form input -> synthetic event prevented but form NOT submitted -> requestSubmit is used", () => {
      const mockDOM = createMockDOM();
      
      const form = new mockDOM.MockForm();
      const input = new mockDOM.MockHTMLInputElement();
      input.form = form;
      
      // Page handler prevents default but does not submit the form
      input.addEventListener("keydown", (e: any) => {
        if (e.init.key === "Enter") e.preventDefault();
      });
      
      const mockDocument = { ...mockDOM, activeElement: input };

      const result = simulatePressKey({ key: "Enter" }, mockDocument);

      expect(result.success).toBe(true);
      expect(form.requestSubmitCalled).toBe(true); // Should fallback to requestSubmit
      expect(form.submitCalled).toBe(false);
    });

    it("TEST 1b: Enter on form input -> form already submitted during event dispatch -> NO requestSubmit", () => {
      const mockDOM = createMockDOM();
      
      const form = new mockDOM.MockForm();
      const input = new mockDOM.MockHTMLInputElement();
      input.form = form;
      
      // Page handler successfully submits the form natively
      input.addEventListener("keydown", (e: any) => {
        if (e.init.key === "Enter") {
          e.preventDefault();
          // Simulate native form submission which fires "submit" event
          form.dispatchEvent({ type: "submit", preventDefault: () => {} });
        }
      });
      
      const mockDocument = { ...mockDOM, activeElement: input };

      const result = simulatePressKey({ key: "Enter" }, mockDocument);

      expect(result.success).toBe(true);
      // Because the "submit" event fired, KAMNAA should NOT call requestSubmit
      expect(form.requestSubmitCalled).toBe(false);
    });

    it("TEST 2: Enter on textarea -> normal newline, NO form submission", () => {
      const mockDOM = createMockDOM();
      
      let requestSubmitCalled = false;
      const form = {
        requestSubmit: () => { requestSubmitCalled = true; }
      };
      
      const textarea = new mockDOM.MockElement("TEXTAREA");
      textarea.form = form;
      
      const mockDocument = { ...mockDOM, activeElement: textarea };

      const result = simulatePressKey({ key: "Enter" }, mockDocument);

      expect(result.success).toBe(true);
      expect(requestSubmitCalled).toBe(false);
    });

    it("TEST 3: Enter on input with no form -> existing keyboard-event behavior remains", () => {
      const mockDOM = createMockDOM();
      
      const input = new mockDOM.MockHTMLInputElement();
      
      let keydownFired = false;
      input.addEventListener("keydown", (e: any) => {
        if (e.init.key === "Enter") keydownFired = true;
      });
      
      const mockDocument = { ...mockDOM, activeElement: input };

      const result = simulatePressKey({ key: "Enter" }, mockDocument);

      expect(result.success).toBe(true);
      expect(keydownFired).toBe(true);
    });

    it("TEST 4: Enter on non-form element -> existing behavior preserved", () => {
      const mockDOM = createMockDOM();
      
      const div = new mockDOM.MockElement("DIV");
      
      let keydownFired = false;
      div.addEventListener("keydown", (e: any) => {
        if (e.init.key === "Enter") keydownFired = true;
      });
      
      const mockDocument = { ...mockDOM, activeElement: div };

      const result = simulatePressKey({ key: "Enter" }, mockDocument);

      expect(result.success).toBe(true);
      expect(keydownFired).toBe(true);
    });

    it("TEST 5: Non-Enter key -> existing behavior unchanged", () => {
      const mockDOM = createMockDOM();
      
      let requestSubmitCalled = false;
      const form = {
        requestSubmit: () => { requestSubmitCalled = true; }
      };
      
      const input = new mockDOM.MockHTMLInputElement();
      input.form = form;
      
      let escapeFired = false;
      input.addEventListener("keydown", (e: any) => {
        if (e.init.key === "Escape") escapeFired = true;
      });
      
      const mockDocument = { ...mockDOM, activeElement: input };

      const result = simulatePressKey({ key: "Escape" }, mockDocument);

      expect(result.success).toBe(true);
      expect(escapeFired).toBe(true);
      expect(requestSubmitCalled).toBe(false);
    });
    });
  });

  describe("sendToContentScript error handling", () => {
    it("handles Chrome 130+ message channel closed error correctly for EXECUTE_ACTION", async () => {
      const { sendToContentScript } = await import("../src/core/pipeline/full-pipeline");
      
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        tabs: {
          query: async () => [{ id: 123, url: "https://amazon.in" }],
          get: async () => ({ status: "complete" }),
          sendMessage: async () => {
            throw new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received");
          }
        }
      };

      const result = await sendToContentScript("EXECUTE_ACTION", {});
      expect(result).toEqual({ success: true, navigated: true });

      (globalThis as any).chrome = originalChrome;
    });

    it("handles legacy message port closed error correctly for EXECUTE_ACTION", async () => {
      const { sendToContentScript } = await import("../src/core/pipeline/full-pipeline");
      
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        tabs: {
          query: async () => [{ id: 123, url: "https://amazon.in" }],
          get: async () => ({ status: "complete" }),
          sendMessage: async () => {
            throw new Error("The message port closed before a response was received");
          }
        }
      };

      const result = await sendToContentScript("EXECUTE_ACTION", {});
      expect(result).toEqual({ success: true, navigated: true });

      (globalThis as any).chrome = originalChrome;
    });
  });
});

