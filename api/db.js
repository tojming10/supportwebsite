const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "support_references";

function isDatabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseRequest(path, options = {}) {
  if (!isDatabaseConfigured()) {
    throw new Error("Database is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel.");
  }

  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(options.headers || {}),
    },
  });

  const text = await result.text();
  const data = text ? JSON.parse(text) : null;

  if (!result.ok) {
    throw new Error(data?.message || data?.error || `Database request failed with HTTP ${result.status}.`);
  }

  return data;
}

async function listReferences() {
  return supabaseRequest(`${TABLE}?select=*&order=updated_at.desc`);
}

async function upsertReference(reference) {
  const rows = await supabaseRequest(`${TABLE}?on_conflict=normalized_url`, {
    method: "POST",
    headers: {
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(reference),
  });

  return rows?.[0] || null;
}

async function deleteReference(id) {
  await supabaseRequest(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

async function searchReferences(query, limit = 16) {
  const references = await listReferences();
  const keywords = importantWords(query);
  return references
    .map((reference) => ({
      ...reference,
      score: scoreText(`${reference.title || ""}\n${reference.content || ""}\n${reference.tags || ""}`, keywords),
    }))
    .filter((reference) => reference.status === "fetched" && reference.content)
    .sort((a, b) => b.score - a.score || new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, limit);
}

function importantWords(text) {
  const stopWords = new Set([
    "about", "after", "again", "also", "because", "before", "could", "email", "error", "from",
    "have", "help", "into", "just", "like", "need", "please", "question", "support", "that",
    "their", "there", "this", "want", "what", "when", "where", "with", "would", "your",
  ]);

  return String(text || "")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g)
    ?.filter((word) => !stopWords.has(word))
    .slice(0, 50) || [];
}

function scoreText(text, keywords) {
  const lower = String(text || "").toLowerCase();
  return keywords.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0);
}

module.exports = {
  deleteReference,
  isDatabaseConfigured,
  listReferences,
  searchReferences,
  upsertReference,
};
