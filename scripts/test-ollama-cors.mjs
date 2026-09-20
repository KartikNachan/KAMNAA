import http from "http";

const payload = {
  model: "qwen2.5:3b",
  messages: [{ role: "user", content: "hi" }],
  stream: false
};

async function testOllamaCORS() {
  console.log("Testing without Origin header...");
  const resp1 = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  console.log("Without Origin status:", resp1.status);

  console.log("Testing WITH chrome-extension:// Origin header...");
  const resp2 = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Origin": "chrome-extension://abcdefghijklmnop"
    },
    body: JSON.stringify(payload)
  });
  console.log("With Origin status:", resp2.status);
  
  if (!resp2.ok) {
    console.log("Response text:", await resp2.text());
  }
}

testOllamaCORS().catch(console.error);
