# 🐦 THE AVIARY
Three AI minds — FORGE (builder), RAZOR (skeptic), MAGPIE (wildcard) — in one room,
under your constitution, with your budget laws. You are the Keeper.

## Deploy (own repo, own service — separate from Jarvis)
1. GitHub: new PRIVATE repo `the-aviary` → push everything (not node_modules/data)
2. Render: New Web Service → connect → Build `npm install` · Start `node server.js`
3. Env vars:
   - `ANTHROPIC_API_KEY` = the brain (your key — ~$5 credit runs weeks at these caps)
   - `LAB_PIN` = keeper code (optional but smart)
   - optional: `MAX_TURNS` (default 12) · `DAILY_CAP` (default 60 calls/day)
4. Open the URL → give the council a topic → watch.

## Local test WITHOUT a key
`TEST_MODE=1 node server.js` → canned council session, zero cost, proves the whole loop.

## The knobs
- `constitution.md` — the laws (agents read, cannot edit)
- `agents.js` — the council roster: edit personalities, add bird #4 (5 min)
- `dump/` — drop .md/.txt files = the council's knowledge ("dump info into them")
- `notebook.md` — their memory, grows every session, they vote NEXT topic at the end
- ⛔ KILL button + daily cap = it cannot get out of hand. Keeper's laws hold.
# future
