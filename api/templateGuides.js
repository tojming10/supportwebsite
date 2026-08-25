const fs = require("fs");
const path = require("path");

const TEMPLATE_FILE = path.join(__dirname, "templates", "deryan.txt");
const MAX_TEMPLATE_SECTIONS = 5;
const MAX_TEMPLATE_CHARS = 18000;

let cachedTemplates;

function buildTemplateContext(message) {
  const templates = loadTemplates();
  if (!templates.length) {
    return { sections: [], fullText: "" };
  }

  const keywords = importantWords(message);
  const scored = templates
    .map((template) => ({
      ...template,
      score: scoreTemplate(template, keywords),
    }))
    .filter((template) => template.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TEMPLATE_SECTIONS);

  let fullText = "";
  const sections = [];

  for (const template of scored) {
    const entry = `TEMPLATE TOPIC: ${template.topic}\n${template.text}\n\n`;
    if (fullText.length + entry.length > MAX_TEMPLATE_CHARS) break;
    fullText += entry;
    sections.push(template);
  }

  return { sections, fullText: fullText.trim() };
}

function loadTemplates() {
  if (cachedTemplates) return cachedTemplates;

  try {
    const raw = fs.readFileSync(TEMPLATE_FILE, "utf8");
    cachedTemplates = parseTemplates(raw);
  } catch {
    cachedTemplates = [];
  }

  return cachedTemplates;
}

function parseTemplates(raw) {
  return String(raw || "")
    .split(/\n\s*_{8,}\s*\n/g)
    .map((section) => cleanText(section))
    .filter((section) => section.length > 40)
    .map((section, index) => ({
      topic: extractTopic(section, index),
      text: section,
    }));
}

function extractTopic(section, index) {
  const lines = section.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const firstKeywordLine = lines.find((line) => {
    if (/^(hello|hi|dear|thank you|sincerely|team deryan)\b/i.test(line)) return false;
    if (/^https?:\/\//i.test(line)) return false;
    return line.length <= 80 && /[a-z]/i.test(line);
  });

  return firstKeywordLine || `Template ${index + 1}`;
}

function scoreTemplate(template, keywords) {
  const haystack = `${template.topic}\n${template.text}`.toLowerCase();
  return keywords.reduce((score, keyword) => {
    const topicHit = template.topic.toLowerCase().includes(keyword) ? 4 : 0;
    const textHit = haystack.includes(keyword) ? 1 : 0;
    return score + topicHit + textHit;
  }, 0);
}

function importantWords(text) {
  const stopWords = new Set([
    "about", "after", "again", "also", "because", "before", "could", "email", "from",
    "have", "help", "into", "just", "like", "need", "please", "question", "support", "that",
    "their", "there", "this", "want", "what", "when", "where", "with", "would", "your",
  ]);

  return cleanText(text)
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((word) => !stopWords.has(word))
    .slice(0, 50) || [];
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

module.exports = { buildTemplateContext };
