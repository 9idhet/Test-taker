const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const users = {};

function getUser(id) {
  if (!users[id]) users[id] = { uses: 0, subscribed: false };
  return users[id];
}

app.get("/", (req, res) => {
  res.json({ status: "Test Taker API running", modes: ["TEST_MAPPING", "STUDY"] });
});

app.get("/api/usage/:userId", (req, res) => {
  const u = getUser(req.params.userId);
  res.json({ uses: u.uses, freeUsesLeft: Math.max(0, 3 - u.uses), subscribed: u.subscribed, canUse: u.subscribed || u.uses < 3 });
});

app.post("/api/solve", async (req, res) => {
  try {
    const { userId, subject, text } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const u = getUser(userId);
    if (!u.subscribed && u.uses >= 3) return res.status(402).json({ error: "upgrade_required" });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      messages: [{ role: "user", content: `You are an expert ${subject} test solver. Read this test and answer every single question. Format each answer as Q1: C or Q2: B - explanation. No intro, just answers.\n\nTest:\n${text}` }]
    });

    const raw = message.content.map(b => b.text || "").join("").trim();
    const answers = [];
    for (const line of raw.split("\n")) {
      const m = line.trim().match(/^Q(\d+):\s*(.+)/i);
      if (m) answers.push({ q: parseInt(m[1]), a: m[2].trim(), conf: 95 });
    }

    if (!u.subscribed) users[userId].uses += 1;
    res.json({ answers, usesLeft: Math.max(0, 3 - users[userId].uses) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/map", async (req, res) => {
  try {
    const { userId, subject, text } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const u = getUser(userId);
    if (!u.subscribed && u.uses >= 3) return res.status(402).json({ error: "upgrade_required" });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: `Analyze this ${subject} test. Find all passages (label A, B, C), images (label 1, 2, 3), and questions. Map which passage and image each question belongs to. Output only a JSON array: [{"question":1,"linked_passage":"A","linked_image":null,"standalone":false,"confidence":95,"reason":"why"}]. Include every question.\n\nTest:\n${text}` }]
    });

    const raw = message.content.map(b => b.text || "").join("").trim();
    let mappings = [];
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try { mappings = JSON.parse(match[0]); } catch(e) {}
    }

    if (!u.subscribed) users[userId].uses += 1;
    res.json({ mappings, usesLeft: Math.max(0, 3 - users[userId].uses) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/quiz/generate", async (req, res) => {
  try {
    const { userId, subject, text } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const u = getUser(userId);
    if (!u.subscribed && u.uses >= 3) return res.status(402).json({ error: "upgrade_required" });

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      messages: [{ role: "user", content: `You are a ${subject} teacher. Create a 10-question quiz from this material. 30% easy, 40% medium, 30% hard. Output only JSON: {"topics":["Topic"],"quiz":[{"id":1,"question":"?","options":["A) ","B) ","C) ","D) "],"correct":"A","topic":"Topic","difficulty":"easy","explanation":"why"}]}\n\nMaterial:\n${(text||"").substring(0,15000)}` }]
    });

    const raw = message.content.map(b => b.text || "").join("").trim();
    let quizData = null;
    try { quizData = JSON.parse(raw.replace(/```json|```/gi, "").trim()); } catch(e) {}
    if (!quizData) return res.status(500).json({ error: "Could not parse quiz" });

    if (!u.subscribed) users[userId].uses += 1;
    res.json({ quizData, usesLeft: Math.max(0, 3 - users[userId].uses) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/study/analyze", async (req, res) => {
  try {
    const { userId, subject, quizResults } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const correct = quizResults.filter(r => r.isCorrect).length;
    const accuracy = Math.round((correct / quizResults.length) * 100);
    const weak = [...new Set(quizResults.filter(r => !r.isCorrect).map(r => r.topic))];
    const strong = [...new Set(quizResults.filter(r => r.isCorrect).map(r => r.topic))];

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      messages: [{ role: "user", content: `You are a tutor. Student scored ${accuracy}% on ${subject}. Weak: ${weak.join(", ")||"none"}. Strong: ${strong.join(", ")||"none"}. Output only JSON: {"performance":{"accuracy":${accuracy},"strong_topics":${JSON.stringify(strong)},"weak_topics":${JSON.stringify(weak)},"recommendation":"one sentence"},"study_guide":[{"topic":"name","priority":"high","explanation":"2-3 sentences","example":"example","practice_questions":[{"q":"question","a":"answer"}]}]}` }]
    });

    const raw = message.content.map(b => b.text || "").join("").trim();
    let studyData = null;
    try { studyData = JSON.parse(raw.replace(/```json|```/gi, "").trim()); } catch(e) {}
    if (!studyData) return res.status(500).json({ error: "Could not parse study guide" });

    res.json({ studyData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/subscribe", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!users[userId]) users[userId] = { uses: 0, subscribed: false };
  users[userId].subscribed = true;
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Test Taker API on port ${PORT}`));
