const MAX_TOTAL_SOURCES = 20;
const MAX_CRAWL_DEPTH = 1;
const MAX_STORED_TEXT_PER_SOURCE = 30000;
const MAX_CONTEXT_TEXT_PER_SOURCE = 10000;
const MAX_CONTEXT_CHARS = 60000;
const FETCH_TIMEOUT_MS = 4500;
const OPENAI_TIMEOUT_MS = 14000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const { isDatabaseConfigured, searchReferences, upsertReference } = require("./db");

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

    const storedSources = payload.useKnowledgeBase ? await collectStoredSources(payload.message) : [];
    const liveSources = await collectSources(payload.references);
    const sources = mergeSources(storedSources, liveSources);
    const context = buildKnowledgeContext(payload.message, sources);
    const { draft, warning } = await createDraft(payload, context);

    return response.status(200).json({
      draft: draft || draftWithLocalRules(payload, context),
      warning,
      diagnostics: {
        openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
        databaseConfigured: isDatabaseConfigured(),
        crawledPages: context.allSources.length,
        includedPages: context.includedSources.length,
      },
      sources: sources.map(({ url, title, status, error, depth }) => ({ url, title, status, error, depth })),
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
    useKnowledgeBase: body.useKnowledgeBase !== false,
  };
}

async function collectStoredSources(message) {
  if (!isDatabaseConfigured()) return [];

  try {
    const references = await searchReferences(message, 16);
    const sources = [];

    for (const reference of references) {
      sources.push(await refreshThinReference(reference));
    }

    return sources;
  } catch {
    return [];
  }
}

async function refreshThinReference(reference) {
  const source = {
    url: reference.url,
    title: reference.title || reference.url,
    text: reference.content || "",
    status: reference.status || "fetched",
    error: reference.error,
    depth: 0,
    stored: true,
  };

  if ((source.text || "").length >= 700 || !isUrl(source.url)) {
    return source;
  }

  try {
    const refreshed = (await collectSources([source.url], { maxTotalSources: 1, maxCrawlDepth: 0 }))[0];
    if (refreshed?.text && refreshed.text.length > source.text.length) {
      await upsertReference({
        url: refreshed.url,
        normalized_url: normalizeUrl(refreshed.url),
        title: refreshed.title || refreshed.url,
        content: refreshed.text,
        status: refreshed.status || "fetched",
        error: refreshed.error || null,
        tags: reference.tags || "",
        source_type: reference.source_type || "article",
        last_synced_at: new Date().toISOString(),
      });

      return {
        url: refreshed.url,
        title: refreshed.title || refreshed.url,
        text: refreshed.text,
        status: refreshed.status || "fetched",
        error: refreshed.error,
        depth: 0,
        stored: true,
      };
    }
  } catch {
    return source;
  }

  return source;
}

function mergeSources(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const source of group) {
      if (!source.url) continue;
      const key = source.url === "Manual reference note" ? `${source.url}:${map.size}` : normalizeUrl(source.url);
      if (!map.has(key)) {
        map.set(key, source);
      }
    }
  }

  return [...map.values()];
}

async function createDraft(payload, context) {
  if (!process.env.OPENAI_API_KEY) {
    return { draft: draftWithLocalRules(payload, context) };
  }

  try {
    const draft = await draftWithOpenAI(payload, context);
    if (!draft || draft.trim().length < 20) {
      throw new Error("OpenAI returned an empty draft.");
    }

    return { draft };
  } catch (error) {
    return {
      draft: draftWithLocalRules(payload, context),
      warning: `AI drafting was unavailable, so a rule-based draft was created instead. ${friendlyOpenAIError(error)}`,
    };
  }
}

function friendlyOpenAIError(error) {
  const message = String(error.message || "");
  if (/invalid_api_key|incorrect api key/i.test(message)) {
    return "Check the OPENAI_API_KEY value in Vercel.";
  }
  if (/model|does not exist|access/i.test(message)) {
    return "Check the OPENAI_MODEL value or model access for this API key.";
  }
  if (/abort|timed out|timeout/i.test(message)) {
    return "The AI request timed out.";
  }
  return "Check the OpenAI environment variables in Vercel.";
}

async function collectSources(references, options = {}) {
  const maxTotalSources = options.maxTotalSources || MAX_TOTAL_SOURCES;
  const maxCrawlDepth = options.maxCrawlDepth ?? MAX_CRAWL_DEPTH;
  const seeds = references.length ? references : [];
  const sourceMap = new Map();
  const queue = [];

  for (const reference of seeds) {
    if (isUrl(reference)) {
      addUrl(sourceMap, queue, reference, 0);
    } else {
      sourceMap.set(`note:${sourceMap.size}`, {
        url: "Manual reference note",
        title: "Manual reference note",
        text: reference,
        status: "fetched",
        depth: 0,
      });
    }
  }

  while (queue.length && sourceMap.size <= maxTotalSources) {
    const batch = queue.splice(0, 6);
    const pages = await Promise.all(
      batch.map(async ({ url, depth }) => ({
        url,
        depth,
        page: await fetchPage(url),
      })),
    );

    for (const { url, depth, page } of pages) {
      const current = sourceMap.get(normalizeUrl(url));
      if (!current) continue;

      Object.assign(current, page, { depth, pending: false });

      if (page.status !== "fetched" || depth >= maxCrawlDepth) continue;

      for (const link of discoverInternalLinks(url, page.html)) {
        if (sourceMap.size >= maxTotalSources) break;
        addUrl(sourceMap, queue, link, depth + 1);
      }
    }
  }

  return [...sourceMap.values()].map((source) => {
    delete source.html;
    delete source.pending;
    return source;
  });
}

function addUrl(sourceMap, queue, url, depth) {
  const normalized = normalizeUrl(url);
  if (!sourceMap.has(normalized) && shouldCrawlUrl(normalized)) {
    sourceMap.set(normalized, { url: normalized, title: normalized, text: "", status: "pending", pending: true, depth });
    queue.push({ url: normalized, depth });
  }
}

async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
      text: text.slice(0, MAX_STORED_TEXT_PER_SOURCE),
      url,
    };
  } catch (error) {
    return { status: "failed", error: error.name === "AbortError" ? "Timed out" : error.message, text: "", title: url };
  }
}

function discoverInternalLinks(baseUrl, html) {
  const base = new URL(baseUrl);
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
      return shouldCrawlUrl(url);
    });

  return [...new Set(links)];
}

function shouldCrawlUrl(value) {
  const url = new URL(value);
  const path = url.pathname.toLowerCase();
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mov|avi|css|js|ico|woff|woff2|ttf)$/i.test(path)) return false;
  if (/\/(login|logout|signup|sign-up|register|cart|checkout|account|admin|wp-admin|search)\b/i.test(path)) return false;
  if (url.search && /(\?|&)(replytocom|share|utm_|fbclid|gclid|sort|filter)=/i.test(url.search)) return false;
  return true;
}

function buildKnowledgeContext(message, sources) {
  const keywords = importantWords(message);
  const wantsProcedure = isProcedureRequest(message);
  const sections = [];
  const fetchedSources = sources.filter((item) => item.status === "fetched" && item.text);

  for (const source of fetchedSources) {
    const paragraphs = splitParagraphs(source.text);
    const sourceScore = scoreSource(source, keywords);

    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index];
      const score = scoreText(paragraph, keywords);
      if (score > 0) {
        const windowText = buildInstructionWindow(paragraphs, index);
        sections.push({
          score: score + sourceScore + instructionScore(windowText) + actionScore(windowText, wantsProcedure),
          title: source.title,
          url: source.url,
          text: windowText.slice(0, 3000),
        });
      }
    }
  }

  const rankedSections = dedupeSections(sections).sort((a, b) => b.score - a.score).slice(0, 12);
  const rankedUrls = new Set(rankedSections.map((section) => section.url));
  const orderedSources = [
    ...fetchedSources.filter((source) => rankedUrls.has(source.url)),
    ...fetchedSources.filter((source) => !rankedUrls.has(source.url)),
  ];

  let fullText = "";
  const includedSources = [];

  for (const source of orderedSources) {
    const sourceHighlights = rankedSections
      .filter((section) => section.url === source.url)
      .map((section) => section.text)
      .join("\n\n");
    const sourceText = sourceHighlights
      ? `Most relevant instruction passages:\n${sourceHighlights}\n\nBroader article content:\n${source.text}`
      : source.text;
    const entry = `SOURCE: ${source.title}\nURL: ${source.url}\nCONTENT:\n${sourceText.slice(0, MAX_CONTEXT_TEXT_PER_SOURCE)}\n\n`;
    if (fullText.length + entry.length > MAX_CONTEXT_CHARS) break;
    fullText += entry;
    includedSources.push(source);
  }

  return {
    allSources: fetchedSources,
    includedSources,
    relevantSections: rankedSections,
    fullText,
  };
}

function isProcedureRequest(message) {
  return /\b(how|steps?|step-by-step|guide|instructions?|setup|configure|create|add|update|reset|fix|troubleshoot)\b/i.test(message);
}

function scoreSource(source, keywords) {
  const titleAndUrl = `${source.title || ""} ${source.url || ""}`;
  const titleScore = scoreText(titleAndUrl, keywords) * 3;
  const seedBoost = source.depth === 0 ? 4 : 0;
  const storedBoost = source.stored ? 2 : 0;
  const depthPenalty = Math.max(0, Number(source.depth || 0)) * -2;
  return titleScore + seedBoost + storedBoost + depthPenalty;
}

function splitParagraphs(text) {
  return cleanText(text)
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 25)
    .filter((paragraph) => !isNoiseParagraph(paragraph));
}

function isNoiseParagraph(text) {
  const value = text.trim();
  if (/^(-\s*)?(skip to|on this page|in this article|site navigation|product navigation)/i.test(value)) return true;
  if (/^(←|→|previous:|next:)/i.test(value)) return true;
  if (value === "#") return true;
  if (/,\s*\d+\s+of\s+\d+$/i.test(value)) return true;
  if (/^(-\s*)?(github|twitter|linkedin|youtube|terms|privacy|status|pricing)$/i.test(value)) return true;
  if (value.length < 90 && /^-\s+/.test(value) && !/[.!?:]$/.test(value)) return true;
  return false;
}

function buildInstructionWindow(paragraphs, matchIndex) {
  let start = Math.max(0, matchIndex - 2);
  let end = Math.min(paragraphs.length - 1, matchIndex + 6);

  while (start > 0 && isInstructionLine(paragraphs[start - 1]) && matchIndex - start < 6) {
    start -= 1;
  }

  while (end < paragraphs.length - 1 && isInstructionLine(paragraphs[end + 1]) && end - matchIndex < 10) {
    end += 1;
  }

  return paragraphs.slice(start, end + 1).join("\n");
}

function isInstructionLine(text) {
  return /^(\d+[\.)]|[-*•]|step\s+\d+|note:|important:|warning:)/i.test(text.trim());
}

function instructionScore(text) {
  const lines = text.split(/\n+/).filter(Boolean);
  const instructionLines = lines.filter(isInstructionLine).length;
  return Math.min(5, instructionLines);
}

function actionScore(text, wantsProcedure) {
  if (!wantsProcedure) return 0;
  const actionMatches = text.match(/\b(click|select|choose|type|enter|open|navigate|go to|copy|paste|save|submit|create|add|enable|disable|turn on|turn off|verify|check)\b/gi) || [];
  const numberedMatches = text.match(/(^|\n)\s*(\d+[\.)]|-\s+)/g) || [];
  return Math.min(12, actionMatches.length + numberedMatches.length * 2);
}

function dedupeSections(sections) {
  const seen = new Set();
  const unique = [];

  for (const section of sections) {
    const key = `${section.url}:${section.text.slice(0, 180).toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(section);
    }
  }

  return unique;
}

async function draftWithOpenAI(payload, context) {
  const highlights = context.relevantSections
    .map((section, index) => `[${index + 1}] ${section.title}\n${section.url}\n${section.text}`)
    .join("\n\n");

  const prompt = `You are an expert customer support representative for ${payload.companyName}.

Create only the final ready-to-send ${payload.mode} response to the customer. The customer should be able to receive it exactly as written.

Requirements:
- Read and use the linked-page knowledge base content below.
- Treat the content as the source of truth. Do not invent policy, pricing, troubleshooting steps, or product behavior.
- Be very friendly, calm, precise, and practical.
- Do not summarize the article. Answer the customer's exact question.
- Ignore navigation menus, sidebars, related-article lists, footer links, and unrelated linked pages.
- Give the direct answer first when the references support one.
- Include only the steps that directly apply to the customer's question.
- When an article provides a procedure, include every required step in the correct order.
- If a procedure has optional branches, include only the branch that matches the customer's question, and mention alternatives briefly only when necessary.
- Keep wording concise; remove article fluff while preserving required actions.
- If the content does not answer something, ask only for the missing detail needed to continue.
- Do not mention that you crawled pages or used an AI system.
- Do not cite sources or paste source excerpts unless the customer asked for links.
- Do not include internal notes.
- Priority: ${payload.priority}.
- Sign as ${payload.agentName}, ${payload.companyName} Support.

Format rules:
- If mode is email, include a short subject line, a greeting, a brief acknowledgement, the answer/steps, and a friendly closing.
- If mode is chat, keep it conversational and compact.
- Do not use markdown emphasis.
- Do not include more than one introductory sentence before the answer.

Customer message:
${payload.message}

Most relevant extracted passages:
${highlights || "No exact keyword-matched passages were found."}

Full crawled reference content:
${context.fullText || "No readable reference content was found."}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  const result = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 900,
    }),
  });
  clearTimeout(timeout);

  if (!result.ok) {
    const errorText = await result.text();
    throw new Error(`AI drafting failed: ${errorText}`);
  }

  const data = await result.json();
  return extractOpenAIText(data);
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const textParts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        textParts.push(content.text);
      }
      if (content.type === "text" && content.text) {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

function draftWithLocalRules(payload, context) {
  const needs = detectNeeds(payload.message);
  const usefulFacts = context.relevantSections.length
    ? context.relevantSections
        .slice(0, 5)
        .map((section, index) => `${index + 1}. ${cleanSupportStep(section.text)}`)
        .join("\n")
    : "No readable article content was found from the provided references.";

  if (payload.mode === "email") {
    return `Subject: Re: Support request

Hi there,

Thanks for contacting ${payload.companyName} Support. I can help with this.

Based on your message, you need help with:
"${summarizeIssue(payload.message)}"

Please follow these steps:
${usefulFacts}

If the issue continues, please send:
- ${needs.join("\n- ")}

Once I have those details, I can confirm the exact next step for you.

Best,
${payload.agentName}
${payload.companyName} Support`;
  }

  return `Hi, thanks for reaching out. I can help with this.

From your message, it sounds like: "${summarizeIssue(payload.message)}"

Please try these steps:
${usefulFacts}

Could you also send:
- ${needs.join("\n- ")}

Once I have that, I can confirm the best next step.

${payload.agentName}
${payload.companyName} Support`;
}

function cleanSupportStep(text) {
  return cleanText(text)
    .split(/\n+/)
    .filter((line) => !isNoiseParagraph(line))
    .slice(0, 8)
    .join("\n")
    .slice(0, 1200);
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
  const articleContent = extractKnownArticleContent(html);
  const main = articleContent ||
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ||
    html;

  return cleanText(
    main
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
      .replace(/<div\b[^>]*class=["'][^"']*(betterdocs-print-pdf|betterdocs-toc|betterdocs-entry-footer|betterdocs-social-share|betterdocs-article-reactions)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, " ")
      .replace(/<div\b[^>]*class=["'][^"']*(post-navigation-link|wp-block-post-navigation-link)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, " ")
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
      .replace(/<aside\b[\s\S]*?<\/aside>/gi, " ")
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|li|h1|h2|h3|h4|tr|section|div)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function extractKnownArticleContent(html) {
  const betterDocsBlock =
    html.match(/<div\b[^>]*id=["']betterdocs-single-content["'][^>]*>([\s\S]*?)<div\b[^>]*class=["'][^"']*betterdocs-entry-footer/i)?.[1] ||
    html.match(/<div\b[^>]*class=["'][^"']*betterdocs-entry-content[^"']*["'][^>]*>([\s\S]*?)<div\b[^>]*class=["'][^"']*betterdocs-entry-footer/i)?.[1];

  if (betterDocsBlock) {
    const title = html.match(/<h1\b[^>]*class=["'][^"']*betterdocs-entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
    return `${title}\n${betterDocsBlock}`;
  }

  return "";
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
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

module.exports.collectSources = collectSources;
module.exports.normalizeUrl = normalizeUrl;
