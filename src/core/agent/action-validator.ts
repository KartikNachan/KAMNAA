import { PlannedAction } from "../../types";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates the semantic intent of an action before attempting to ground it.
 * This catches gross LLM hallucinations like trying to type into a button.
 */
export function validateActionPreGrounding(action: PlannedAction): ValidationResult {
  const type = action.action.type;
  const desc = (action.action as any).targetDescription?.toLowerCase() || "";

  if (type === "type") {
    // If we're trying to type, but the description explicitly says it's a button, link, or checkbox
    if (desc.includes("button") || desc.includes("link") || desc.includes("checkbox") || desc.includes("radio")) {
      return {
        valid: false,
        reason: `PLAN_ACTION_TARGET_MISMATCH: Action is 'type' but targetDescription implies a non-editable element ("${desc}").`
      };
    }
  }

  if (type === "select") {
    if (desc.includes("button") || desc.includes("link") || desc.includes("checkbox") || desc.includes("radio") || desc.includes("input")) {
      return {
        valid: false,
        reason: `PLAN_ACTION_TARGET_MISMATCH: Action is 'select' but targetDescription implies a non-dropdown element ("${desc}").`
      };
    }
  }

  return { valid: true };
}

/**
 * Validates the resolved DOM element against the action's semantic requirements.
 * This catches cases where grounding fell back to an unsafe or incorrect element.
 */
export function validateActionPostGrounding(
  action: PlannedAction,
  resolvedTag: string,
  resolvedRole: string
): ValidationResult {
  const type = action.action.type;
  const tag = (resolvedTag || "").toLowerCase();
  const role = (resolvedRole || "").toLowerCase();
  
  if (type === "type") {
    // Must be input, textarea, or a textbox role
    if (!["input", "textarea"].includes(tag) && role !== "textbox") {
      return {
        valid: false,
        reason: `PLAN_ACTION_TARGET_MISMATCH: Action is 'type' but resolved target is <${tag} role="${role}"> (expected input/textarea/textbox).`
      };
    }
  }

  if (type === "click") {
    // Anything can be clicked technically, but if targetDescription explicitly said "button", 
    // it should be button-like. The user says: "If targetDescription says 'button', the resolved target must be a button-like element."
    const desc = (action.action as any).targetDescription?.toLowerCase() || "";
    if (desc.includes("button")) {
      const isButtonLike = ["button", "a", "input"].includes(tag) || ["button", "link", "submit"].includes(role);
      if (!isButtonLike) {
         return {
           valid: false,
           reason: `PLAN_ACTION_TARGET_MISMATCH: targetDescription requested a 'button', but resolved target is <${tag} role="${role}">.`
         };
      }
    }
  }

  if (type === "select") {
    // Must be a select element or combobox
    if (tag !== "select" && role !== "combobox" && role !== "listbox") {
      return {
        valid: false,
        reason: `PLAN_ACTION_TARGET_MISMATCH: Action is 'select' but resolved target is <${tag} role="${role}"> (expected select/combobox).`
      };
    }
  }

  return { valid: true };
}
