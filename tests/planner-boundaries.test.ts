import { describe, it, expect, vi } from "vitest";
import { executeFullPipeline } from "../src/core/pipeline/full-pipeline";

(global as any).chrome = {
  runtime: {
    id: "test-id",
  },
  tabs: {
    query: vi.fn(() => Promise.resolve([{ id: 1, active: true, windowId: 1 }])),
    sendMessage: vi.fn(() => Promise.resolve({
      elements: [],
      forms: [],
      metadata: { domain: "test", title: "test", elementCount: 0 }
    }))
  }
};

// Mocking the dependencies to isolate the boundary logic
vi.mock("../src/core/agent/llm-providers", () => ({
  generatePlanWithBestProvider: vi.fn((task) => {
    const isRecovery = (task as string).toLowerCase().includes("recovery");
    const numSteps = isRecovery ? 39 : 50; // Massively hallucinated lengths
    
    return Promise.resolve({
      success: true,
      provider: "ollama",
      latencyMs: 100,
      reasoning: "I got confused and generated 39 steps",
      steps: Array(numSteps).fill({
        action: { type: "click", target: "[0]", targetDescription: "Fake target" },
        reasoning: "Fake step",
        confidence: 0.9,
        risk: "low"
      })
    });
  })
}));

// Mock minimal dom and runtime requirements
vi.mock("../src/core/perception/florence2-engine", () => ({
  ensureModelLoaded: vi.fn(),
  detectElements: vi.fn(() => ({ elements: [], textRegions: [] })),
}));

vi.mock("../src/core/agent/action-grounding", () => ({
  groundAction: vi.fn(() => ({ success: true, groundedTarget: "x" }))
}));

describe("Planner Boundaries (PLAN_SCOPE_VIOLATION)", () => {
  it("rejects an initial plan that generates too many steps (max 25)", async () => {
    // We send an initial task (not recovery)
    const result = await executeFullPipeline(
      { taskDescription: "Do a simple task", mode: "full", maxSteps: 5 },
      "data:image/png;base64,fake",
      {} as any
    );
    
    expect(result.success).toBe(false);
    expect(result.error).toContain("PLAN_SCOPE_VIOLATION");
    expect(result.error).toContain("exceeds safe boundaries");
  });

  it("rejects a recovery plan that generates too many steps (max 10)", async () => {
    // We simulate a recovery task
    const result = await executeFullPipeline(
      { taskDescription: "Recovery: previous action failed.", mode: "full", maxSteps: 5 },
      "data:image/png;base64,fake",
      {} as any
    );
    
    expect(result.success).toBe(false);
    expect(result.error).toContain("PLAN_SCOPE_VIOLATION");
    expect(result.error).toContain("exceeds safe boundaries");
  });
});
