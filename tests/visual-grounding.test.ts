import { describe, it, expect } from "vitest";
import { groundAction } from "../src/core/agent/action-grounding";

describe("Visual-First Grounding for Clicks", () => {
  it("Test 1 & 2: visual grounding succeeds without DOM index and returns correct coordinates", () => {
    const plannedAction = {
      action: { type: "click", target: "cart" },
      reasoning: ""
    };
    
    // Missing DOM element for "cart"
    const currentDomData = {
      elements: [],
      florenceTextRegions: [
        { text: "Cart", box: { x: 100, y: 50, w: 80, h: 40 } }
      ]
    };
    
    const result = groundAction(plannedAction as any, null, currentDomData);
    
    expect(result.success).toBe(true);
    expect(result.groundedTarget).toBe("visual_coordinates");
    expect(result.coordinates?.x).toBe(140); // 100 + 80 / 2
    expect(result.coordinates?.y).toBe(70);  // 50 + 40 / 2
    expect(result.diagnostic?.groundingMethod).toBe("visual_first_coordinates");
  });

  it("Test 3: No visual candidate exists -> existing DOM grounding is used", () => {
    const plannedAction = {
      action: { type: "click", target: "checkout" },
      reasoning: ""
    };
    
    const currentDomData = {
      elements: [
        { text: "Checkout", tag: "button", role: "button", isVisible: true }
      ],
      florenceTextRegions: [
        // No match for checkout
        { text: "Cart", box: { x: 100, y: 50, w: 80, h: 40 } }
      ]
    };
    
    const result = groundAction(plannedAction as any, null, currentDomData);
    
    expect(result.success).toBe(true);
    expect(result.groundedTarget).toBe("[0]"); // Matches the DOM element
    expect(result.diagnostic?.groundingMethod).toBe("dom_semantic");
  });

  it("Test 4: Visual and DOM candidates both exist -> visual candidate is selected FIRST for click", () => {
    const plannedAction = {
      action: { type: "click", target: "cart" },
      reasoning: ""
    };
    
    const currentDomData = {
      elements: [
        { text: "Cart", tag: "a", role: "link", isVisible: true } // DOM match
      ],
      florenceTextRegions: [
        { text: "Cart", box: { x: 100, y: 50, w: 80, h: 40 } } // Visual match
      ]
    };
    
    const result = groundAction(plannedAction as any, null, currentDomData);
    
    // Because it's a click, visual should win!
    expect(result.success).toBe(true);
    expect(result.groundedTarget).toBe("visual_coordinates");
    expect(result.coordinates?.x).toBe(140);
    expect(result.coordinates?.y).toBe(70);
    expect(result.diagnostic?.groundingMethod).toBe("visual_first_coordinates");
  });

  it("Test 5: Visual is NOT prioritized for non-click actions like 'type'", () => {
    const plannedAction = {
      action: { type: "type", target: "search", text: "query" },
      reasoning: ""
    };
    
    const currentDomData = {
      elements: [
        { tag: "input", placeholder: "Search", role: "searchbox", isVisible: true }
      ],
      florenceTextRegions: [
        { text: "Search", box: { x: 10, y: 10, w: 20, h: 10 } }
      ]
    };
    
    const result = groundAction(plannedAction as any, null, currentDomData);
    
    // Because it's a type action, DOM should win over visual
    expect(result.success).toBe(true);
    expect(result.groundedTarget).toBe("[0]");
    expect(result.diagnostic?.groundingMethod).toBe("dom_semantic");
  });
});
