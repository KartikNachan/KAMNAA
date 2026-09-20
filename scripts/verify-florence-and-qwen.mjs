import { AutoProcessor, RawImage } from "@huggingface/transformers";

async function runVerification() {
  console.log("==================================================");
  console.log("1. VERIFYING FLORENCE-2 PROCESSOR API");
  console.log("==================================================");

  const processor = await AutoProcessor.from_pretrained("onnx-community/Florence-2-base-ft");
  
  // 100x100 RGB image
  const rawImage = new RawImage(new Uint8Array(100 * 100 * 3), 100, 100, 3);
  
  // Test 1: Object Detection
  const odInputs = await processor(rawImage, "<OD>");
  console.log("processor(image, '<OD>') SUCCESS: keys =", Object.keys(odInputs));

  // Test 2: OCR with Region
  const ocrInputs = await processor(rawImage, "<OCR_WITH_REGION>");
  console.log("processor(image, '<OCR_WITH_REGION>') SUCCESS: keys =", Object.keys(ocrInputs));

  // Test 3: Phrase Grounding
  const pgInputs = await processor(rawImage, "<CAPTION_TO_PHRASE_GROUNDING>verify button");
  console.log("processor(image, '<CAPTION_TO_PHRASE_GROUNDING>verify button') SUCCESS: keys =", Object.keys(pgInputs));

  console.log("\n==================================================");
  console.log("2. VERIFYING FLORENCE-2 OUTPUT POST-PROCESSING");
  console.log("==================================================");
  const sampleDecoded = "button<loc_50><loc_100><loc_200><loc_300>input<loc_350><loc_100><loc_450><loc_500>";
  const postProcessed = processor.post_process_generation(sampleDecoded, "<OD>", [800, 1200]);
  console.log("processor.post_process_generation output:", JSON.stringify(postProcessed));
  
  const odData = postProcessed["<OD>"];
  const elements = [];
  for (let i = 0; i < odData.bboxes.length; i++) {
    const [y1, x1, y2, x2] = odData.bboxes[i];
    elements.push({
      label: odData.labels[i],
      box: {
        x: Math.round(x1),
        y: Math.round(y1),
        w: Math.round(x2 - x1),
        h: Math.round(y2 - y1)
      }
    });
  }
  console.log("Parsed visual elements count:", elements.length);
  console.log("Parsed visual elements:", JSON.stringify(elements));

  console.log("\n==================================================");
  console.log("3. VERIFYING OLLAMA & QWEN 2.5 3B INFERENCE");
  console.log("==================================================");

  // Probe Ollama /api/tags
  const tagsResp = await fetch("http://localhost:11434/api/tags");
  const tagsData = await tagsResp.json();
  const models = (tagsData.models || []).map(m => m.name);
  const foundModel = models.find(m => m.includes("qwen2.5:3b")) || models[0];
  console.log(`[KAMNAA] Ollama probe:\navailable=${tagsResp.ok}\nmodel=${foundModel}`);

  // Ollama Chat Call
  const payload = {
    model: "qwen2.5:3b",
    messages: [
      {
        role: "system",
        content: `You are an AI action planner for web tasks.
Given a user task and sanitized page state, output a JSON plan.
Respond ONLY with valid JSON.`
      },
      {
        role: "user",
        content: `TASK: "Find the Verify button and click it."
PAGE STATE:
Domain: verification.portal
Title: Verify Identity
Total elements: 1

ELEMENTS:
[1] button "Verify" (x: 40, y: 120, w: 240, h: 40)

Generate the action plan as JSON.`
      }
    ],
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 512,
      top_p: 0.9
    }
  };

  console.log("[KAMNAA] Ollama planner call:\nattempting=true\nmodel=qwen2.5:3b");
  const t0 = Date.now();
  const chatResp = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const chatData = await chatResp.json();
  const elapsed = Date.now() - t0;
  console.log(`[KAMNAA] Ollama planner response:\nsuccess=${chatResp.ok}\nstatus=${chatResp.status} (${elapsed}ms)`);
  
  const content = chatData.message?.content || "";
  console.log("RAW LLM CONTENT:", JSON.stringify(content));

  // Parse response
  const jsonMatch = content.match(/```(?:json)?\s*([\{\[][\s\S]*?[\}\]])\s*```/i) || [null, content];
  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonMatch[1].trim());
  } catch (e) {
    const startIdx = content.indexOf("{");
    const endIdx = content.lastIndexOf("}");
    parsedJson = JSON.parse(content.substring(startIdx, endIdx + 1));
  }

  const rawSteps = Array.isArray(parsedJson)
    ? parsedJson
    : (parsedJson.steps || parsedJson.actions || (parsedJson.action || parsedJson.type ? [parsedJson] : []));
  console.log(`[KAMNAA] Ollama parsed plan:\nsteps=${rawSteps.length}`);
  console.log(`[KAMNAA] Planner final:\nprovider=ollama\nsteps=${rawSteps.length}`);
}

runVerification().catch(console.error);
