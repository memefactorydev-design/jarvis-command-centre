---
description: Publish the command centre to Vercel (keys uploaded as encrypted env vars, live mode gated by an access code)
---
Publish my JARVIS Command Centre to Vercel.

1. Check `vercel --version`. If it's missing, tell me to run `npm i -g vercel` and `vercel login`, then stop.
2. Run `npm run doctor` and tell me in one line whether Claude and ElevenLabs are connected. If Claude isn't, say live mode will be offline on the site (the dashboard and recorded clips still work) and ask whether to continue.
3. Run `npm run deploy`. It builds, uploads my keys from `.env` as encrypted Vercel environment variables, creates an access code if I don't have one, and deploys to production. **Don't print `.env` or the access code.**
4. Give me the URL it prints, and explain that live voice on the site unlocks with `<url>/#code=<JARVIS_ACCESS_CODE from my .env>` — a link I should only share with people I trust, because live answers use my API credits.
