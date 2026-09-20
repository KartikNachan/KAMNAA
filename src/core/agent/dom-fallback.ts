// src/core/agent/dom-fallback.ts

export function isSemanticallyCompatible(el: Element, targetDesc: string): boolean {
  if (!targetDesc) return true;
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  const cleanExpected = norm(targetDesc).replace(/\b(the|button|element)\b/g, "").trim();
  const tag = el.tagName.toLowerCase();
  
  // Strict form element type checking based on targetDesc
  const requiresButton = cleanExpected.includes("button") || cleanExpected.includes("save") || cleanExpected.includes("preview") || cleanExpected.includes("submit");
  const requiresInput = cleanExpected.includes("input") || cleanExpected.includes("textbox") || cleanExpected.includes("textarea") || cleanExpected.includes("field");
  
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
}

export function scoreElement(el: Element, targetDesc: string): number {
  if (!targetDesc) return 0;
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  const expected = norm(targetDesc);
  const cleanExpected = expected.replace(/\b(the|button|element)\b/g, "").trim();
  
  const elText = norm(
    el.textContent || 
    el.getAttribute("aria-label") || 
    el.getAttribute("title") || 
    (el as HTMLInputElement).value || 
    ""
  );
  const cleanElText = elText.replace(/\b(the|button|element)\b/g, "").trim();
  
  let score = 0;
  if (elText === expected && elText.length > 0) score += 50;
  else if (cleanElText && cleanElText === cleanExpected) score += 40;
  else if (elText && expected && (elText.includes(expected) || expected.includes(elText))) score += 20;
  
  // Tag and role matching bonuses
  const role = el.getAttribute("role");
  if (cleanExpected.includes("save") || cleanExpected.includes("preview") || cleanExpected.includes("submit") || cleanExpected.includes("button")) {
    if (el.tagName.toLowerCase() === "button" || role === "button") {
      score += 30;
    }
  }
  
  return score;
}

export function performFullDOMSemanticFallback(targetDesc: string, isVisibleFn: (el: Element) => boolean): Element | null {
  if (!targetDesc) return null;

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
    const resolvedElement = bestCandidate as Element;
    
    // Scroll into view (as requested by user)
    resolvedElement.scrollIntoView({ block: "center", inline: "center" });
    
    // Re-verify after scrolling
    if (!isVisibleFn(resolvedElement) || (resolvedElement as any).disabled === true) {
      return null; // Fails re-verification
    }
    return resolvedElement;
  }
  
  return null;
}
