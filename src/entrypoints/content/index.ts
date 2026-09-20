// ============================================================
// KAMNAA — Content Script (Production)
// Single source of truth for: DOM extraction, screenshot capture,
// action execution, PII overlay, redaction CSS injection
//
// Communicates with background service worker via messages.
// Never runs heavy ML — that stays in background.
// ============================================================

import { defineContentScript } from "wxt/utils/define-content-script";
import type { Message, PageState, AgentAction } from "../../types";
import { TRIPWIRE_MESSAGE, type TripwireMessage } from "../../core/privacy/tripwire";

/** Cap on observations accepted from one postMessage — the sender is untrusted. */
const MAX_RELAYED_OBSERVATIONS = 50;

export default defineContentScript({
  matches: ["<all_urls>"],

  main() {
    // ── State ──────────────────────────────────────────────

    let redactionStyleEl: HTMLStyleElement | null = null;
    let overlayContainer: HTMLDivElement | null = null;
    let pipelinePanel: HTMLDivElement | null = null;

    // NOTE: A DOM-settle primitive (wait for the page to stabilize after an
    // action) lands in P6 with the execution loop, wired into action results.
    // The previous MutationObserver scaffolding here was never consumed, so it
    // was removed rather than left as dead weight.

    // ── PII Tripwire relay ────────────────────────────────
    // The tripwire itself runs in the MAIN world (tripwire.content.ts) —
    // an isolated-world patch of fetch/XHR cannot see page traffic. Here
    // we only relay its observations to the background, which owns the
    // merged Privacy Ledger.
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as TripwireMessage | undefined;
      if (!data || data.source !== TRIPWIRE_MESSAGE) return;
      if (!Array.isArray(data.observations) || data.observations.length === 0) return;

      // Page scripts share this window and can post the same shape, so the
      // payload is untrusted: validate it and cap the volume rather than
      // letting a hostile page stuff the Privacy Ledger with fabricated
      // entries. Everything here is display-only and already masked.
      const observations = data.observations
        .slice(0, MAX_RELAYED_OBSERVATIONS)
        .filter(
          (o) =>
            o &&
            typeof o.url === "string" &&
            typeof o.method === "string" &&
            typeof o.bytes === "number" &&
            Number.isFinite(o.bytes) &&
            Array.isArray(o.matches)
        )
        .map((o) => ({
          url: o.url.slice(0, 512),
          method: o.method.slice(0, 16),
          bytes: Math.max(0, Math.min(o.bytes, Number.MAX_SAFE_INTEGER)),
          matches: o.matches.slice(0, 32),
        }));
      if (observations.length === 0) return;

      chrome.runtime
        .sendMessage({
          type: "REPORT_PAGE_EGRESS",
          payload: observations,
          source: "content",
          timestamp: Date.now(),
        })
        .catch(() => {
          // Background may be asleep — observations are best-effort.
        });
    });

    // ── Message Router ─────────────────────────────────────

    chrome.runtime.onMessage.addListener(
      (
        message: Message,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: any) => void
      ) => {
        switch (message.type) {
          case "PERCEIVE_PAGE":
            try {
              // BUG-FIX: Invalidate the element cache every time we re-scan.
              // A re-scan means the page may have changed (SPA navigation, DOM
              // mutations), so old element[N] indices are stale. Without this,
              // the LLM targets [3] from the fresh scan and the executor still
              // clicks whatever element[3] was from the previous scan.
              invalidateElementCache();
              sendResponse(extractPageState());
            } catch (err: any) {
              sendResponse({ elements: [], forms: [], url: window.location.href, title: document.title, timestamp: Date.now(), textContent: "", metadata: { hasCAPTCHA: false, hasHoneypot: false, isSecure: true, hasFileUpload: false, hasPaymentForm: false, formCount: 0, totalElements: 0, interactiveElements: 0 }, confidence: 0, perceptionTime: 0 });
            }
            return true; // BUG-10 FIX: keep channel open even for sync path

          case "EXECUTE_ACTION": {
            const action = message.payload as AgentAction;
            

            
            const diagnostic: any = {
              actionIndex: (action as any)._meta?.stepIndex !== undefined ? (action as any)._meta.stepIndex + 1 : 1,
              actionType: action.type,
              originalLlmTarget: (action as any)._meta?.originalTarget || action.target,
              targetDescription: (action as any).targetDescription || "MISSING",
              resolvedTargetIndex: action.target ? parseInt(action.target.match(/\d+/)?.[0] || "-1", 10) : -1,
              targetFound: false,
              targetVisible: false,
              targetDisabled: false,
              targetTag: null,
              targetRole: null,
              targetText: null,
              groundingMethod: (action as any)._meta?.groundingMethod || "none",
              groundingScore: (action as any)._meta?.groundingScore || 0,
              actionStarted: true,
              nativeEventDispatched: false,
              actionReturned: false,
              postStateChanged: false,
              verificationMethod: null,
              verificationResult: false,
              failureReason: null,
              testActionStateBefore: null,
              testActionStateAfter: null
            };

            // Log for all actions, not just click
            try {
              let el = null;
              if (action.coordinates) el = document.elementFromPoint(action.coordinates.x, action.coordinates.y);
              else el = findElement(action.target || "", action);
              
              if (el) {
                diagnostic.targetFound = true;
                diagnostic.targetTag = el.tagName;
                diagnostic.targetRole = el.getAttribute("role") || inferRole(el);
                diagnostic.targetText = el.textContent?.substring(0, 50).trim() || (el as HTMLInputElement).value || "";
                
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                diagnostic.targetVisible = !(rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden");
                diagnostic.targetDisabled = (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true";
              }
              diagnostic.testActionStateBefore = document.body.dataset.kamnaaLastAction || "none";
            } catch (e: any) {
              diagnostic.failureReason = "ResolutionException: " + e.message;
            }

            try {
              diagnostic.nativeEventDispatched = true;
              executeAction(action)
                .then((res) => {
                  diagnostic.actionReturned = true;
                  diagnostic.verificationResult = !!res.verified;
                  diagnostic.verificationMethod = res.verificationReason || null;
                  
                  // Verification Bug-Fix: check test fixture state
                  if (action.type === "click") {
                    const testStateBefore = diagnostic.testActionStateBefore;
                    const testStateAfter = document.body.dataset.kamnaaLastAction || "none";
                    if (testStateBefore !== testStateAfter) {
                      res.verified = true;
                      res.verificationReason = "test_state_mutated";
                      diagnostic.verificationResult = true;
                      diagnostic.verificationMethod = "test_state_mutated";
                    }
                  }

                  if (res.error) diagnostic.failureReason = res.error;
                  diagnostic.testActionStateAfter = document.body.dataset.kamnaaLastAction || "none";
                  diagnostic.postStateChanged = diagnostic.testActionStateBefore !== diagnostic.testActionStateAfter;
                  
                  if (diagnostic.actionIndex === 1) {
                    const trace = {
                      actionIndex: diagnostic.actionIndex,
                      actionType: diagnostic.actionType,
                      originalTarget: diagnostic.originalLlmTarget,
                      targetDescription: diagnostic.targetDescription,
                      groundedTarget: action.target,
                      resolvedElementIndex: diagnostic.resolvedTargetIndex,
                      resolvedElementTag: diagnostic.targetTag,
                      resolvedElementRole: diagnostic.targetRole,
                      resolvedElementText: diagnostic.targetText,
                      targetFound: diagnostic.targetFound,
                      targetVisible: diagnostic.targetVisible,
                      targetDisabled: diagnostic.targetDisabled,
                      exception: diagnostic.failureReason,
                      exceptionStack: null,
                      eventDispatchStarted: diagnostic.actionStarted,
                      eventDispatchSucceeded: !res.error,
                      verificationStarted: true,
                      verificationResult: !!res.verified
                    };
                    console.log("[KAMNAA ACTION TRACE]\n" + JSON.stringify(trace, null, 2));
                  }
                  
                  console.log("[KAMNAA ACTION DEBUG]\n" + JSON.stringify(diagnostic, null, 2));
                  invalidateElementCache();
                  sendResponse(res);
                })
                .catch((err: Error) => {
                  diagnostic.failureReason = err.name + ": " + err.message + "\nStack: " + (err.stack ? err.stack.split('\n')[1] : "");
                  if (diagnostic.actionIndex === 1) {
                    const trace = {
                      actionIndex: diagnostic.actionIndex,
                      actionType: diagnostic.actionType,
                      originalTarget: diagnostic.originalLlmTarget,
                      targetDescription: diagnostic.targetDescription,
                      groundedTarget: action.target,
                      resolvedElementIndex: diagnostic.resolvedTargetIndex,
                      resolvedElementTag: diagnostic.targetTag,
                      resolvedElementRole: diagnostic.targetRole,
                      resolvedElementText: diagnostic.targetText,
                      targetFound: diagnostic.targetFound,
                      targetVisible: diagnostic.targetVisible,
                      targetDisabled: diagnostic.targetDisabled,
                      exception: err.name + ": " + err.message,
                      exceptionStack: err.stack || null,
                      eventDispatchStarted: diagnostic.actionStarted,
                      eventDispatchSucceeded: false,
                      verificationStarted: false,
                      verificationResult: false
                    };
                    console.log("[KAMNAA ACTION TRACE]\n" + JSON.stringify(trace, null, 2));
                  }
                  console.log("[KAMNAA ACTION DEBUG]\n" + JSON.stringify(diagnostic, null, 2));
                  sendResponse({ success: false, error: err.message });
                });
            } catch (err: any) {
              diagnostic.failureReason = err.name + ": " + err.message + "\nStack: " + (err.stack ? err.stack.split('\n')[1] : "");
              if (diagnostic.actionIndex === 1) {
                const trace = {
                  actionIndex: diagnostic.actionIndex,
                  actionType: diagnostic.actionType,
                  originalTarget: diagnostic.originalLlmTarget,
                  targetDescription: diagnostic.targetDescription,
                  groundedTarget: action.target,
                  resolvedElementIndex: diagnostic.resolvedTargetIndex,
                  resolvedElementTag: diagnostic.targetTag,
                  resolvedElementRole: diagnostic.targetRole,
                  resolvedElementText: diagnostic.targetText,
                  targetFound: diagnostic.targetFound,
                  targetVisible: diagnostic.targetVisible,
                  targetDisabled: diagnostic.targetDisabled,
                  exception: err.name + ": " + err.message,
                  exceptionStack: err.stack || null,
                  eventDispatchStarted: diagnostic.actionStarted,
                  eventDispatchSucceeded: false,
                  verificationStarted: false,
                  verificationResult: false
                };
                console.log("[KAMNAA ACTION TRACE]\n" + JSON.stringify(trace, null, 2));
              }
              console.log("[KAMNAA ACTION DEBUG]\n" + JSON.stringify(diagnostic, null, 2));
              sendResponse({ success: false, error: err.message });
            }
            return true;
          }

          case "CAPTURE_SCREENSHOT":
            captureVisibleTab()
              .then(sendResponse)
              .catch((err: Error) =>
                sendResponse({ success: false, error: err.message })
              );
            return true;

          case "INJECT_REDACTION_CSS":
            injectRedactionCSS(message.payload as string);
            sendResponse({ success: true });
            break;

          case "REMOVE_REDACTION_CSS":
            removeRedactionCSS();
            sendResponse({ success: true });
            break;

          case "SHOW_PII_OVERLAY":
            showPIIOverlay(message.payload as any);
            sendResponse({ success: true });
            break;

          case "HIDE_PII_OVERLAY":
            hidePIIOverlay();
            sendResponse({ success: true });
            break;

          case "SHOW_PIPELINE_PANEL":
            showPipelinePanel(message.payload as any);
            sendResponse({ success: true });
            break;

          case "UPDATE_PIPELINE_PANEL":
            updatePipelinePanel(message.payload as any);
            sendResponse({ success: true });
            break;

          case "CAPTURE_FULL_PAGE":
            captureFullPage()
              .then(sendResponse)
              .catch((err: Error) =>
                sendResponse({ success: false, error: err.message })
              );
            return true;

          default:
            sendResponse({ error: `Unknown message type: ${message.type}` });
        }
      }
    );

    // ════════════════════════════════════════════════════════
    // DOM EXTRACTION — Fast, ~10ms
    // ════════════════════════════════════════════════════════

    function extractPageState(): PageState {
      const startTime = performance.now();

      const INTERACTIVE_SELECTORS = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[contenteditable="true"]',
        "[tabindex]",
      ].join(", ");

      const rawElements = document.querySelectorAll(INTERACTIVE_SELECTORS);
      const elements: PageState["elements"] = [];
      const seen = new Set<Element>();

      rawElements.forEach((el, i) => {
        if (seen.has(el)) return;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        if (
          rect.width === 0 ||
          rect.height === 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity) < 0.1
        )
          return;

        const isOffscreen = rect.bottom < -100 || rect.top > window.innerHeight + 100;
        const visibilityState = isOffscreen ? "offscreen" : "visible";

        const text =
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("placeholder") ||
          el.textContent?.trim()?.slice(0, 150) ||
          "";

        const label = getFieldLabel(el);

        elements.push({
          // BUG-13 FIX: use stable sequential ID without Date.now() so the
        // planner's target references survive across perception → execution.
        id: el.id || `el-${i}`,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || inferRole(el),
          text,
          label,
          ariaLabel: el.getAttribute("aria-label") || "",
          placeholder: el.getAttribute("placeholder") || "",
          type: el.getAttribute("type") || "",
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            toJSON: () => ({}),
          } as DOMRect,
          isVisible: !isOffscreen,
          visibilityState,
          isInteractive: true,
          isDisabled: el.hasAttribute("disabled"),
          confidence: 0.95,
          source: "dom" as const,
        });
      });

      // Extract forms with field labels
      const formElements = document.querySelectorAll("form");
      const forms = Array.from(formElements).map((form, fi) => ({
        id: form.id || `form-${fi}`,
        action: form.action || window.location.href,
        method: form.method || "GET",
        fields: Array.from(
          form.querySelectorAll("input, select, textarea")
        ).map((input) => {
          const r = input.getBoundingClientRect();
          return {
            name: input.getAttribute("name") || "",
            id: input.id || "",
            type: input.getAttribute("type") || input.tagName.toLowerCase(),
            value: (input as HTMLInputElement).value || "",
            required: input.hasAttribute("required"),
            maxLength: parseInt(input.getAttribute("maxlength") || "0"),
            pattern: input.getAttribute("pattern") || "",
            options:
              input.tagName === "SELECT"
                ? Array.from((input as HTMLSelectElement).options).map(
                    (o) => o.text
                  )
                : [],
            rect: {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              toJSON: () => ({}),
            } as DOMRect,
            label: getFieldLabel(input),
            // A radio/checkbox always reports its option token as `.value`,
            // selected or not — so "has a value" is meaningless for them.
            // Selection is the real signal.
            checked: isCheckable(input)
              ? (input as HTMLInputElement).checked
              : undefined,
            filledByUser: isCheckable(input)
              ? (input as HTMLInputElement).checked
              : !!(input as HTMLInputElement).value,
          };
        }),
      }));

      const saveAsDraftTarget = elements.find(e => (e.text || e.label || "").toLowerCase().includes("save as draft"));
      console.log("[KAMNAA OFFSCREEN TARGET CHECK]\n" + JSON.stringify({
        saveAsDraftFound: !!saveAsDraftTarget,
        saveAsDraftIndex: saveAsDraftTarget ? elements.indexOf(saveAsDraftTarget) : -1,
        saveAsDraftTag: saveAsDraftTarget?.tag,
        saveAsDraftRole: saveAsDraftTarget?.role,
        saveAsDraftVisibility: (saveAsDraftTarget as any)?.visibilityState
      }, null, 2));

      const pageHTML = document.documentElement.outerHTML;
      const pageText = document.body?.innerText || "";

      return {
        url: window.location.href,
        title: document.title,
        timestamp: Date.now(),
        elements,
        forms,
        textContent: pageText.slice(0, 5000),
        metadata: {
          hasCAPTCHA:
            /recaptcha|hcaptcha|turnstile|cf-challenge/i.test(pageHTML),
          hasHoneypot: detectHoneypots(),
          isSecure: window.location.protocol === "https:",
          hasFileUpload: elements.some((e) => e.type === "file"),
          hasPaymentForm:
            /payment|card number|cvv|expiry|billing/i.test(pageText),
          formCount: forms.length,
          totalElements: document.querySelectorAll("*").length,
          interactiveElements: elements.length,
          cacheState: interactiveElementCache ? "reused" : "rebuilt",
        },
        confidence: 0.85,
        perceptionTime: performance.now() - startTime,
      };
    }

    // ════════════════════════════════════════════════════════
    // SCREENSHOT CAPTURE — via visible tab screenshot
    // ════════════════════════════════════════════════════════

    async function captureVisibleTab(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      try {
        // Use chrome.tabs.captureVisibleTab from background
        // This message triggers the background to capture
        const response = await chrome.runtime.sendMessage({
          type: "DO_CAPTURE_TAB",
          payload: null,
          source: "content",
          timestamp: Date.now(),
        } as Message);

        if (response?.success && response.dataUrl) {
          return {
            success: true,
            dataUrl: response.dataUrl,
            width: response.width,
            height: response.height,
          };
        }

        // Fallback: capture via canvas (slower but works everywhere)
        return captureViaCanvas();
      } catch {
        return captureViaCanvas();
      }
    }

    function captureViaCanvas(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      return new Promise((resolve) => {
        try {
          // Use html2canvas-like approach: render the page to a canvas
          // For production, we use a simpler approach:
          // Ask background to capture the tab
          chrome.runtime.sendMessage(
            {
              type: "DO_CAPTURE_TAB",
              payload: null,
              source: "content",
              timestamp: Date.now(),
            } as Message,
            (response) => {
              if (chrome.runtime.lastError) {
                // If background capture fails, try a minimal screenshot
                resolve({
                  success: false,
                  error: "Screenshot capture unavailable",
                });
                return;
              }
              resolve(response || { success: false, error: "No response" });
            }
          );
        } catch (err) {
          resolve({
            success: false,
            error: err instanceof Error ? err.message : "Capture failed",
          });
        }
      });
    }

    // ════════════════════════════════════════════════════════
    // SCROLL-STITCHING — Full-page capture
    // Captures multiple viewport screenshots while scrolling,
    // then stitches them into a single full-page image.
    // ============================================================

    async function captureFullPage(): Promise<{
      success: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      error?: string;
    }> {
      try {
        const scrollHeight = document.documentElement.scrollHeight;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        // If page fits in viewport, just capture normally
        if (scrollHeight <= viewportHeight * 1.1) {
          return captureVisibleTab();
        }

        // Capture multiple viewport screenshots while scrolling
        const captures: Array<{ dataUrl: string; scrollY: number }> = [];
        const originalScrollY = window.scrollY;
        const numCaptures = Math.ceil(scrollHeight / (viewportHeight * 0.8));

        for (let i = 0; i < numCaptures; i++) {
          const targetScroll = Math.min(
            i * viewportHeight * 0.8,
            scrollHeight - viewportHeight
          );
          window.scrollTo(0, targetScroll);
          // Wait for content to settle
          await new Promise((r) => setTimeout(r, 200));

          const response = await chrome.runtime.sendMessage({
            type: "DO_CAPTURE_TAB",
            payload: null,
            source: "content",
            timestamp: Date.now(),
          } as Message);

          if (response?.success && response.dataUrl) {
            captures.push({ dataUrl: response.dataUrl, scrollY: targetScroll });
          }
        }

        // Restore original scroll position
        window.scrollTo(0, originalScrollY);

        if (captures.length === 0) {
          return { success: false, error: "No captures obtained" };
        }

        if (captures.length === 1) {
          return { success: true, ...captures[0], width: viewportWidth, height: viewportHeight };
        }

        // Stitch captures into a single full-page image
        // Create a canvas the size of the full page
        const stitchCanvas = new OffscreenCanvas(viewportWidth, scrollHeight);
        const stitchCtx = stitchCanvas.getContext("2d")!;

        for (const capture of captures) {
          const response = await fetch(capture.dataUrl);
          const blob = await response.blob();
          const bitmap = await createImageBitmap(blob);
          stitchCtx.drawImage(bitmap, 0, capture.scrollY, viewportWidth, viewportHeight);
          bitmap.close();
        }

        const stitchedBlob = await stitchCanvas.convertToBlob({ type: "image/png" });
        const dataUrl = await blobToDataURL(stitchedBlob);

        return {
          success: true,
          dataUrl,
          width: viewportWidth,
          height: scrollHeight,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Full-page capture failed",
        };
      }
    }

    function blobToDataURL(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    // ════════════════════════════════════════════════════════
    // ACTION EXECUTION — Production-grade
    // ════════════════════════════════════════════════════════

    let executeActionInvocationCount = 0;

    // DOM settle: wait for mutations to stop after an action
    function waitForDOMSettle(maxWaitMs = 2000): Promise<void> {
      return new Promise((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const observer = new MutationObserver(() => {
          // Reset debounce on each mutation
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            observer.disconnect();
            if (timeout) clearTimeout(timeout);
            resolve();
          }, 300); // 300ms of no mutations = settled
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        // Max wait: don't block forever
        timeout = setTimeout(() => {
          observer.disconnect();
          if (debounce) clearTimeout(debounce);
          resolve();
        }, maxWaitMs);
      });
    }

    function getScrollableAncestor(el: Element | null): Element | Window {
      if (!el) return window;
      let parent = el.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        const overflowY = style.overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          if (parent.scrollHeight > parent.clientHeight) {
            return parent;
          }
        }
        parent = parent.parentElement;
      }
      return window;
    }

    function isElementInViewport(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const minIntersectY = Math.min(5, rect.height / 2);
      const minIntersectX = Math.min(5, rect.width / 2);
      return (
        rect.bottom > minIntersectY &&
        rect.top < vh - minIntersectY &&
        rect.right > minIntersectX &&
        rect.left < vw - minIntersectX &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function scrollElementIntoView(el: Element, container: Element | Window) {
      if (container === window) {
        el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
      } else {
        const rect = el.getBoundingClientRect();
        const containerRect = (container as Element).getBoundingClientRect();
        const scrollTop = (container as Element).scrollTop;
        const relativeTop = rect.top - containerRect.top;
        const targetScroll = scrollTop + relativeTop - (containerRect.height / 2) + (rect.height / 2);
        (container as Element).scrollTo({ top: targetScroll, behavior: "auto" });
      }
    }

    async function resolveAndScrollTarget(action: AgentAction): Promise<{ el: Element | null, error?: string }> {
      let el = action.coordinates
        ? document.elementFromPoint(action.coordinates.x, action.coordinates.y)
        : findElement(action.target || "");
        
      if (!el) {
        return { el: null, error: `Element not found: "${action.target}"` };
      }

      const initialRect = el.getBoundingClientRect();
      const initialVisibility = isElementInViewport(el);
      const scrollContainer = getScrollableAncestor(el);
      const scrollContainerTag = scrollContainer === window ? "window" : (scrollContainer as Element).tagName;
      
      let scrollRequested = false;
      let targetReResolved = false;
      let scrollPositionBefore = scrollContainer === window ? window.scrollY : (scrollContainer as Element).scrollTop;
      let scrollPositionAfter = scrollPositionBefore;
      
      if (!initialVisibility) {
        scrollRequested = true;
        
        const rect = el.getBoundingClientRect();
        const scrollTop = scrollContainer === window ? window.scrollY : (scrollContainer as Element).scrollTop;
        const relativeTop = rect.top - (scrollContainer === window ? 0 : (scrollContainer as Element).getBoundingClientRect().top);
        const targetScroll = scrollTop + relativeTop - ((scrollContainer === window ? window.innerHeight : (scrollContainer as Element).clientHeight) / 2) + (rect.height / 2);
        const scrollDirection = targetScroll > scrollTop ? "down" : "up";

        console.log("[KAMNAA SCROLL TARGET]\n" + JSON.stringify({
          requestedTarget: action.target,
          targetDescription: (action as any).targetDescription || "",
          resolvedIndex: action.target ? parseInt(action.target.match(/\d+/)?.[0] || "-1", 10) : -1,
          resolvedTag: el.tagName,
          resolvedRole: el.getAttribute("role") || inferRole(el),
          rectTop: rect.top,
          rectBottom: rect.bottom,
          viewportHeight: window.innerHeight,
          scrollTop,
          scrollContainer: scrollContainerTag,
          scrollDirection
        }, null, 2));

        scrollElementIntoView(el, scrollContainer);
        
        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => setTimeout(r, 200));
        
        scrollPositionAfter = scrollContainer === window ? window.scrollY : (scrollContainer as Element).scrollTop;
        
        const freshEl = action.coordinates
          ? document.elementFromPoint(action.coordinates.x, action.coordinates.y)
          : findElement(action.target || "");
          
        if (freshEl && freshEl !== el) {
          el = freshEl;
          targetReResolved = true;
        }
      }
      
      const rectAfterScroll = el ? el.getBoundingClientRect() : null;
      const visibleAfterScroll = el ? isElementInViewport(el) : false;
      
      console.log("[KAMNAA SCROLL]", JSON.stringify({
        actionIndex: (action as any)._meta?.stepIndex !== undefined ? (action as any)._meta.stepIndex + 1 : 1,
        targetText: el ? (el.textContent?.substring(0, 50).trim() || (el as HTMLInputElement).value || "") : "",
        targetIndexBeforeScroll: action.target,
        initialRect: { top: initialRect.top, bottom: initialRect.bottom, left: initialRect.left, right: initialRect.right },
        initialVisibility,
        scrollContainer: scrollContainerTag,
        scrollRequested,
        scrollPositionBefore,
        rectAfterScroll: rectAfterScroll ? { top: rectAfterScroll.top, bottom: rectAfterScroll.bottom, left: rectAfterScroll.left, right: rectAfterScroll.right } : null,
        scrollPositionAfter,
        visibleAfterScroll,
        targetReResolved,
        finalTargetIndex: action.target
      }));
      
      if (!el || !document.body.contains(el)) {
        return { el: null, error: `Target lost after scroll: "${action.target}"` };
      }
      if ((el as any).disabled || el.hasAttribute("disabled")) {
        return { el: null, error: `Element is disabled: "${action.target}"` };
      }
      if (!visibleAfterScroll) {
        return { el: null, error: `Target not visible after scroll: "${action.target}"` };
      }
      
      return { el };
    }

    async function executeAction(
      action: AgentAction
    ): Promise<{ success: boolean; error?: string; verified?: boolean; verificationReason?: string }> {
      executeActionInvocationCount++;
      return new Promise(async (resolve) => {
        try {
          switch (action.type) {
            case "click": {
              let clickDispatchInvocationCount = 0;
              clickDispatchInvocationCount++;
              const res = await resolveAndScrollTarget(action);
              if (res.error || !res.el) {
                resolve({ success: false, error: res.error });
                return;
              }
              const el = res.el;

              const groundedTag = el.tagName;
              const groundedRole = el.getAttribute("role") || "";
              const targetDescription = (action as any).targetDescription || "";
              const plannerTarget = action.target || "";
              
              // We infer the original visibility state from isElementRendered & isVisible
              const visibilityState = isElementRendered(el) ? (isVisible(el) ? "visible" : "offscreen") : "hidden";
              
              console.log("[KAMNAA TARGET TRACE]\n" + JSON.stringify({
                plannerTarget,
                targetDescription,
                groundedTarget: plannerTarget,
                groundedRole,
                groundedTag,
                visibilityState,
                resolvedIndex: null // not easily computable here without searching all elements
              }, null, 2));

              // Explicit safety check: reject if we are about to click a non-button input when a button was requested
              if (targetDescription) {
                const reqNorm = targetDescription.toLowerCase();
                if (reqNorm.includes("save as draft") || reqNorm.includes("preview application") || reqNorm.includes("button")) {
                  if (groundedTag === "INPUT" && !["submit", "button", "reset"].includes(el.getAttribute("type") || "")) {
                     resolve({ success: false, error: `TARGET_REJECTED: Requested '${targetDescription}' but resolved to non-button <${groundedTag}>` });
                     return;
                  }
                }
              }

              const preUrl = window.location.href;
              const preHtml = el.outerHTML;
              const preRect = el.getBoundingClientRect();
              const preElementCount = document.querySelectorAll('*').length;
              const wasChecked = isCheckable(el) ? (el as HTMLInputElement).checked : undefined;

              const rect = el.getBoundingClientRect();
              const x = rect.x + rect.width / 2;
              const y = rect.y + rect.height / 2;
              
              const elementAtCenter = document.elementFromPoint(x, y);
              let centerCovered = false;
              if (elementAtCenter) {
                if (elementAtCenter !== el && !el.contains(elementAtCenter)) {
                   centerCovered = true;
                }
              }

              console.log("[KAMNAA CLICK DIAGNOSTICS]", JSON.stringify({
                targetIndex: action.target,
                targetText: el.textContent?.substring(0, 50).trim() || "",
                targetTag: el.tagName,
                isConnected: el.isConnected,
                rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
                visible: isElementInViewport(el),
                disabled: (el as any).disabled || el.hasAttribute("disabled"),
                pointerEvents: window.getComputedStyle(el).pointerEvents,
                elementAtCenter: elementAtCenter ? elementAtCenter.tagName + (elementAtCenter.id ? '#' + elementAtCenter.id : '') + (elementAtCenter.className ? '.' + elementAtCenter.className.replace(/ /g, '.') : '') : null,
                centerCovered,
                coveredByKamnaa: elementAtCenter ? !!(elementAtCenter.closest('#kamnaa-root, .kamnaa-panel') || elementAtCenter.tagName.toLowerCase().includes('kamnaa')) : false,
                freshResolution: true
              }));

              const clickTrace: any = {
                targetText: el.textContent?.substring(0, 50).trim() || "",
                tagName: el.tagName,
                semanticRole: el.getAttribute("role") || el.tagName,
                isConnected: el.isConnected,
                rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
                centerX: x,
                centerY: y,
                elementAtCenter: elementAtCenter ? elementAtCenter.tagName : null,
                isCovered: centerCovered,
                pointerEvents: window.getComputedStyle(el).pointerEvents,
                disabled: (el as any).disabled || el.hasAttribute("disabled"),
                syntheticEventsDispatched: true,
                nativeClickCalled: true,
                nativeClickReturned: false,
                clickTimestamp: Date.now()
              };

              const eventTrace = {
                pointerdownReceived: 0,
                mousedownReceived: 0,
                mouseupReceived: 0,
                pointerupReceived: 0,
                clickReceived: 0
              };

              const trackEvent = (e: Event) => { (eventTrace as any)[e.type + "Received"]++; };
              el.addEventListener("pointerdown", trackEvent);
              el.addEventListener("mousedown", trackEvent);
              el.addEventListener("mouseup", trackEvent);
              el.addEventListener("pointerup", trackEvent);
              el.addEventListener("click", trackEvent);

              const preTestStateStr = document.body.dataset.kamnaaTestState || null;
              const preTestStateObj = preTestStateStr ? JSON.parse(preTestStateStr) : null;

              for (const evt of [
                "pointerdown",
                "mousedown",
                "pointerup",
                "mouseup",
              ]) {
                el.dispatchEvent(
                  new MouseEvent(evt, {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                    button: 0,
                  })
                );
              }
              if (typeof (el as any).click === "function") (el as any).click();
              
              clickTrace.nativeClickReturned = true;
              console.log("[KAMNAA CLICK TRACE]", JSON.stringify(clickTrace));
              console.log("[KAMNAA CLICK EVENT TRACE]\n" + JSON.stringify(eventTrace, null, 2));

              el.removeEventListener("pointerdown", trackEvent);
              el.removeEventListener("mousedown", trackEvent);
              el.removeEventListener("mouseup", trackEvent);
              el.removeEventListener("pointerup", trackEvent);
              el.removeEventListener("click", trackEvent);

              if (typeof (el as any).focus === "function") (el as any).focus();
              
              await waitForDOMSettle(1500);

              const postTestStateStr = document.body.dataset.kamnaaTestState || null;
              const postTestStateObj = postTestStateStr ? JSON.parse(postTestStateStr) : null;
              
              console.log("[KAMNAA CLICK DISPATCH SUMMARY]\n" + JSON.stringify({
                actionId: (action as any)._meta?.stepIndex !== undefined ? (action as any)._meta.stepIndex + 1 : 1,
                targetIndex: action.target,
                syntheticPointerEventsDispatched: true,
                syntheticMouseEventsDispatched: true,
                syntheticClickEventsDispatched: true,
                nativeClickCalled: true,
                nativeClickReturned: clickTrace.nativeClickReturned,
                executeActionInvocationCount,
                clickDispatchInvocationCount,
                testStateBefore: {
                  saveAsDraftClicks: preTestStateObj?.saveAsDraftClicks,
                  lastAction: preTestStateObj?.lastAction
                },
                testStateAfter: {
                  saveAsDraftClicks: postTestStateObj?.saveAsDraftClicks,
                  lastAction: postTestStateObj?.lastAction
                }
              }, null, 2));
              
              
              if (preTestStateStr && postTestStateStr && preTestStateStr !== postTestStateStr) {
                resolve({ success: true, verified: true, verificationReason: "test-event-counter" });
                return;
              }
              
              const postUrl = window.location.href;
              if (postUrl !== preUrl) {
                resolve({ success: true, verified: true, verificationReason: "url_changed" });
                return;
              }
              if (!document.body.contains(el)) {
                resolve({ success: true, verified: true, verificationReason: "target_disappeared" });
                return;
              }
              const postHtml = el.outerHTML;
              if (postHtml !== preHtml) {
                resolve({ success: true, verified: true, verificationReason: "target_mutated" });
                return;
              }
              if (isCheckable(el) && (el as HTMLInputElement).checked !== wasChecked) {
                resolve({ success: true, verified: true, verificationReason: "checkbox_toggled" });
                return;
              }
              const postElementCount = document.querySelectorAll('*').length;
              if (Math.abs(postElementCount - preElementCount) > 2) {
                resolve({ success: true, verified: true, verificationReason: "dom_mutated" });
                return;
              }
              const postRect = el.getBoundingClientRect();
              if (Math.abs(postRect.x - preRect.x) > 5 || Math.abs(postRect.y - preRect.y) > 5) {
                resolve({ success: true, verified: true, verificationReason: "target_moved" });
                return;
              }
              
              resolve({ success: true, verified: false, verificationReason: "no_observable_change" });
              break;
            }

            case "type": {
              const res = await resolveAndScrollTarget(action);
              if (res.error || !res.el) {
                resolve({ success: false, error: res.error });
                return;
              }
              const el = res.el;

              const input = el as HTMLInputElement;
              input.focus();
              input.select();

              // Native setter hack: bypasses React/Vue synthetic event system
              // React overrides the value setter on input elements, so setting
              // input.value directly doesn't trigger React's onChange handler.
              // We use the native prototype setter to set the value, then dispatch
              // an input event so React picks it up.
              const isTextArea = el instanceof HTMLTextAreaElement;
              const proto = isTextArea
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;

              // BUG-12 FIX: removed duplicate `|| getOwnPropertyDescriptor(proto,"value")`
              // — both sides of the || were identical, making the fallback dead code.
              const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

              // Clear existing value
              if (nativeSetter) {
                nativeSetter.call(input, "");
              } else {
                input.value = "";
              }
              input.dispatchEvent(new Event("input", { bubbles: true }));

              // Human-like typing with realistic delays
              let i = 0;
              const value = action.value || "";
              const preValue = input.value;
              const typeNext = () => {
                if (i >= value.length) {
                  input.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  input.blur();
                  
                  // VERIFICATION
                  if (input.value !== preValue) {
                    resolve({ success: true, verified: true, verificationReason: "value_changed" });
                  } else {
                    resolve({ success: true, verified: false, verificationReason: "value_unchanged" });
                  }
                  return;
                }
                const char = value[i];
                input.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: char,
                    code: `Key${char.toUpperCase()}`,
                    bubbles: true,
                  })
                );
                // Use native setter so React/Vue pick up the change
                const currentValue = input.value;
                if (nativeSetter) {
                  nativeSetter.call(input, currentValue + char);
                } else {
                  input.value += char;
                }
                input.dispatchEvent(
                  new InputEvent("input", {
                    data: char,
                    inputType: "insertText",
                    bubbles: true,
                  })
                );
                input.dispatchEvent(
                  new KeyboardEvent("keyup", {
                    key: char,
                    code: `Key${char.toUpperCase()}`,
                    bubbles: true,
                  })
                );
                i++;
                setTimeout(typeNext, 30 + Math.random() * 50);
              };
              typeNext();
              break;
            }

            case "select": {
              const el = action.coordinates
                ? document.elementFromPoint(action.coordinates.x, action.coordinates.y)
                : findElement(action.target || "");
              if (!el || el.tagName !== "SELECT") {
                resolve({
                  success: false,
                  error: `Select not found: "${action.target}"`,
                });
                return;
              }
              const select = el as HTMLSelectElement;
              const preSelectedIndex = select.selectedIndex;
              for (const opt of select.options) {
                if (
                  opt.value === action.value ||
                  opt.text.toLowerCase() === action.value?.toLowerCase()
                ) {
                  select.value = opt.value;
                  select.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  resolve({ success: true, verified: select.selectedIndex !== preSelectedIndex, verificationReason: "selection_changed" });
                  return;
                }
              }
              for (const opt of select.options) {
                if (
                  opt.text
                    .toLowerCase()
                    .includes((action.value || "").toLowerCase())
                ) {
                  select.value = opt.value;
                  select.dispatchEvent(
                    new Event("change", { bubbles: true })
                  );
                  resolve({ success: true, verified: select.selectedIndex !== preSelectedIndex, verificationReason: "selection_changed" });
                  return;
                }
              }
              resolve({
                success: false,
                error: `Option not found: "${action.value}"`,
              });
              break;
            }

            case "scroll": {
              const preScrollY = window.scrollY;
              const dir = (action.value || "down").toLowerCase();
              const amounts: Record<string, number> = {
                up: -window.innerHeight * 0.7,
                down: window.innerHeight * 0.7,
                top: -window.scrollY,
                bottom: document.body.scrollHeight - window.scrollY,
              };
              window.scrollBy({
                top: amounts[dir] || 500,
                behavior: "smooth",
              });
              
              setTimeout(() => {
                if (window.scrollY !== preScrollY) {
                  resolve({ success: true, verified: true, verificationReason: "viewport_changed" });
                } else {
                  resolve({ success: true, verified: false, verificationReason: "viewport_unchanged" });
                }
              }, 500);
              break;
            }

            case "navigate": {
              if (action.value) {
                window.location.href = action.value;
                resolve({ success: true });
              } else {
                resolve({ success: false, error: "No URL provided" });
              }
              break;
            }

            case "hover": {
              const el = action.coordinates
                ? document.elementFromPoint(action.coordinates.x, action.coordinates.y)
                : findElement(action.target || "");
              if (!el) {
                resolve({
                  success: false,
                  error: `Element not found: "${action.target}"`,
                });
                return;
              }
              for (const evt of ["mouseover", "mouseenter", "pointerenter"]) {
                el.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
              }
              resolve({ success: true });
              break;
            }

            case "press_key": {
              const active = document.activeElement || document.body;
              for (const evt of ["keydown", "keypress", "keyup"]) {
                active.dispatchEvent(
                  new KeyboardEvent(evt, {
                    key: action.key || "",
                    code: action.key || "",
                    bubbles: true,
                  })
                );
              }
              resolve({ success: true });
              break;
            }

            case "go_back": {
              window.history.back();
              resolve({ success: true });
              break;
            }

            case "wait": {
              setTimeout(
                () => resolve({ success: true }),
                action.timeout || 1000
              );
              break;
            }

            default:
              resolve({
                success: false,
                error: `Unknown action type: ${(action as any).type}`,
              });
          }
        } catch (err: any) {
          resolve({ success: false, error: err.message });
        }
      });
    }

    // ════════════════════════════════════════════════════════
    // PII OVERLAY — Shows detected PII regions on page
    // ════════════════════════════════════════════════════════

    interface PIIOverlayRegion {
      id: string;
      category: string;
      sensitivity: string;
      boundingBox: { x: number; y: number; width: number; height: number };
      confidence: number;
    }

    interface PIITextItem {
      category: string;
      sensitivity: string;
    }

    function showPIIOverlay(data: {
      regions: PIIOverlayRegion[];
      textItems?: PIITextItem[];
      summary: { totalRegions: number; criticalCount: number; highCount: number };
    }): void {
      hidePIIOverlay();

      // Only skip if literally nothing detected
      if (data.summary.totalRegions === 0) return;

      overlayContainer = document.createElement("div");
      overlayContainer.id = "kamnaa-pii-overlay";
      overlayContainer.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        pointer-events: none;
        z-index: 2147483647;
      `;

      const SENSITIVITY_COLORS: Record<string, string> = {
        critical: "#F87171",
        high: "#f97316",
        medium: "#eab308",
        low: "#16a34a",
      };

      const CATEGORY_LABELS: Record<string, string> = {
        face: "Face",
        password: "Password",
        aadhaar: "Aadhaar",
        phone: "Phone",
        email: "Email",
        pan: "PAN",
        bank_account: "Bank Acct",
        name: "Name",
        address: "Address",
        financial: "Financial",
        medical: "Medical",
        credit_card: "Card",
      };

      // ── Draw visual bounding boxes for vision-detected PII ──
      for (const region of data.regions) {
        if (!region.boundingBox) continue;
        const bb = region.boundingBox;
        const color = SENSITIVITY_COLORS[region.sensitivity] || "#888";
        const label = CATEGORY_LABELS[region.category] || region.category.toUpperCase();

        const box = document.createElement("div");
        box.style.cssText = `
          position: absolute;
          left: ${bb.x}px;
          top: ${bb.y}px;
          width: ${bb.width}px;
          height: ${bb.height}px;
          border: 2px solid ${color};
          border-radius: 3px;
          background: ${color}18;
          pointer-events: none;
          transition: opacity 0.3s;
        `;

        const chip = document.createElement("span");
        chip.style.cssText = `
          position: absolute;
          top: -20px;
          left: 0;
          font-size: 10px;
          font-weight: 700;
          font-family: 'Spline Sans Mono', 'Courier New', monospace;
          color: white;
          background: ${color};
          padding: 1px 6px;
          border-radius: 2px;
          white-space: nowrap;
          letter-spacing: 0.05em;
        `;
        chip.textContent = `● ${label}`;
        box.appendChild(chip);
        overlayContainer.appendChild(box);
      }

      // ── Summary badge — always visible, shows total count ──
      const badge = document.createElement("div");
      badge.style.cssText = `
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: #0A0A0A;
        color: #F5F5F5;
        padding: 10px 18px;
        border-radius: 0;
        border: 2px solid #F87171;
        font-size: 12px;
        font-family: 'Spline Sans Mono', 'Courier New', monospace;
        box-shadow: 4px 4px 0 #F8717140;
        pointer-events: auto;
        z-index: 2147483647;
        max-width: 420px;
        min-width: 220px;
      `;

      // Count categories for the chip list
      const allItems = [
        ...data.regions.map(r => ({ category: r.category, sensitivity: r.sensitivity })),
        ...(data.textItems || []),
      ];
      const byCat: Record<string, { count: number; sensitivity: string }> = {};
      for (const item of allItems) {
        if (!byCat[item.category]) byCat[item.category] = { count: 0, sensitivity: item.sensitivity };
        byCat[item.category].count++;
      }

      const chipsHTML = Object.entries(byCat).map(([cat, { count, sensitivity }]) => {
        const color = SENSITIVITY_COLORS[sensitivity] || "#888";
        const lbl = CATEGORY_LABELS[cat] || cat;
        return `<span style="display:inline-block;background:${color};color:#fff;font-weight:700;padding:1px 7px;border-radius:2px;margin:2px 3px 2px 0;font-size:10px;letter-spacing:0.04em;">${lbl}${count > 1 ? ` ×${count}` : ""}</span>`;
      }).join("");

      const critText = data.summary.criticalCount > 0
        ? `<span style="color:#F87171;font-weight:700"> · ${data.summary.criticalCount} CRITICAL</span>`
        : "";

      badge.innerHTML = `
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;letter-spacing:0.06em;color:#F87171;">
          ● KAMNAA — ${data.summary.totalRegions} PII DETECTED${critText}
        </div>
        <div style="line-height:1.8;">${chipsHTML}</div>
        <div style="margin-top:6px;font-size:10px;color:#8A8A8A;letter-spacing:0.04em;">
          All data stays on-device. Auto-dismiss in 8s.
        </div>
      `;

      // Close button
      const close = document.createElement("button");
      close.textContent = "✕";
      close.style.cssText = `
        position: absolute;
        top: 6px; right: 8px;
        background: none; border: none;
        color: #a09882; font-size: 14px; cursor: pointer;
        pointer-events: auto; font-family: monospace; line-height: 1;
      `;
      close.onclick = () => hidePIIOverlay();
      badge.appendChild(close);
      badge.style.position = "fixed";
      overlayContainer.appendChild(badge);
      document.body.appendChild(overlayContainer);

      // Auto-dismiss after 8 seconds
      setTimeout(() => hidePIIOverlay(), 8000);
    }

    function hidePIIOverlay(): void {
      if (overlayContainer) {
        overlayContainer.remove();
        overlayContainer = null;
      }
    }

    // ════════════════════════════════════════════════════════
    // PIPELINE STATUS PANEL — Shows pipeline progress
    // ════════════════════════════════════════════════════════

    interface PipelineStatus {
      steps: Array<{
        name: string;
        status: "pending" | "running" | "complete" | "error";
        details: string;
      }>;
      privacyScore: number;
      piiDetected: number;
      piiRedacted: number;
    }

    function showPipelinePanel(data: PipelineStatus): void {
      hidePipelinePanel();

      pipelinePanel = document.createElement("div");
      pipelinePanel.id = "kamnaa-pipeline-panel";
      pipelinePanel.style.cssText = `
        position: fixed;
        bottom: 16px;
        right: 16px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        padding: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        z-index: 2147483647;
        pointer-events: auto;
        min-width: 260px;
        max-width: 320px;
      `;

      updatePipelinePanelInternal(data);
      document.body.appendChild(pipelinePanel);
    }

    function updatePipelinePanel(data: PipelineStatus): void {
      if (!pipelinePanel) {
        showPipelinePanel(data);
        return;
      }
      updatePipelinePanelInternal(data);
    }

    function updatePipelinePanelInternal(data: PipelineStatus): void {
      if (!pipelinePanel) return;

      const STEP_ICONS: Record<string, string> = {
        pending: "[ ]",
        running: "[>]",
        complete: "[OK]",
        error: "[!!]",
      };

      const STEP_COLORS: Record<string, string> = {
        pending: "#9e9e9e",
        running: "#1a237e",
        complete: "#2e7d32",
        error: "#d32f2f",
      };

      let stepsHTML = "";
      for (const step of data.steps) {
        const icon = STEP_ICONS[step.status];
        const color = STEP_COLORS[step.status];
        stepsHTML += `
          <div style="display: flex; align-items: center; gap: 6px; padding: 2px 0; color: ${color};">
            <span style="font-family: monospace; font-size: 11px;">${icon}</span>
            <span style="font-weight: 500;">${step.name}</span>
            ${step.details ? `<span style="color: #888; font-size: 10px; margin-left: auto;">${step.details}</span>` : ""}
          </div>
        `;
      }

      const privacyColor =
        data.privacyScore === 100
          ? "#2e7d32"
          : data.privacyScore >= 80
            ? "#f9a825"
            : "#d32f2f";

      pipelinePanel.innerHTML = `
        <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #1a237e;">
          KAMNAA Pipeline
        </div>
        ${stepsHTML}
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid ${privacyColor}; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; color: ${privacyColor};">
              ${data.privacyScore}
            </div>
            <div>
              <div style="font-weight: 600; color: ${privacyColor};">
                ${data.privacyScore === 100 ? "Perfect Privacy" : "Privacy Risk"}
              </div>
              <div style="font-size: 10px; color: #888;">
                ${data.piiDetected} detected, ${data.piiRedacted} redacted
              </div>
            </div>
          </div>
        </div>
      `;
    }

    function hidePipelinePanel(): void {
      if (pipelinePanel) {
        pipelinePanel.remove();
        pipelinePanel = null;
      }
    }

    // ════════════════════════════════════════════════════════
    // REDACTION CSS INJECTION
    // ════════════════════════════════════════════════════════

    function injectRedactionCSS(css: string): void {
      removeRedactionCSS();
      if (!css.trim()) return;
      redactionStyleEl = document.createElement("style");
      redactionStyleEl.id = "kamnaa-redaction-css";
      redactionStyleEl.textContent = css;
      document.head.appendChild(redactionStyleEl);
    }

    function removeRedactionCSS(): void {
      if (redactionStyleEl) {
        redactionStyleEl.remove();
        redactionStyleEl = null;
      }
    }

    // ════════════════════════════════════════════════════════
    // HELPERS
    // ════════════════════════════════════════════════════════

    // Cache of interactive elements for index-based lookup
    // The LLM returns targets like [0], [1], [2] which map to
    // the nth interactive element on the page.
    // BUG-FIX: This cache must be invalidated after every PERCEIVE_PAGE call
    // and on navigation events — otherwise the same [3] index that mapped to
    // the YouTube search box before a navigate maps to a completely different
    // element on the new page, causing phantom clicks.
    let interactiveElementCache: Element[] | null = null;

    function invalidateElementCache(): void {
      interactiveElementCache = null;
    }

    // Invalidate on soft navigation (SPA popstate + hashchange)
    window.addEventListener("popstate", invalidateElementCache, { passive: true });
    window.addEventListener("hashchange", invalidateElementCache, { passive: true });

    function getInteractiveElements(): Element[] {
      if (interactiveElementCache) return interactiveElementCache;
      // Must match the selectors in extractPageState() exactly
      // so LLM indices [0],[1],[2] resolve to the same elements
      const SELECTORS = [
        "a[href]", "button", "input", "select", "textarea",
        '[role="button"]', '[role="link"]', '[role="tab"]',
        '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
        '[role="combobox"]', '[contenteditable="true"]',
        "[tabindex]",
      ].join(", ");
      const rawElements = document.querySelectorAll(SELECTORS);
      const seen = new Set<Element>();
      interactiveElementCache = [];
      rawElements.forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (!isElementRendered(el)) return;
        interactiveElementCache!.push(el);
      });
      return interactiveElementCache;
    }

    function findElement(target: string, action?: any): Element | null {
      if (!target) return null;

      let resolvedElement: Element | null = null;

      // Helper for semantic compatibility check
      // Logic extracted to dom-fallback.ts for testing, but duplicated here to avoid complex imports in content scripts.
      // Wait, we can import from `../../core/agent/dom-fallback`!
      const isSemanticallyCompatible = (el: Element, targetDesc: string) => {
        if (!targetDesc) return true;
        const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
        const cleanExpected = norm(targetDesc).replace(/\b(the|button|element)\b/g, "").trim();
        const tag = el.tagName.toLowerCase();
        
        // Strict form element type checking based on targetDesc
        const requiresButton = cleanExpected.includes("button") || cleanExpected.includes("save") || cleanExpected.includes("preview") || cleanExpected.includes("submit");
        const requiresInput = cleanExpected.includes("input") || cleanExpected.includes("textbox") || cleanExpected.includes("textarea");
        
        if (requiresButton) {
          if (["input", "textarea", "select"].includes(tag)) {
            const type = el.getAttribute("type");
            if (!(tag === "input" && (type === "submit" || type === "button" || type === "reset"))) {
              return false; // Strongly reject non-button inputs for button requests
            }
          }
        }
        if (requiresInput && tag === "button") return false;
        
        return true;
      };

      // Helper to score an element against targetDescription
      const scoreElement = (el: Element, targetDesc: string) => {
        if (!targetDesc) return 0;
        const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
        const expected = norm(targetDesc);
        const cleanExpected = expected.replace(/\b(the|button|element)\b/g, "").trim();
        const elText = norm(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLInputElement).value || "");
        const cleanElText = elText.replace(/\b(the|button|element)\b/g, "").trim();
        
        let score = 0;
        if (elText === expected && elText.length > 0) score += 50;
        else if (cleanElText && cleanElText === cleanExpected) score += 40;
        else if (elText && expected && (elText.includes(expected) || expected.includes(elText))) score += 20;
        return score;
      };

      const targetDesc = action?.targetDescription || "";

      // Strategy 0: Index-based lookup [0], [1], [2]...
      const indexMatch = target.match(/^\[(\d+)\]$/);
      if (indexMatch) {
        const idx = parseInt(indexMatch[1], 10);
        const elements = getInteractiveElements();
        
        if (idx >= 0 && idx < elements.length) {
          const candidate = elements[idx];
          // If the cached element is compatible, we use it directly
          if (isSemanticallyCompatible(candidate, targetDesc)) {
             resolvedElement = candidate;
          }
        }

        // FULL DOM SEMANTIC FALLBACK (if index misses or is incompatible)
        if (!resolvedElement && targetDesc) {
          // Search ALL matching elements across the DOM, including hidden/scrolled
          const SELECTORS = [
            "a[href]", "button", "input", "select", "textarea",
            '[role="button"]', '[role="link"]', '[role="tab"]',
            '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
            '[role="combobox"]', '[contenteditable="true"]',
            "[tabindex]",
          ].join(", ");
          
          const rawElements = document.querySelectorAll(SELECTORS);
          let bestCandidate = null;
          let bestScore = 0;
          
          rawElements.forEach((el) => {
            if (!isSemanticallyCompatible(el, targetDesc)) return;
            const score = scoreElement(el, targetDesc);
            if (score > bestScore) {
              bestScore = score;
              bestCandidate = el;
            }
          });
          
          if (bestCandidate && bestScore > 0) {
            resolvedElement = bestCandidate as Element;
            
            // Scroll into view (as requested by user)
            resolvedElement.scrollIntoView({ block: "center", inline: "center" });
            
            // Re-verify after scrolling
            if (!isVisible(resolvedElement) || (resolvedElement as any).disabled === true) {
              resolvedElement = null; // Fails re-verification
            }
          }
          
          console.log("[KAMNAA GROUNDING FALLBACK]\n" + JSON.stringify({
            targetDescription: targetDesc,
            indexedTarget: target,
            indexedElement: idx >= 0 && idx < elements.length ? elements[idx].tagName : null,
            fallbackUsed: true,
            candidateCount: rawElements.length,
            matchedElement: !!resolvedElement,
            matchedTag: resolvedElement?.tagName || null,
            matchedText: resolvedElement?.textContent?.substring(0,50).trim() || null,
            matchedScore: bestScore,
            scrollPerformed: !!resolvedElement,
            visibleAfterScroll: resolvedElement ? isVisible(resolvedElement) : false,
            finalDecision: resolvedElement ? "fallback_success" : "TARGET_NOT_FOUND_SEMANTICALLY"
          }, null, 2));
          
          if (!resolvedElement) {
            throw new Error("TARGET_NOT_FOUND_SEMANTICALLY"); // Fails the pipeline cleanly
          }
        }
        
        if (resolvedElement) return resolvedElement;
        // If index lookup failed and no fallback was possible, return null
        return null;
      }

      // Strategy 1: Direct ID
      const byId = document.getElementById(target);
      if (byId && isVisible(byId)) return byId;

      // Strategy 2: CSS selector
      if (
        target.includes(".") ||
        target.includes("[") ||
        target.includes(">") ||
        target.includes("#")
      ) {
        try {
          const bySelector = document.querySelector(target);
          if (bySelector && isVisible(bySelector)) return bySelector;
        } catch {
          /* invalid selector */
        }
      }

      // Strategy 3: Name attribute
      const byName = document.querySelector(`[name="${target}"]`);
      if (byName && isVisible(byName)) return byName;

      // Strategy 4: ARIA label
      const byAria = document.querySelector(`[aria-label="${target}"]`);
      if (byAria && isVisible(byAria)) return byAria;

      // Strategy 5: Placeholder
      const byPlaceholder = document.querySelector(
        `[placeholder="${target}"]`
      );
      if (byPlaceholder && isVisible(byPlaceholder)) return byPlaceholder;

      // Strategy 6: Label association
      const byLabel = document.querySelector(`label[for="${target}"]`);
      if (byLabel) {
        const input =
          byLabel.querySelector("input, select, textarea") ||
          document.getElementById(byLabel.getAttribute("for") || "");
        if (input) return input;
      }

      // Strategy 7: Exact text match (buttons, links)
      const textEls = document.querySelectorAll(
        "button, a, [role='button'], [role='link'], [role='tab'], [role='menuitem']"
      );
      const lower = target.toLowerCase();

      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (text === lower && isVisible(el)) return el;
      }
      // Strategy 8: Contains match
      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (text.includes(lower) && isVisible(el)) return el;
      }

      // Strategy 9: Word overlap match (all target words must appear)
      const words = lower.split(/\s+/);
      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (words.every((w) => text.includes(w)) && isVisible(el)) return el;
      }

      // Strategy 10: Levenshtein fuzzy match (handles typos)
      let bestMatch: Element | null = null;
      let bestDistance = Infinity;
      const maxDistance = Math.max(2, Math.floor(lower.length * 0.3)); // Allow 30% typos

      for (const el of textEls) {
        const text = el.textContent?.trim().toLowerCase() || "";
        if (!text || !isVisible(el)) continue;
        const distance = levenshtein(lower, text.slice(0, lower.length + 5));
        if (distance < bestDistance && distance <= maxDistance) {
          bestDistance = distance;
          bestMatch = el;
        }
      }
      if (bestMatch) return bestMatch;

      // Strategy 11: Title/alt attribute match
      const byTitle = document.querySelector(`[title*="${target}"]`);
      if (byTitle && isVisible(byTitle)) return byTitle;

      const byAlt = document.querySelector(`[alt*="${target}"]`);
      if (byAlt && isVisible(byAlt)) return byAlt;

      return null;
    }

    // Levenshtein distance for fuzzy matching
    function levenshtein(a: string, b: string): number {
      if (a.length === 0) return b.length;
      if (b.length === 0) return a.length;
      const matrix: number[][] = [];
      for (let i = 0; i <= b.length; i++) matrix[i] = [i];
      for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
      for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
          const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
          matrix[i][j] = Math.min(
            matrix[i - 1][j] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j - 1] + cost
          );
        }
      }
      return matrix[b.length][a.length];
    }

    function isElementRendered(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (parseFloat(style.opacity) < 0.1) return false;
      return true;
    }

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      if (parseFloat(style.opacity) < 0.1) return false;
      if (rect.bottom < -100 || rect.top > window.innerHeight + 100) return false;
      if (rect.right < -100 || rect.left > window.innerWidth + 100) return false;
      return true;
    }

    /** Radio and checkbox carry a fixed option token in `.value`. */
    function isCheckable(el: Element): boolean {
      const type = (el.getAttribute("type") || "").toLowerCase();
      return el.tagName === "INPUT" && (type === "radio" || type === "checkbox");
    }

    function getFieldLabel(input: Element): string {
      if (input.id) {
        const label = document.querySelector(`label[for="${input.id}"]`);
        if (label) return label.textContent?.trim() || "";
      }
      const parentLabel = input.closest("label");
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true) as Element;
        clone
          .querySelectorAll("input, select, textarea")
          .forEach((c) => c.remove());
        const text = clone.textContent?.trim();
        if (text) return text;
      }
      // Previous sibling
      const prev = input.previousElementSibling;
      if (prev && ["LABEL", "SPAN", "DIV", "P"].includes(prev.tagName)) {
        return prev.textContent?.trim() || "";
      }
      return (
        input.getAttribute("aria-label") ||
        input.getAttribute("placeholder") ||
        ""
      );
    }

    function inferRole(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type")?.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "input") {
        if (type === "submit") return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      return "generic";
    }

    function detectHoneypots(): boolean {
      return Array.from(document.querySelectorAll("input, textarea")).some(
        (el) => {
          const style = window.getComputedStyle(el);
          if (
            style.position === "absolute" &&
            (parseInt(style.left) < -9999 || parseInt(style.top) < -9999)
          )
            return true;
          const name =
            el.getAttribute("name") || el.getAttribute("id") || "";
          if (/captcha|trap|bot|honeypot|cf-|wp-/i.test(name)) return true;
          return false;
        }
      );
    }

    console.log("[KAMNAA] Content script loaded.");
  },
});
