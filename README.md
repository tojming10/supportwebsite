# SupportDraft

A support email drafting app that reads backend-managed website links.

## What It Does

- Reads website links from `api/sourceLinks.js`.
- Extracts text from web pages.
- Translates non-English customer messages into natural English for drafting.
- Can translate the finished email draft back into the customer's original language.
- Drafts customer-ready email responses in a friendly, accurate, easy-to-understand tone.
- Uses OpenAI when `OPENAI_API_KEY` is configured, with a rule-based fallback if AI is unavailable.

## Vercel Environment Variables

Add these in Vercel Project Settings > Environment Variables:

```text
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
```

Redeploy after adding or changing variables.

## Backend-Only Reference Links

The frontend does not show reference link fields. Add or replace support sources in:

```text
api/sourceLinks.js
```

When a draft is created, the API automatically reads those configured sources and uses them as the support knowledge base.
