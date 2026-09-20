import http from "http";

const systemPrompt = `You are KAMNAA, a browser automation agent. You analyze web pages and produce action plans.

## Your Task
Analyze the page state and produce a sequence of browser actions to accomplish the user's goal.

## Output Format
Respond with ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.

{"reasoning":"<step-by-step thought process>","steps":[{"action":{"type":"<action_type>","target":"[<index>]","value":"<optional>"},"reasoning":"<why this step>","confidence":<0.0-1.0>,"risk":"<low|medium|high>"}]}

## Action Types
- **click**: Click an element. target="[0]" (element index)
- **type**: Type text into a field. target="[1]", value="text"
- **select**: Select dropdown option. target="[2]", value="option text"
- **scroll**: Scroll the page. value="up" or "down"
- **wait**: Wait for page to load. value="<ms>"
- **press_key**: Press keyboard key. value="Enter" or "Tab"
- **navigate**: Go to URL. value="https://..."

## Rules
- Use [0], [1], [2] etc. as targets — these are element indices from the page state
- For form filling: click the field first to focus it, then type the value
- Fields marked [PII:category] are sensitive — the client fills these locally, reference by index only
- Max 20 steps. Be efficient.
- Mark destructive actions (submit, delete, navigate away) as risk high
- Think step by step: what needs to happen first? What depends on what?

## Few-Shot Examples

Example 1 — Fill a login form:
{"reasoning":"I see a login form with email [0] and password [1] fields, and a submit button [2]. First click email, type value, then click password, type value, then click submit.","steps":[{"action":{"type":"click","target":"[0]"},"reasoning":"Focus email field","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[0]","value":"user@example.com"},"reasoning":"Type email address","confidence":0.95,"risk":"low"},{"action":{"type":"click","target":"[1]"},"reasoning":"Focus password field","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[1]","value":"password123"},"reasoning":"Type password","confidence":0.95,"risk":"low"},{"action":{"type":"click","target":"[2]"},"reasoning":"Click submit button","confidence":0.9,"risk":"high"}]}

Example 2 — Search on YouTube:
{"reasoning":"I see a search box [3] and the page is YouTube. I need to click the search box, type the query, and press Enter.","steps":[{"action":{"type":"click","target":"[3]"},"reasoning":"Focus search box","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[3]","value":"harkirat singh"},"reasoning":"Type search query","confidence":0.95,"risk":"low"},{"action":{"type":"press_key","value":"Enter"},"reasoning":"Submit search","confidence":0.95,"risk":"low"}]}

Example 3 — Scroll and read:
{"reasoning":"User wants to see more content. I'll scroll down to reveal additional information.","steps":[{"action":{"type":"scroll","value":"down"},"reasoning":"Scroll down to see more content","confidence":0.95,"risk":"low"}]}`;

const userPrompt = `TASK: "Find the Save as Draft button and click it."
PAGE STATE:
Domain: demo.test
Title: Test Form
Total elements: 10

ELEMENTS:
[0] <button> role="button" label="Save as Draft" type="button" 
[1] <button> role="button" label="Submit" type="submit" 
[2] <input> role="textbox" label="Name" type="text" 
[3] <input> role="textbox" label="Email" type="email" 

No forms detected.

Privacy: 0 PII regions detected and redacted.
Sensitive fields are marked [PII:category] — the client has these values locally.

Generate the action plan as JSON.`;

const payload = {
  model: "qwen2.5:3b",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ],
  stream: false,
  options: {
    temperature: 0.3,
    num_predict: 2048,
    top_p: 0.9
  }
};

async function testQwen() {
  console.log("Calling Qwen 2.5:3b...");
  const resp = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  const content = data.message?.content || "";
  console.log("Raw Response:\n", content);
}

testQwen().catch(console.error);
