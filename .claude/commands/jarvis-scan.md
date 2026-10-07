---
description: Rescan the agents folder and write rich, accurate descriptions for every auto-detected agent card
---
Refresh my JARVIS roster and make every card genuinely useful.

1. Run `npm run scan`. Read `data/CHANGES.md` for what was added or removed, then read `data/roster.json`.
2. For **every card with `"auto": true`** (and any card whose source files changed), open the agent's own definition files under its `source` folder: `.claude/agents/*.md`, `.claude/commands/*.md`, `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`, `SCHEDULE.md`, `INSTALL.md`, `config/*.yaml|json` (non-secret), `azure/**/function_app.py`, `vercel.json`, `.github/workflows/*.yml`. **Never open `.env*`, key files or anything credential-shaped.**
3. Rewrite the card in place following the schema in `CLAUDE.md`:
   - `name`: the human name of the agent (not a file slug) · `job`: one plain sentence about what it does for the business
   - `trigger`: every real schedule (convert cron to words, say which runner: Azure, Vercel, GitHub Actions, cron, launchd, Claude desktop routine), webhooks, and manual commands
   - `connects`: the MCP servers, APIs, mailboxes and files it actually uses — names only, never values
   - `status` + `statusNote` with evidence: **live** (runs on its own schedule/trigger), **testing** (built; shadow or manual), **blocked** (named unmet prerequisite) — and fill `waiting` with each prerequisite
   - `handoff`: who or what receives its output (`<b>Name</b>` for emphasis) · `model` from its definition
   - Move it to the right department (`depts[].id`), creating a department if none fits; keep `id`, `path`, `source`
   - Set `"auto": false` so the next scan never overwrites your work.
4. If the Claude desktop app's scheduled-task tools are available to you, list my scheduled tasks and record whether each routine is enabled — set matching rows in `schedManual` to `on` or `off` and adjust the cards.
5. Fill `team` with the people the agents hand off to or are supervised by (first names and roles only — no emails or phone numbers).
6. Run `npm run build`. If ElevenLabs is connected (`npm run doctor` says so), run `npm run voice` so the spoken answers match.
7. Report in five lines or fewer: cards described, departments, live / testing / blocked counts, and anything you couldn't determine (leave those cards with a short `statusNote` saying what's unclear rather than guessing).
