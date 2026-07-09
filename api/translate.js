const { callOpenAI } = require("./draft");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to translate a draft." });
  }

  try {
    const draft = String(request.body?.draft || "").trim();
    const languageName = String(request.body?.languageName || "").trim();

    if (!draft || !languageName) {
      return response.status(400).json({ error: "Missing draft or language." });
    }

    if (!process.env.OPENAI_API_KEY) {
      return response.status(503).json({ error: "OpenAI is not configured, so translation is unavailable." });
    }

    const prompt = `Translate this ready-to-send customer support email into ${languageName}.

Rules:
- Preserve the meaning exactly.
- Keep the same email structure, subject line, numbered steps, and friendly tone.
- Translate meaning, tone, and intent, not word by word.
- Make it sound like a native ${languageName}-speaking customer support representative wrote it originally.
- Use simple, natural language that customers of all ages and technical skill levels can understand.
- Preserve product names, app names, error codes, order numbers, URLs, and quoted text exactly.
- Localize phrasing politely and naturally, but do not change the actual instructions.
- Do not add new information.
- Return only the translated email.

Email:
${draft}`;

    const translatedDraft = await callOpenAI(prompt, 1000, 0.1);
    return response.status(200).json({ translatedDraft });
  } catch (error) {
    return response.status(500).json({ error: error.message || "Translation failed." });
  }
};
