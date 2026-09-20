import { PlannedAction } from "../../types";

export interface GroundingResult {
  success: boolean;
  groundedTarget: string;
  reason: string;
  coordinates?: { x: number; y: number };
  diagnostic?: {
    originalTargetIndex: number | null;
    resolvedSemanticText: string;
    freshDomTargetIndex: number | null;
    targetTag: string;
    targetRole: string;
    targetText: string;
    groundingScore: number;
    groundingMethod: string;
  };
}

export function groundAction(
  plannedAction: PlannedAction,
  originalDomData: any, // using any for now, will refine
  currentDomData: any
): GroundingResult {
  const llmTarget = plannedAction.action.target || "";
  
  // Inherit visual data from originalDomData if missing in currentDomData
  if (!currentDomData.florenceElements && originalDomData?.florenceElements) {
    currentDomData.florenceElements = originalDomData.florenceElements;
  }
  if (!currentDomData.florenceTextRegions && originalDomData?.florenceTextRegions) {
    currentDomData.florenceTextRegions = originalDomData.florenceTextRegions;
  }
  
  const diagnosticLog: any = {
    actionType: plannedAction.action.type,
    originalLlmTarget: llmTarget,
    originalTargetIndex: null,
    resolvedSemanticText: "",
    freshDomTargetIndex: null,
    targetTag: "",
    targetRole: "",
    targetText: "",
    groundingScore: 0,
    groundingMethod: "none",
  };
  
  // 1. Resolve original semantic intent
  let expectedSemanticText = "";
  let expectedRole = "";
  let expectedTag = "";

  const indexMatch = llmTarget.match(/^\[(\d+)\]$/);
  if (indexMatch && originalDomData?.elements) {
    const idx = parseInt(indexMatch[1], 10);
    diagnosticLog.originalTargetIndex = idx;
    const originalEl = originalDomData.elements[idx];
    if (originalEl) {
      expectedSemanticText = originalEl.text || originalEl.ariaLabel || originalEl.label || "";
      expectedRole = originalEl.role || "";
      expectedTag = originalEl.tag || "";
    }
  } else {
    // If LLM returned raw text
    expectedSemanticText = llmTarget;
  }
  
  // STRONG OVERRIDE: Prioritize targetDescription explicitly provided by the planner
  const targetDesc = (plannedAction.action as any).targetDescription;
  if (targetDesc && typeof targetDesc === "string" && targetDesc.trim()) {
    expectedSemanticText = targetDesc.trim();
  }

  diagnosticLog.resolvedSemanticText = expectedSemanticText;

  // Normalize semantic text
  const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  const normalizedExpected = norm(expectedSemanticText);

  // If we couldn't extract any semantic intent and it's not a direct text target, fallback to exact index (unsafe)
  if (!normalizedExpected) {
    if (indexMatch && currentDomData?.elements && currentDomData.elements[parseInt(indexMatch[1], 10)]) {
      diagnosticLog.freshDomTargetIndex = parseInt(indexMatch[1], 10);
      diagnosticLog.groundingMethod = "unsafe_index_fallback";
      console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
      return {
        success: true,
        groundedTarget: `[${indexMatch[1]}]`,
        reason: "fallback_to_index",
        diagnostic: diagnosticLog
      };
    }
    console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
    return { success: false, groundedTarget: "", reason: "no_semantic_intent", diagnostic: diagnosticLog };
  }

  // 2. SELECT Action Grounding Fast-Path
  if (plannedAction.action.type === "select" && diagnosticLog.originalTargetIndex !== null && currentDomData?.elements) {
    const origIdx = diagnosticLog.originalTargetIndex;
    const currentEl = currentDomData.elements[origIdx];
    if (currentEl) {
      const originalEl = originalDomData?.elements?.[origIdx];
      const isTagMatch = currentEl.tag === "select" || currentEl.role === "combobox";
      
      const selectDiagnostic = {
        originalTarget: llmTarget,
        targetDescription: targetDesc || "",
        originalElementTag: originalEl?.tag || "",
        originalElementRole: originalEl?.role || "",
        originalElementText: originalEl?.text || originalEl?.ariaLabel || originalEl?.label || "",
        resolvedTarget: `[${origIdx}]`,
        resolvedElementTag: currentEl.tag || "",
        resolvedElementRole: currentEl.role || "",
        resolvedElementText: currentEl.text || currentEl.ariaLabel || currentEl.label || "",
        groundingMethod: "preserved_original_target",
        groundingScore: 100,
        decision: "preserved_original_target"
      };

      if (isTagMatch) {
        console.log("[KAMNAA SELECT GROUNDING]\n" + JSON.stringify(selectDiagnostic, null, 2));
        
        diagnosticLog.freshDomTargetIndex = origIdx;
        diagnosticLog.targetTag = currentEl.tag;
        diagnosticLog.targetRole = currentEl.role;
        diagnosticLog.targetText = currentEl.text || currentEl.ariaLabel || currentEl.label || "";
        diagnosticLog.groundingScore = 100;
        diagnosticLog.groundingMethod = "preserved_original_target";
        
        const visibilityState = currentEl.visibilityState || (currentEl.isVisible ? "visible" : "hidden");
        let groundingDecision = visibilityState === "offscreen" ? "allowed_offscreen" : (visibilityState === "visible" ? "allowed_visible" : "target_hidden");
        
        if (!currentEl.isVisible && visibilityState !== "offscreen") {
           return { success: false, groundedTarget: "", reason: "target_hidden", diagnostic: diagnosticLog };
        }
        if (currentEl.isDisabled) {
           return { success: false, groundedTarget: "", reason: "target_disabled", diagnostic: diagnosticLog };
        }
        
        return {
          success: true,
          groundedTarget: `[${origIdx}]`,
          reason: groundingDecision,
          diagnostic: diagnosticLog
        };
      } else {
        selectDiagnostic.decision = "rejected_structural_mismatch";
        console.log("[KAMNAA SELECT GROUNDING]\n" + JSON.stringify(selectDiagnostic, null, 2));
      }
    }
  }

  // 3. Candidate Matching against CURRENT DOM
  if (currentDomData?.elements) {
    const candidates = currentDomData.elements.map((el: any, index: number) => {
      const elText = norm(el.text || el.ariaLabel || el.label || "");
      let score = 0;
      
      // Remove harmless words for a looser check
      const cleanExpected = normalizedExpected.replace(/\b(the|button|element)\b/g, "").trim();
      const cleanElText = elText.replace(/\b(the|button|element)\b/g, "").trim();

      if (elText === normalizedExpected && elText.length > 0) score += 50;
      else if (cleanElText && cleanElText === cleanExpected) score += 40;
      else if (elText && normalizedExpected && (elText.includes(normalizedExpected) || normalizedExpected.includes(elText))) score += 20;
      
      if (expectedTag && el.tag === expectedTag) score += 10;
      if (expectedRole && el.role === expectedRole) score += 10;
      
      // Strong boosts for buttons if searching for a button
      if (cleanExpected.includes("save") || cleanExpected.includes("preview") || cleanExpected.includes("submit")) {
        if (el.tag === "button" || el.role === "button") score += 30;
      }

      // Strong penalties
      if (plannedAction.action.type === "click" || cleanExpected.includes("button")) {
        if (["input", "textarea", "select"].includes(el.tag)) {
          // If it's literally just an input field, it shouldn't be clicked as a button unless it's a submit input
          if (el.tag === "input" && (el.type === "submit" || el.type === "button")) {
             // Submit inputs are fine
          } else {
             score -= 100;
          }
        }
      }

      return { index, score, el, text: elText };
    }).filter((c: any) => c.score > 0)
      .sort((a: any, b: any) => b.score - a.score);

    if (candidates.length > 0 && candidates[0].score > 0) {
      // Return the index of the highest scoring candidate in the current DOM
      const bestMatch = candidates[0];
      
      diagnosticLog.freshDomTargetIndex = bestMatch.index;
      diagnosticLog.targetTag = bestMatch.el.tag;
      diagnosticLog.targetRole = bestMatch.el.role;
      diagnosticLog.targetText = bestMatch.text;
      diagnosticLog.groundingScore = bestMatch.score;
      diagnosticLog.groundingMethod = "dom_semantic";

      // Action-specific validation
      if (plannedAction.action.type === "type" && !["input", "textarea"].includes(bestMatch.el.tag) && bestMatch.el.role !== "textbox") {
        console.warn(`[KAMNAA] Grounding mismatch: 'type' action expected input, found ${bestMatch.el.tag}`);
      }
      
      // Hard Semantic Safety Check for critical buttons
      if (plannedAction.action.type === "click") {
        const requiredTerms = ["save as draft", "preview application"];
        for (const term of requiredTerms) {
          if (normalizedExpected.includes(term) && !bestMatch.text.includes(term)) {
            console.warn(`[KAMNAA] Hard Semantic Safety Check Failed! Expected "${term}" but grounded to "${bestMatch.text}"`);
            return { success: false, groundedTarget: "", reason: "TARGET_SEMANTIC_MISMATCH", diagnostic: diagnosticLog };
          }
        }
      }
      
      if (bestMatch.el.isDisabled) {
        console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
        return { success: false, groundedTarget: "", reason: "target_disabled", diagnostic: diagnosticLog };
      }
      
      const visibilityState = bestMatch.el.visibilityState || (bestMatch.el.isVisible ? "visible" : "hidden");
      let groundingDecision = visibilityState === "offscreen" ? "allowed_offscreen" : (visibilityState === "visible" ? "allowed_visible" : "target_hidden");
      let rejectReason = null;

      if (!bestMatch.el.isVisible && visibilityState !== "offscreen") {
        groundingDecision = "target_hidden";
        rejectReason = "target_hidden";
      }

      console.log("[KAMNAA GROUNDING TARGET]\n" + JSON.stringify({
        target: `[${bestMatch.index}]`,
        targetDescription: (plannedAction.action as any).targetDescription || "",
        targetRole: bestMatch.el.role,
        targetIndex: bestMatch.index,
        targetTag: bestMatch.el.tag,
        visibilityState: visibilityState,
        groundingDecision: groundingDecision
      }, null, 2));
      
      if (rejectReason) {
        console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
        return { success: false, groundedTarget: "", reason: rejectReason, diagnostic: diagnosticLog };
      }

      console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
      
      return {
        success: true,
        groundedTarget: `[${bestMatch.index}]`,
        reason: `dom_semantic_match (score ${bestMatch.score})`,
        diagnostic: diagnosticLog
      };
    }
  }

  // 3. Visual Grounding Fallback
  if (currentDomData?.florenceTextRegions) {
    const visualCandidates = currentDomData.florenceTextRegions.map((region: any) => {
      const regionText = norm(region.text);
      let score = 0;
      if (regionText === normalizedExpected) score += 5;
      else if (regionText.includes(normalizedExpected) || normalizedExpected.includes(regionText)) score += 2;
      return { region, score };
    }).filter((c: any) => c.score > 0)
      .sort((a: any, b: any) => b.score - a.score);

    if (visualCandidates.length > 0 && visualCandidates[0].score >= 2) {
      const bestVisual = visualCandidates[0].region;
      const x = bestVisual.box.x + bestVisual.box.w / 2;
      const y = bestVisual.box.y + bestVisual.box.h / 2;
      
      diagnosticLog.targetText = bestVisual.text;
      diagnosticLog.groundingScore = visualCandidates[0].score;
      diagnosticLog.groundingMethod = "visual_coordinates";
      console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
      
      return {
        success: true,
        groundedTarget: "visual_coordinates",
        reason: `visual_semantic_match (score ${visualCandidates[0].score})`,
        coordinates: { x, y },
        diagnostic: diagnosticLog
      };
    }
  }

  // 4. Defer to Content Script Fallback
  // If we have a semantic targetDescription but couldn't find a valid visible element,
  // we pass the index and let the content script search the full DOM (including hidden/scrolled elements).
  if (targetDesc && typeof targetDesc === "string" && targetDesc.trim()) {
    diagnosticLog.groundingMethod = "deferred_to_content_script_fallback";
    
    // Inherit the tag and role from the original element (if known) so that
    // pre-execution semantic validation does not reject valid off-screen elements.
    const originalEl = diagnosticLog.originalTargetIndex !== null && originalDomData?.elements 
      ? originalDomData.elements[diagnosticLog.originalTargetIndex] 
      : null;
      
    if (originalEl) {
      diagnosticLog.targetTag = originalEl.tag;
      diagnosticLog.targetRole = originalEl.role;
    }
    
    console.log(`[KAMNAA DIAGNOSTIC] Grounding deferred to fallback:`, JSON.stringify(diagnosticLog));
    return {
      success: true, // Let the content script execute Action fallback
      groundedTarget: llmTarget,
      reason: "deferred_to_content_script_fallback",
      diagnostic: diagnosticLog
    };
  }

  // --- START DEEP FAILURE DIAGNOSTIC ---
  const originalEl = diagnosticLog.originalTargetIndex !== null && originalDomData?.elements ? originalDomData.elements[diagnosticLog.originalTargetIndex] : null;
  let allCandidates = [];
  let top5 = [];
  if (currentDomData?.elements) {
    allCandidates = currentDomData.elements.map((el: any, index: number) => {
      const text = (el.text || el.ariaLabel || el.label || "").toLowerCase().trim().replace(/\s+/g, ' ');
      return { index, tag: el.tag, role: el.role, text };
    });
    // Recalculate top 5
    const scored = currentDomData.elements.map((el: any, index: number) => {
      const elText = (el.text || el.ariaLabel || el.label || "").toLowerCase().trim().replace(/\s+/g, ' ');
      let score = 0;
      const cleanExpected = normalizedExpected.replace(/\b(the|button|element)\b/g, "").trim();
      const cleanElText = elText.replace(/\b(the|button|element)\b/g, "").trim();
      if (elText === normalizedExpected && elText.length > 0) score += 50;
      else if (cleanElText && cleanElText === cleanExpected) score += 40;
      else if (elText && normalizedExpected && (elText.includes(normalizedExpected) || normalizedExpected.includes(elText))) score += 20;
      
      if (expectedTag && el.tag === expectedTag) score += 10;
      if (expectedRole && el.role === expectedRole) score += 10;
      
      if (cleanExpected.includes("save") || cleanExpected.includes("preview") || cleanExpected.includes("submit")) {
        if (el.tag === "button" || el.role === "button") score += 30;
      }
      if (plannedAction.action.type === "click" || cleanExpected.includes("button")) {
        if (["input", "textarea", "select"].includes(el.tag)) {
          if (!(el.tag === "input" && (el.type === "submit" || el.type === "button"))) {
             score -= 100;
          }
        }
      }
      return { index, score, tag: el.tag, text: elText };
    }).sort((a: any, b: any) => b.score - a.score);
    top5 = scored.slice(0, 5);
  }
  
  console.log("[KAMNAA GROUNDING FAILURE TRACE]\n" + JSON.stringify({
    "1. original LLM target": llmTarget,
    "2. targetDescription": targetDesc || "MISSING",
    "3. action type": plannedAction.action.type,
    "4. original target index": diagnosticLog.originalTargetIndex,
    "5. current interactive element count": currentDomData?.elements?.length || 0,
    "6. element at original index": originalEl ? true : false,
    "7. element tag": originalEl?.tag || null,
    "8. element role": originalEl?.role || null,
    "9. element text": originalEl?.text || null,
    "10. element aria-label": originalEl?.ariaLabel || null,
    "11. element bounding rectangle": originalEl?.bounds || null,
    "12. whether element is visible": originalEl?.isVisible,
    "13. whether element is enabled": originalEl?.isDisabled === false,
    "14. whether targetDescription semantic matching was attempted": !!normalizedExpected,
    "15. semantic score": top5.length > 0 ? top5[0].score : null,
    "16. grounding threshold": "> 0",
    "17. all candidate elements considered": allCandidates.length,
    "18. top 5 candidate scores": top5,
    "19. final grounding decision": "grounding_failed",
    "20. exact reason for grounding_failed": "No element scored > 0",
    "CACHE STATE": currentDomData?.metadata?.cacheState || "unknown"
  }, null, 2));
  // --- END DEEP FAILURE DIAGNOSTIC ---

  console.log(`[KAMNAA DIAGNOSTIC] Grounding:`, JSON.stringify(diagnosticLog));
  return { success: false, groundedTarget: "", reason: "grounding_failed", diagnostic: diagnosticLog };
}
