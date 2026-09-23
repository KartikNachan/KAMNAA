// ============================================================
// KAMNAA — Local Profile Matcher
// Semantically maps form fields to the local profile vault.
// Runs 100% locally to prevent LLM exposure to sensitive data.
// ============================================================

import type { PlannedAction } from "../../types";
import type { KamnaaProfile } from "./local-profile";
import { flattenProfile } from "./local-profile";

export interface ProfileMatchResult {
  success: boolean;
  steps: PlannedAction[];
  missingFields: string[];
  ambiguousFields: Array<{
    fieldLabel: string;
    selector: string;
    type: string;
    candidates: string[];
  }>;
  reasoning: string;
}

// Map logical profile keys to matching patterns
const PROFILE_PATTERNS: Record<string, RegExp[]> = {
  // Personal
  firstName: [/given\s*name/i, /first\s*name/i, /applicant.*name/i],
  lastName: [/family\s*name/i, /last\s*name/i, /surname/i],
  fullName: [/full\s*name/i, /name\s*as.*passport/i, /^name$/i],
  dateOfBirth: [/date\s*of\s*birth/i, /\bdob\b/i, /birth.*date/i],
  gender: [/gender/i, /\bsex\b/i],
  
  // Contact
  phone: [/mobile/i, /phone/i, /cell/i, /contact.*number/i],
  email: [/e?-?mail/i],
  
  // Address
  addressLine1: [/address/i, /street/i, /road/i, /lane/i, /house\s*no/i],
  addressLine2: [/address\s*line\s*2/i, /landmark/i],
  city: [/city/i, /town/i, /district/i, /village/i],
  state: [/state/i, /province/i],
  country: [/country/i, /nation/i],
  postalCode: [/pin\s*code/i, /pincode/i, /postal.*code/i, /zip/i],
  
  // Identity
  aadhaar: [/aadhaar/i, /aadhar/i, /uid/i],
  pan: [/pan\s*card/i, /pan\s*number/i, /^pan$/i],
  passportNumber: [/passport.*number/i, /passport\s*no/i],
  drivingLicenseNumber: [/driving.*license/i, /dl\s*number/i],
};

/**
 * Identify all possible profile keys that match a field label.
 */
function getMatchingKeys(label: string, name: string, id: string): string[] {
  const combined = `${label} ${name} ${id}`.toLowerCase();
  const matches: string[] = [];

  for (const [key, patterns] of Object.entries(PROFILE_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(combined)) {
        matches.push(key);
        break; // matched this key, move to next key
      }
    }
  }

  // Handle generic ambiguous patterns like "ID Number"
  if (/id\s*number/i.test(combined) || /identification/i.test(combined)) {
    if (!matches.includes("aadhaar")) matches.push("aadhaar");
    if (!matches.includes("pan")) matches.push("pan");
    if (!matches.includes("passportNumber")) matches.push("passportNumber");
  }

  return matches;
}

/**
 * Matches form elements against the local profile.
 * Handles ambiguity explicitly as per design rules.
 */
export function matchProfileToForm(
  elements: any[], 
  profile: KamnaaProfile
): ProfileMatchResult {
  const steps: PlannedAction[] = [];
  const missingFields: string[] = [];
  const ambiguousFields: Array<{ fieldLabel: string, selector: string, type: string, candidates: string[] }> = [];
  
  const flatProfile = flattenProfile(profile);
  // Also include custom fields as direct matches if exact string match
  const customKeys = Object.keys(profile.custom);
  
  let stepIndex = 0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el.isInteractive) continue;
    if (el.role !== "textbox" && el.role !== "combobox" && el.tag !== "select" && el.tag !== "input") continue;
    
    // Skip submit/buttons
    if (el.type === "submit" || el.type === "button" || el.type === "hidden") continue;

    const label = el.label || el.placeholder || el.ariaLabel || "";
    const name = el.name || "";
    const id = el.id || "";
    
    // 1. Try exact custom key match first
    const combinedStr = `${label} ${name} ${id}`.toLowerCase();
    let matchedCustomKey: string | null = null;
    
    for (const ck of customKeys) {
      if (combinedStr.includes(ck.toLowerCase())) {
        matchedCustomKey = ck;
        break;
      }
    }

    let possibleKeys: string[] = [];
    
    if (matchedCustomKey) {
      possibleKeys = [matchedCustomKey];
    } else {
      possibleKeys = getMatchingKeys(label, name, id);
    }

    if (possibleKeys.length === 0) {
      // If it's a required field and we can't map it, it's missing.
      // Assuming fields without labels are mostly layout, only flag missing if there's a label.
      if (label && (el.required || combinedStr.includes("*"))) {
        missingFields.push(label);
      }
      continue;
    }

    // Filter out keys that the user hasn't actually populated in their profile!
    const availableKeys = possibleKeys.filter(k => flatProfile[k] && flatProfile[k].trim() !== "");

    if (availableKeys.length === 0) {
      missingFields.push(label);
      continue;
    }

    const target = `[${i}]`;

    if (availableKeys.length > 1) {
      ambiguousFields.push({
        fieldLabel: label,
        selector: target,
        type: el.type || "text",
        candidates: availableKeys
      });
      continue;
    }

    // Exact single match
    const finalKey = availableKeys[0];
    const rawValue = flatProfile[finalKey];

    if (el.role === "combobox" || el.tag === "select") {
      steps.push({
        index: stepIndex++,
        action: {
          id: `profile-${stepIndex}`,
          type: "select",
          target,
          targetDescription: label,
          value: rawValue,
          retries: 0,
          maxRetries: 3
        },
        reasoning: `Select profile value for "${label}"`,
        confidence: 0.9,
        verification: "Field should reflect selected value",
        risk: "low"
      });
    } else {
      steps.push({
        index: stepIndex++,
        action: {
          id: `profile-click-${stepIndex}`,
          type: "click",
          target,
          targetDescription: label,
          retries: 0,
          maxRetries: 3
        },
        reasoning: `Focus field "${label}"`,
        confidence: 0.9,
        verification: "Field focused",
        risk: "low"
      });

      steps.push({
        index: stepIndex++,
        action: {
          id: `profile-type-${stepIndex}`,
          type: "type",
          target,
          targetDescription: label,
          value: rawValue, // Actual sensitive value inserted here for local execution
          retries: 0,
          maxRetries: 3
        },
        reasoning: `Fill profile value for "${label}"`,
        confidence: 0.9,
        verification: "Field filled",
        risk: "high" // Sensitive data injected
      });
    }
  }

  return {
    success: steps.length > 0,
    steps,
    missingFields: Array.from(new Set(missingFields)),
    ambiguousFields,
    reasoning: `Matched ${steps.length / 2} fields from profile. ${missingFields.length} missing, ${ambiguousFields.length} ambiguous.`
  };
}
