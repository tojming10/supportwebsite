const { deleteReference, isDatabaseConfigured, listReferences, upsertReference } = require("./db");
const { collectSources, normalizeUrl } = require("./draft");

module.exports = async function handler(request, response) {
  try {
    if (!isDatabaseConfigured()) {
      return response.status(503).json({
        error: "Database is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel, then run database.sql in Supabase.",
      });
    }

    if (request.method === "GET") {
      const references = await listReferences();
      return response.status(200).json({ references });
    }

    if (request.method === "POST") {
      const body = request.body || {};
      const url = String(body.url || "").trim();
      const tags = String(body.tags || "").trim();
      const sourceType = String(body.sourceType || "article").trim();
      const crawlLinkedPages = body.crawlLinkedPages !== false;

      if (!url) {
        return response.status(400).json({ error: "Add a URL first." });
      }

      const sources = await collectSources([url], crawlLinkedPages ? undefined : { maxTotalSources: 1, maxCrawlDepth: 0 });
      const saved = [];

      for (const source of sources) {
        if (!source.url || source.url === "Manual reference note") continue;

        saved.push(
          await upsertReference({
            url: source.url,
            normalized_url: normalizeUrl(source.url),
            title: source.title || source.url,
            content: source.text || "",
            status: source.status || "failed",
            error: source.error || null,
            tags,
            source_type: sourceType,
            last_synced_at: new Date().toISOString(),
          }),
        );
      }

      return response.status(200).json({
        message: saved.length === 1 ? "Reference saved." : `${saved.length} references saved.`,
        references: saved.filter(Boolean),
      });
    }

    if (request.method === "DELETE") {
      const id = new URL(request.url, "http://localhost").searchParams.get("id");
      if (!id) {
        return response.status(400).json({ error: "Missing reference id." });
      }

      await deleteReference(id);
      return response.status(200).json({ message: "Reference deleted." });
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    return response.status(405).json({ error: "Unsupported method." });
  } catch (error) {
    return response.status(500).json({ error: error.message || "Reference request failed." });
  }
};
