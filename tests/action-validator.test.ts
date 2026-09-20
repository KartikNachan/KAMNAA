import { describe, it, expect } from "vitest";
import { validateActionPreGrounding, validateActionPostGrounding } from "../src/core/agent/action-validator";
import { PlannedAction } from "../src/types";

describe("Action Validator", () => {
  describe("validateActionPreGrounding", () => {
    it("should allow type action if description implies an input field", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "type", target: "[0]", targetDescription: "Email input", value: "test" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPreGrounding(action);
      expect(result.valid).toBe(true);
    });

    it("should reject type action if description implies a button", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "type", target: "[0]", targetDescription: "Save as Draft button", value: "test" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPreGrounding(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("PLAN_ACTION_TARGET_MISMATCH");
    });

    it("should reject select action if description implies a button", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "select", target: "[0]", targetDescription: "Preview Application button", value: "test" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPreGrounding(action);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("PLAN_ACTION_TARGET_MISMATCH");
    });
  });

  describe("validateActionPostGrounding", () => {
    it("should allow click on a button tag when description is button", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "click", target: "[0]", targetDescription: "Submit button" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "button", "button");
      expect(result.valid).toBe(true);
    });

    it("should reject click if description requires a button but resolved target is a generic div", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "click", target: "[0]", targetDescription: "Submit button" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "div", "generic");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("PLAN_ACTION_TARGET_MISMATCH");
    });

    it("should allow type action on an input tag", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "type", target: "[0]", targetDescription: "Email" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "input", "textbox");
      expect(result.valid).toBe(true);
    });

    it("should allow type action on a textarea tag", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "type", target: "[0]", targetDescription: "Comments" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "textarea", "textbox");
      expect(result.valid).toBe(true);
    });

    it("should reject type action on a button tag", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "type", target: "[0]", targetDescription: "Search" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "button", "button");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("PLAN_ACTION_TARGET_MISMATCH");
    });

    it("should allow select action on a select tag", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "select", target: "[0]", targetDescription: "Country dropdown" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "select", "combobox");
      expect(result.valid).toBe(true);
    });

    it("should reject select action on a button tag", () => {
      const action: PlannedAction = {
        index: 1,
        action: { type: "select", target: "[0]", targetDescription: "Menu" },
        reasoning: "",
        confidence: 1,
        risk: "low"
      };
      const result = validateActionPostGrounding(action, "button", "button");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("PLAN_ACTION_TARGET_MISMATCH");
    });
  });
});
