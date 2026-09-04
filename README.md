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

## v1.3 — AUTOPILOT
Give them a MISSION + a number of cycles. Each cycle: OWL researches the current focus (real web search)
→ council debates → scribe writes the notebook + votes NEXT focus → PLANNER rewrites `plan.md` (THE MASTER PLAN).
They run themselves until cycles finish or you hit stop.
Limits are env-driven and default sky-high (MAX_TURNS 24/session, DAILY_CAP 3000 calls, MAX_SEARCHES 8/study).
The ONLY real cap is your API credit — watch the ~$ meter. Rough cost: ~1-2 cents per turn, a full cycle ≈ $0.40-0.90.
$25 ≈ 30-50 cycles of serious thinking. Overnight runs on Render FREE tier get put to sleep after 15 min without
a browser open — keep the tab open, or use the $7 plan for true unattended runs.
🔊 voices = your browser's built-in speech, one voice per bird, free.

## v1.4 — HANDS
- 🛠️ ANVIL joins: the engineer who ships real files.
- Any bird can write files with a ```file:path``` block → lands in `workshop/` on the server → listed on the page,
  readable per-file, downloadable as one bundle (paste into Cursor to run/test — the Keeper executes, birds never run code).
- Law 9: research before money. Law 10: build, don't just talk.
- FREE MISSION: give autopilot the mission "choose your own" (see command below) and the council picks what to build.
