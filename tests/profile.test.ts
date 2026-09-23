import { expect, test, describe } from "vitest";
import { matchProfileToForm } from "../src/core/profile/profile-matcher";
import { KamnaaProfile, createEmptyProfile } from "../src/core/profile/local-profile";

describe("Profile Matcher", () => {
  test("Matches exact field and ignores missing", () => {
    const profile: KamnaaProfile = createEmptyProfile();
    profile.identity.pan = "ABCDE1234F";

    const elements = [
      { index: 0, isInteractive: true, role: "textbox", tag: "input", type: "text", label: "PAN Number", required: true },
      { index: 1, isInteractive: true, role: "textbox", tag: "input", type: "text", label: "Aadhaar", required: true }
    ];

    const result = matchProfileToForm(elements, profile);
    
    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(2); // click + type
    expect(result.steps[1].action.value).toBe("ABCDE1234F"); // Actual value
    
    expect(result.missingFields).toContain("Aadhaar");
    expect(result.ambiguousFields.length).toBe(0);
  });

  test("Identifies ambiguous fields", () => {
    const profile: KamnaaProfile = createEmptyProfile();
    profile.identity.pan = "ABCDE1234F";
    profile.identity.aadhaar = "123456789012";

    const elements = [
      { index: 0, isInteractive: true, role: "textbox", tag: "input", type: "text", label: "ID Number", required: true }
    ];

    const result = matchProfileToForm(elements, profile);
    
    expect(result.success).toBe(false); // No steps generated
    expect(result.ambiguousFields.length).toBe(1);
    expect(result.ambiguousFields[0].fieldLabel).toBe("ID Number");
    expect(result.ambiguousFields[0].candidates).toContain("pan");
    expect(result.ambiguousFields[0].candidates).toContain("aadhaar");
  });

  test("Maps custom fields", () => {
    const profile: KamnaaProfile = createEmptyProfile();
    profile.custom["Employee ID"] = "EMP999";

    const elements = [
      { index: 0, isInteractive: true, role: "textbox", tag: "input", type: "text", label: "Employee ID", required: true }
    ];

    const result = matchProfileToForm(elements, profile);
    
    expect(result.success).toBe(true);
    expect(result.steps.length).toBe(2); 
    expect(result.steps[1].action.value).toBe("EMP999"); 
  });
});
