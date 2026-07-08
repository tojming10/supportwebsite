const MAX_DISCOVERED_LINKS_PER_REFERENCE = 8;
const MAX_TOTAL_SOURCES = 18;
const MAX_TEXT_PER_SOURCE = 12000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to create a draft." });
  }

  try {
    const payload = normalizePayload(request.body || {});
    if (!payload.message) {
      return response.status(400).json({ error: "Paste the customer question or email first." });
    }

    const sources = await collectSources(payload.references);
    const relevantSections = findRelevantSections(payload.message, sources);
    const draft = process.env.OPENAI_API_KEY
      ? await draftWithOpenAI(payload, relevantSections)
      : draftWithLocalRules(payload, relevantSections);

    return response.status(200).json({
      draft,
      sources: sources.map(({ url, title, status, error }) => ({ url, title, status, error })),
    });
  } catch (error) {
    return response.status(500).json({ error: error.message || "Something went wrong while drafting." });
  }
};

function normalizePayload(body) {
  return {
    message: String(body.message || "").trim(),
    references: Array.isArray(body.references)
      ? body.references.map((reference) => String(reference || "").trim()).filter(Boolean)
      : [],
    tone: String(body.tone || "Warm, clear, and professional"),
    priority: String(body.priority || "Normal"),
    agentName: String(body.agentName || "Support Team").trim(),
    companyName: String(body.companyName || "Your Company").trim(),
    mode: body.mode === "email" ? "email" : "chat",
  };
}

async function collectSources(references) {
  const seeds = references.length ? references : [];
  const sourceMap = new Map();

  for (const reference of seeds) {
    if (isUrl(reference)) {
      addUrl(sourceMap, reference);
    } else {
      sourceMap.set(`note:${sourceMap.size}`, {
        url: "Manual reference note",
        title: "Manual reference note",
        text: reference,
        status: "fetched",
      });
    }
  }

  const seedUrls = [...sourceMap.values()].filter((source) => source.pending).map((source) => source.url);
  for (const url of seedUrls) {
    if (sourceMap.size >= MAX_TOTAL_SOURCES) break;
    const page = await fetchPage(url);
    Object.assign(sourceMap.get(normalizeUrl(url)), page, { pending: false });

    if (page.status !== "fetched") continue;
    const links = discoverArticleLinks(url, page.html)
      .filter((link) => !sourceMap.has(normalizeUrl(link)))
      .slice(0, MAX_DISCOVERED_LINKS_PER_REFERENCE);

    for (const link of links) {
      if (sourceMap.size >= MAX_TOTAL_SOURCES) break;
      addUrl(sourceMap, link);
    }
  }

  const pendingSources = [...sourceMap.values()].filter((source) => source.pending);
  await Promise.all(
    pendingSources.map(async (source) => {
      const page = await fetchPage(source.url);
      Object.assign(source, page, { pending: false });
    }),
  );

  return [...sourceMap.values()].map((source) => {
    delete source.html;
    delete source.pending;
    return source;
  });
}

function addUrl(sourceMap, url) {
  const normalized = normalizeUrl(url);
  if (!sourceMap.has(normalized)) {
    sourceMap.set(normalized, { url: normalized, title: normalized, text: "", status: "pending", pending: true });
  }
}

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const result = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "SupportDraftBot/1.0",
        accept: "text/html, text/plain;q=0.9, */*;q=0.8",
      },
    });
    clearTimeout(timeout);

    if (!result.ok) {
      return { status: "failed", error: `HTTP ${result.status}`, text: "", title: url };
    }

    const contentType = result.headers.get("content-type") || "";
    const raw = await result.text();
    const html = contentType.includes("html") ? raw : "";
    const title = html ? extractTitle(html) || url : url;
    const text = html ? extractReadableText(html) : cleanText(raw);

    return {
      status: text ? "fetched" : "failed",
      error: text ? undefined : "No readable page text found.",
      html,
      title,
      text: text.slice(0, MAX_TEXT_PER_SOURCE),
      url,
    };
  } catch (error) {
    return { status: "failed", error: error.name === "AbortError" ? "Timed out" : error.message, text: "", title: url };
  }
}

function discoverArticleLinks(baseUrl, html) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => {
      try {
        return new URL(decodeHtml(match[1]), base).toString();
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .map(normalizeUrl)
    .filter((url) => {
      const current = new URL(url);
      if (current.hostname !== base.hostname) return false;
      if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mov)$/i.test(current.pathname)) return false;
      if (basePath && basePath !== "/" && !current.pathname.startsWith(basePath.split("/").slice(0, 2).join("/"))) return false;
      return /article|help|support|docs|guide|faq|kb|knowledge|policy|troubleshoot/i.test(current.pathname);
    });

  return [...new Set(links)];
}

function findRelevantSections(message, sources) {
  const keywords = importantWords(message);
  const sections = [];

  for (const source of sources.filter((item) => item.status === "fetched" && item.text)) {
    const paragraphs = source.text
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 50);

    for (const paragraph of paragraphs) {
      const score = scoreText(paragraph, keywords);
      if (score > 0) {
        sections.push({
          score,
          title: source.title,
          url: source.url,
          text: paragraph.slice(0, 900),
        });
      }
    }
  }

  const ranked = sections.sort((a, b) => b.score - a.score).slice(0, 8);
  if (ranked.length) return ranked;

  return sources
    .filter((source) => source.status === "fetched" && source.text)
    .slice(0, 5)
    .map((source) => ({
      score: 0,
      title: source.title,
      url: source.url,
      text: source.text.slice(0, 900),
    }));
}

async function draftWithOpenAI(payload, sections) {
  const context = sections
    .map((section, index) => `[${index + 1}] ${section.title}\n${section.url}\n${section.text}`)
    .join("\n\n");

  const prompt = `Create a ready-to-send ${payload.mode} support response.

Requirements:
- Use only the reference content provided below.
- If the references do not answer something, say what detail must be confirmed.
- Keep the tone ${payload.tone}.
- Priority: ${payload.priority}.
- Sign as ${payload.agentName}, ${payload.companyName} Support.
- Do not include internal notes.

Customer message:
${payload.message}

Reference content:
${context || "No readable reference content was found."}`;

  const result = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      temperature: 0.2,
    }),
  });

  if (!result.ok) {
    const errorText = await result.text();
    throw new Error(`AI drafting failed: ${errorText}`);
  }

  const data = await result.json();
  return data.output_text || "No draft was returned.";
}

function draftWithLocalRules(payload, sections) {
  const needs = detectNeeds(payload.message);
  const usefulFacts = sections.length
    ? sections.map((section, index) => `${index + 1}. ${section.text}\nSource: ${section.title} - ${section.url}`).join("\n\n")
    : "No readable article content was found from the provided references.";

  if (payload.mode === "email") {
    return `Subject: Re: Support request

Hi there,

Thank you for contacting ${payload.companyName} Support. I reviewed the available reference content and can help with this.

Based on your message, I understand the issue as:
"${summarizeIssue(payload.message)}"

Here is the most relevant information I found:
${usefulFacts}

To make sure I give you the correct final answer, please send:
- ${needs.join("\n- ")}

Once I have those details, I can confirm the exact next step.

Best,
${payload.agentName}
${payload.companyName} Support`;
  }

  return `Hi, thanks for reaching out. I reviewed the available support content and can help with this.

From your message, it sounds like: "${summarizeIssue(payload.message)}"

Here is the most relevant information I found:
${usefulFacts}

Could you also send:
- ${needs.join("\n- ")}

Once I have that, I can confirm the best next step.

${payload.agentName}
${payload.companyName} Support`;
}

function importantWords(text) {
  const stopWords = new Set([
    "about", "after", "again", "also", "because", "before", "could", "email", "error", "from",
    "have", "help", "into", "just", "like", "need", "please", "question", "support", "that",
    "their", "there", "this", "want", "what", "when", "where", "with", "would", "your",
  ]);

  return cleanText(text)
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((word) => !stopWords.has(word))
    .slice(0, 40) || [];
}

function scoreText(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0);
}

function extractTitle(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  return cleanText(decodeHtml(title)).slice(0, 140);
}

function extractReadableText(html) {
  const main =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ||
    html;

  return cleanText(
    main
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|h1|h2|h3|h4|tr|section|div)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function cleanText(text) {
  return decodeHtml(String(text || ""))
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function summarizeIssue(message) {
  const trimmed = cleanText(message).replace(/\s+/g, " ");
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed;
}

function detectNeeds(message) {
  const lower = message.toLowerCase();
  const needs = [];

  if (lower.includes("error") || lower.includes("bug") || lower.includes("failed")) {
    needs.push("the exact error message or a screenshot");
  }
  if (lower.includes("login") || lower.includes("password") || lower.includes("account")) {
    needs.push("the account email or user ID");
  }
  if (lower.includes("billing") || lower.includes("invoice") || lower.includes("refund")) {
    needs.push("the invoice number, charge date, or billing email");
  }
  if (lower.includes("slow") || lower.includes("loading") || lower.includes("browser")) {
    needs.push("browser, device, and approximate time the issue happened");
  }

  return needs.length ? needs : ["the affected account, exact steps taken, and any screenshot or error text"];
}
