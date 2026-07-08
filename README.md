# SupportDraft

A support knowledge-base and response drafting app.

## What It Does

- Saves support references in a database.
- Re-adding the same URL updates the existing saved reference automatically.
- Can crawl same-site links found inside a saved reference page.
- Drafts customer-ready chat or email responses from saved knowledge-base content plus optional one-time references.
- Uses OpenAI when `OPENAI_API_KEY` is configured, with a rule-based fallback if AI is unavailable.

## Vercel Environment Variables

Add these in Vercel Project Settings > Environment Variables:

```text
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

Redeploy after adding or changing variables.

## Supabase Setup

1. Create a Supabase project.
2. Open the SQL editor.
3. Run the SQL from `database.sql`.
4. Copy the project URL into `SUPABASE_URL`.
5. Copy the service role key into `SUPABASE_SERVICE_ROLE_KEY`.

The app uses the service role key only in server-side Vercel API routes. Do not expose it in browser code.
