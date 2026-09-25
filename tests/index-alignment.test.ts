import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("DOM Index Alignment", () => {
  it("execution-side filtering must apply the same opacity rule as perception", () => {
    const srcPath = path.resolve(__dirname, "../src/entrypoints/content/index.ts");
    const code = fs.readFileSync(srcPath, "utf-8");

    // Check perception filtering
    const extractBodyMatch = code.match(/function extractPageState\(\)[\s\S]*?parseFloat\(style\.opacity\) < 0\.1/);
    expect(extractBodyMatch).toBeTruthy();

    // Check execution filtering
    const renderBodyMatch = code.match(/function isElementRendered\([\s\S]*?parseFloat\(style\.opacity\) < 0\.1/);
    expect(renderBodyMatch).toBeTruthy();
    
    // Check that extractPageState invalidates the cache to prevent stale execution indices
    const invalidateMatch = code.match(/function extractPageState\(\)[\s\S]*?invalidateElementCache\(\);/);
    expect(invalidateMatch).toBeTruthy();
  });
});
