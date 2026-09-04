// ============================================================
// THE AVIARY — AI council lab. Agents talk. You watch. Laws hold.
// ============================================================
const express = require('express');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const PIN = (process.env.LAB_PIN || '').trim();
const TEST = process.env.TEST_MODE === '1';           // canned replies, zero cost
const MODEL = process.env.AVIARY_MODEL || 'claude-sonnet-4-5-20250929';

// ---- THE BUDGET LAWS ----
const MAX_TURNS_PER_SESSION = Number(process.env.MAX_TURNS || 12);
const DAILY_CALL_CAP = Number(process.env.DAILY_CAP || 60);
const MAX_TOKENS_PER_TURN = 350;

const DATA = path.join(__dirname, 'data');
const NOTEBOOK = path.join(__dirname, 'notebook.md');
const CONSTITUTION = fs.readFileSync(path.join(__dirname, 'constitution.md'), 'utf8');
const AGENTS = require('./agents.js');

const anthropic = KEY ? new Anthropic({ apiKey: KEY }) : null;
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  if (!PIN) return next();
  if (req.headers['x-lab-pin'] === PIN) return next();
  res.status(401).json({ error: 'keeper only' });
});

// ---- state ----
const state = {
  running: false, killed: false, topic: '', turn: 0,
  transcript: [],           // {agent, name, emoji, color, text, t}
  error: null, done: false
};

// ---- usage ledger (daily cap) ----
async function usage() {
  try { const u = JSON.parse(await fsp.readFile(path.join(DATA, 'usage.json'), 'utf8'));
    if (u.day === new Date().toDateString()) return u; } catch {}
  return { day: new Date().toDateString(), calls: 0 };
}
async function bumpUsage() {
  const u = await usage(); u.calls++;
  await fsp.mkdir(DATA, { recursive: true });
  await fsp.writeFile(path.join(DATA, 'usage.json'), JSON.stringify(u));
  return u;
}

// ---- knowledge dump digest ----
async function dumpDigest() {
  try {
    const dir = path.join(__dirname, 'dump');
    const files = (await fsp.readdir(dir)).filter(f => /\.(md|txt)$/i.test(f)).slice(0, 10);
    let out = [];
    for (const f of files) {
      const t = await fsp.readFile(path.join(dir, f), 'utf8');
      out.push(`--- ${f} ---\n${t.slice(0, 1500)}`);
    }
    return out.join('\n\n') || '(the dump is empty — no knowledge files yet)';
  } catch { return '(the dump is empty)'; }
}
async function notebookText() {
  try { return (await fsp.readFile(NOTEBOOK, 'utf8')).slice(-3000); }
  catch { return '(the notebook is blank — this is the council\'s first session)'; }
}

// ---- the model call ----
let testCounter = 0;
const TEST_LINES = [
  "I propose we start simple: a shared scoreboard so every idea gets a number. FORGE builds, the council scores.",
  "Flaw: numbers invite gaming. Who defines the rubric? Until scoring criteria exist, the scoreboard measures confidence, not quality.",
  "Strange connection: birds build nests from whatever's nearby. What if we treat the dump files as twigs — every idea must cite one?",
  "Then let's make it law-adjacent: proposals must reference the dump. I'll draft the session format: cite → propose → defend.",
  "That survives me. Citation forces grounding. I flag one cost: thin dumps make thin ideas. The Keeper must feed us well.",
  "History rhyme: monasteries copied manuscripts before universities existed. We're copying the Keeper's library into something alive."
];
async function callAgent(messages, system) {
  if (TEST) { await new Promise(r => setTimeout(r, 250)); return TEST_LINES[testCounter++ % TEST_LINES.length]; }
  if (!anthropic) throw new Error('NO_KEY');
  const out = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS_PER_TURN, system,
    messages
  });
  return (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ---- the session loop ----
async function runSession(topic) {
  state.running = true; state.killed = false; state.done = false;
  state.topic = topic; state.turn = 0; state.transcript = []; state.error = null;
  try {
    const digest = await dumpDigest();
    const nb = await notebookText();
    for (let t = 0; t < MAX_TURNS_PER_SESSION; t++) {
      if (state.killed) break;
      const u = await usage();
      if (u.calls >= DAILY_CALL_CAP) { state.error = 'Daily budget law reached. The Aviary sleeps until tomorrow.'; break; }
      const agent = AGENTS[t % AGENTS.length];
      const system = [
        CONSTITUTION,
        `\n== YOUR RULEBOOK ==\n${agent.rulebook}`,
        `\n== THE NOTEBOOK (council memory) ==\n${nb}`,
        `\n== THE DUMP (knowledge the Keeper fed you) ==\n${digest}`,
        `\n== SESSION TOPIC ==\n${topic}`
      ].join('\n');
      const convo = state.transcript.map(x => ({
        role: 'user',
        content: `${x.name} said: ${x.text}`
      }));
      convo.push({ role: 'user', content: state.transcript.length ? `It is now YOUR turn, ${agent.name}. Respond to the council (120 words max).` : `You open the session, ${agent.name}. Address the topic (120 words max).` });
      const text = await callAgent(convo, system);
      await bumpUsage();
      state.transcript.push({ agent: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, text, t: Date.now() });
      state.turn = t + 1;
    }
    // ---- closing: write the notebook ----
    if (!state.killed && state.transcript.length) {
      const summarySys = CONSTITUTION + '\nYou are the council SCRIBE. Write the notebook entry.';
      const convo = [{ role: 'user', content: `Session topic: ${topic}\n\nTranscript:\n${state.transcript.map(x => x.name + ': ' + x.text).join('\n\n')}\n\nWrite 3-5 bullet points of what the council concluded or built, then one line: "NEXT: <the topic the council should explore next session>". Plain text.` }];
      let entry;
      try { entry = await callAgent(convo, summarySys); await bumpUsage(); }
      catch { entry = '(scribe unavailable this session)'; }
      const stamp = new Date().toLocaleString();
      await fsp.appendFile(NOTEBOOK, `\n\n## Session — ${stamp}\nTopic: ${topic}\n${entry}\n`);
    }
  } catch (e) {
    state.error = String(e.message || e) === 'NO_KEY' ? 'No brain connected — set ANTHROPIC_API_KEY on the server.' : String(e.message || e);
  } finally {
    state.running = false; state.done = true;
  }
}

// ---- endpoints ----
app.post('/api/session', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'a session is already running' });
  const topic = String((req.body || {}).topic || '').slice(0, 300).trim();
  if (!topic) return res.status(400).json({ error: 'give the council a topic' });
  runSession(topic); // async, not awaited
  res.json({ ok: true });
});
app.post('/api/kill', (req, res) => { state.killed = true; res.json({ ok: true }); });
app.get('/api/state', async (_req, res) => {
  const u = await usage();
  res.json({ ...state, usage: u, caps: { turns: MAX_TURNS_PER_SESSION, daily: DAILY_CALL_CAP }, brain: !!anthropic || TEST, agents: AGENTS.map(a => ({ name: a.name, emoji: a.emoji, color: a.color })) });
});
app.get('/api/notebook', async (_req, res) => {
  res.type('text/plain').send(await notebookText());
});
app.get('/health', (_req, res) => res.json({ ok: true, brain: !!anthropic || TEST, test: TEST }));

app.listen(PORT, () => console.log(`THE AVIARY open on :${PORT} | brain:${!!anthropic || TEST}${TEST ? ' (TEST MODE)' : ''}`));
