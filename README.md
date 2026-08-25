# SupportDraft

A support email drafting app that reads pasted website links and Google Drive PDF links.

## What It Does

- Reads pasted website links, Google Drive PDF file links, and Google Drive folder links.
- Extracts text from web pages and PDFs.
- Translates non-English customer messages into natural English for drafting.
- Can translate the finished email draft back into the customer's original language.
- Drafts customer-ready email responses in a friendly, accurate, easy-to-understand tone.
- Uses OpenAI when `OPENAI_API_KEY` is configured, with a rule-based fallback if AI is unavailable.

## Vercel Environment Variables

Add these in Vercel Project Settings > Environment Variables:

```text
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
GOOGLE_DRIVE_API_KEY=your_google_drive_api_key
```

Redeploy after adding or changing variables.

## Google Drive PDF Links

You can paste public/shared Google Drive PDF file links directly into the reference links area.

For Google Drive folder links, add `GOOGLE_DRIVE_API_KEY` in Vercel. The folder must be accessible to the API key, usually by sharing the folder or PDFs so they can be read by anyone with the link. The app will list PDF files inside the folder, download them server-side, extract text, and use that content for the draft.
