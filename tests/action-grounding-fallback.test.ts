import { describe, it, expect, beforeEach, vi } from "vitest";
import { isSemanticallyCompatible, scoreElement, performFullDOMSemanticFallback } from "../src/core/agent/dom-fallback";

// Minimal DOM Mock
class MockElement {
  tagName: string;
  attributes: Record<string, string> = {};
  textContent: string = "";
  value: string = "";
  disabled: boolean = false;
  scrollIntoView = vi.fn();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  toLowerCase() { return this.tagName.toLowerCase(); }
  
  getAttribute(name: string) {
    return this.attributes[name.toLowerCase()] || null;
  }

  setAttribute(name: string, val: string) {
    this.attributes[name.toLowerCase()] = val;
  }
}

describe("Action Grounding - Content Script Fallback", () => {
  let mockElements: MockElement[] = [];

  beforeEach(() => {
    mockElements = [];
    (globalThis as any).document = {
      querySelectorAll: () => mockElements
    };
  });

  it("TEST 1: button is outside viewport, found through full DOM fallback", () => {
    const btn = new MockElement("BUTTON");
    btn.textContent = "Save as Draft";
    mockElements.push(btn);

    const isVisibleFn = () => true;
    const result = performFullDOMSemanticFallback("Save as Draft button", isVisibleFn);
    
    expect(result).toBe(btn as any);
    expect(btn.scrollIntoView).toHaveBeenCalled();
  });

  it("TEST 2: targetDescription is 'Save as Draft button', indexed element is an input, expected to reject and find actual button", () => {
    const input = new MockElement("INPUT");
    input.setAttribute("type", "text");
    input.value = "Save as Draft";
    
    expect(isSemanticallyCompatible(input as any, "Save as Draft button")).toBe(false);
    
    const btn = new MockElement("BUTTON");
    btn.textContent = "Save as Draft";
    expect(isSemanticallyCompatible(btn as any, "Save as Draft button")).toBe(true);
  });

  it("TEST 3: targetDescription is 'Save as Draft button', no matching button exists -> TARGET_NOT_FOUND_SEMANTICALLY", () => {
    const input = new MockElement("INPUT");
    input.setAttribute("type", "text");
    input.value = "Save as Draft";
    mockElements.push(input);

    const isVisibleFn = () => true;
    const result = performFullDOMSemanticFallback("Save as Draft button", isVisibleFn);
    
    expect(result).toBeNull();
  });

  it("TEST 4: targetDescription = 'Preview Application button', expected = correct button found", () => {
    const btn = new MockElement("BUTTON");
    btn.textContent = "Preview Application";
    mockElements.push(btn);

    const result = performFullDOMSemanticFallback("Preview Application button", () => true);
    expect(result).toBe(btn as any);
  });

  it("TEST 5: targetDescription = 'Given Name input field', expected = input found", () => {
    const input = new MockElement("INPUT");
    input.setAttribute("type", "text");
    input.setAttribute("name", "givenName");
    input.setAttribute("aria-label", "Given Name");
    mockElements.push(input);

    const result = performFullDOMSemanticFallback("Given Name input field", () => true);
    expect(result).toBe(input as any);
  });

  it("TEST 6: targetDescription = 'Save as Draft button', candidate input has high textual similarity, expected = input MUST NOT be selected", () => {
    const input = new MockElement("INPUT");
    input.setAttribute("type", "text");
    input.value = "Save as Draft button";
    mockElements.push(input);

    const result = performFullDOMSemanticFallback("Save as Draft button", () => true);
    expect(result).toBeNull();
  });
});
