import { describe, it, expect } from "vitest";
import { groundAction } from "../src/core/agent/action-grounding";
import { PlannedAction } from "../src/types";

describe("Action Grounding - Semantic Resolution", () => {
  it("prioritizes targetDescription and penalizes inputs for button actions", () => {
    const plannedAction: PlannedAction = {
      action: {
        type: "click",
        target: "[14]",
        targetDescription: "Save as Draft button"
      } as any,
      reasoning: "User wants to save draft",
      confidence: 1.0,
      risk: "low"
    };

    const mockDomData = {
      elements: [
        ...Array(14).fill({ tag: "div", text: "spacer", role: "none", isVisible: true }), // 0-13
        { tag: "input", text: "A1234567", role: "textbox", isVisible: true, type: "text" }, // 14
        { tag: "div", text: "spacer", role: "none", isVisible: true }, // 15
        { tag: "div", text: "spacer", role: "none", isVisible: true }, // 16
        { tag: "div", text: "spacer", role: "none", isVisible: true }, // 17
        { tag: "button", text: "Save as Draft", role: "button", isVisible: true, type: "button" } // 18
      ]
    };

    const result = groundAction(plannedAction, mockDomData, mockDomData);
    
    expect(result.success).toBe(true);
    expect(result.groundedTarget).toBe("[18]");
    expect(result.diagnostic?.groundingMethod).toBe("dom_semantic");
    expect(result.diagnostic?.targetTag).toBe("button");
  });

  it("fails hard if targetDescription specifies a critical button that is missing", () => {
    const plannedAction: PlannedAction = {
      action: {
        type: "click",
        target: "[14]",
        targetDescription: "Preview Application"
      } as any,
      reasoning: "User wants to preview",
      confidence: 1.0,
      risk: "low"
    };

    const mockDomData = {
      elements: [
        { tag: "button", text: "Go Back", role: "button", isVisible: true }, // 0
      ]
    };

    const result = groundAction(plannedAction, mockDomData, mockDomData);
    
    expect(result.success).toBe(false);
    expect(result.reason).toBe("TARGET_SEMANTIC_MISMATCH");
  });
});
