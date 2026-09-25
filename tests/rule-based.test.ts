import { describe, it, expect } from "vitest";
import { generateRuleBasedPlan } from "../src/core/pipeline/full-pipeline";

// Mock minimal DOM data since rule-based planner only reads forms/elements when strictly needed
const mockDomData = {
  url: "https://amazon.in",
  title: "Amazon",
  timestamp: Date.now(),
  elements: [],
  forms: [],
  textContent: "",
  metadata: {
    hasCAPTCHA: false,
    hasHoneypot: false,
    isSecure: true,
    hasFileUpload: false,
    hasPaymentForm: false,
    formCount: 0,
    totalElements: 0,
    interactiveElements: 0,
  },
  confidence: 1.0,
  perceptionTime: 10,
};

describe("generateRuleBasedPlan", () => {
  it("CASE 1: should correctly parse finding search box, typing value, and pressing Enter", () => {
    const plan = generateRuleBasedPlan("find the search box, enter running shoes under 5000, and press Enter", mockDomData as any);
    
    // Should have Type action and Press Key action
    expect(plan.steps.length).toBe(2);
    
    const typeAction = plan.steps[0].action;
    expect(typeAction.type).toBe("type");
    expect(typeAction.target).toBe("search");
    expect(typeAction.value).toBe("running shoes under 5000");
    
    const enterAction = plan.steps[1].action;
    expect(enterAction.type).toBe("press_key");
    expect(enterAction.key).toBe("Enter");
    
    // Ensure no spurious click('Enter') action exists
    const clickActions = plan.steps.filter(s => s.action.type === "click" && typeof s.action.target === 'string' && s.action.target.toLowerCase() === "enter");
    expect(clickActions.length).toBe(0);
  });

  it("CASE 2: should correctly parse typing into search box and pressing Enter", () => {
    // "type laptop into the search box and press Enter" will likely be decomposed to:
    // "type laptop into the search box, then press enter"
    const plan = generateRuleBasedPlan("type laptop into the search box, then press enter", mockDomData as any);
    
    expect(plan.steps.length).toBe(2);
    
    const typeAction = plan.steps[0].action;
    expect(typeAction.type).toBe("type");
    expect(typeAction.value).toBe("laptop");
    
    const enterAction = plan.steps[1].action;
    expect(enterAction.type).toBe("press_key");
    expect(enterAction.key).toBe("Enter");
  });

  it("CASE 3: should correctly parse only pressing Enter", () => {
    const plan = generateRuleBasedPlan("press Enter", mockDomData as any);
    
    expect(plan.steps.length).toBe(1);
    const enterAction = plan.steps[0].action;
    expect(enterAction.type).toBe("press_key");
    expect(enterAction.key).toBe("Enter");
  });

  it("CASE 4: should correctly parse clicking a submit button", () => {
    const plan = generateRuleBasedPlan("click the submit button", mockDomData as any);
    
    expect(plan.steps.length).toBe(1);
    const clickAction = plan.steps[0].action;
    expect(clickAction.type).toBe("click");
    expect(clickAction.target).toBe("the submit button");
  });

  it("CASE 5: should correctly parse clicking a search button", () => {
    const plan = generateRuleBasedPlan("click the search button", mockDomData as any);
    
    expect(plan.steps.length).toBe(1);
    const clickAction = plan.steps[0].action;
    expect(clickAction.type).toBe("click");
    expect(clickAction.target).toBe("the search button");
  });
  it("CASE 6: should correctly set targetDescription for generic clicks", () => {
    const plan = generateRuleBasedPlan("click cart", mockDomData as any);
    
    expect(plan.steps.length).toBe(1);
    const clickAction = plan.steps[0].action as any;
    expect(clickAction.type).toBe("click");
    expect(clickAction.target).toBe("cart");
    expect(clickAction.targetDescription).toBe("cart");
  });
});
