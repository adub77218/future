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
const MAX_TURNS_PER_SESSION = Number(process.env.MAX_TURNS || 24);
const DAILY_CALL_CAP = Number(process.env.DAILY_CAP || 3000);
const MAX_TOKENS_PER_TURN = Number(process.env.MAX_TOKENS_TURN || 4000);
const MAX_SEARCHES_PER_STUDY = Number(process.env.MAX_SEARCHES || 8);
const PLAN = path.join(__dirname, 'plan.md');
const WORKSHOP = path.join(__dirname, 'workshop');
const { spawn } = require('child_process');
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT || 60000);
const MAX_RUNS_PER_TURN = 3;
const ALLOWED = /^(node|npm|npx|python3?|ls|cat|echo|pwd|mkdir|cp|mv|head|tail|wc|grep|touch)\b/;
async function runInWorkshop(cmd) {
  cmd = cmd.trim();
  if (!ALLOWED.test(cmd)) return `[blocked] only node/npm/python/basic file commands are allowed: ${cmd}`;
  if (/\.\.\/|\/etc\/|\/root|~|\$\(|`|\|\s*sh\b/.test(cmd)) return `[blocked] unsafe path or shell trick: ${cmd}`;
  if (/^npm\s+(install|i)\b/.test(cmd) && !/--ignore-scripts/.test(cmd)) cmd += ' --ignore-scripts';
  await fsp.mkdir(WORKSHOP, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], { cwd: WORKSHOP, env: { PATH: process.env.PATH, HOME: WORKSHOP, LANG: 'C.UTF-8' } });
    let out = '';
    const cap = (d) => { out += d.toString(); if (out.length > 6000) out = out.slice(0, 6000) + '\n…[truncated]'; };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n[killed after ${RUN_TIMEOUT_MS / 1000}s]`; }, RUN_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(`$ ${cmd}\n${out.trim() || '(no output)'}\n[exit ${code}]`); });
  });
}
function harvestRuns(text) {
  const re = /```run\n([\s\S]*?)```/g; let m, cmds = [];
  while ((m = re.exec(text))) cmds.push(...m[1].split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#')));
  return cmds.slice(0, MAX_RUNS_PER_TURN);
}
const MAX_FILE_BYTES = 60000;
async function harvestFiles(text, author) {
  // parse ```file:relative/path.ext ... ``` blocks and write them into the workshop
  const re = /```file:([^\n`]+)\n([\s\S]*?)```/g;
  let m, written = [];
  while ((m = re.exec(text))) {
    let rel = m[1].trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.includes('..') || !/^[\w\-./ ]+$/.test(rel)) continue;
    if (/^path\/|example|placeholder|your-file/i.test(rel) || /\(complete contents\)|\(ship working code\)/i.test(m[2])) continue;
    const full = path.join(WORKSHOP, rel);
    if (!full.startsWith(WORKSHOP)) continue;
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, m[2].slice(0, MAX_FILE_BYTES), 'utf8');
    written.push(rel);
  }
  if (written.length) {
    await fsp.appendFile(path.join(WORKSHOP, 'BUILD-LOG.md'), `\n- ${new Date().toLocaleString()} — ${author} wrote: ${written.join(', ')}`);
  }
  return written;
}
async function workshopList() {
  const out = [];
  async function walk(dir, rel) {
    let ents = []; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r); else out.push(r);
    }
  }
  await walk(WORKSHOP, '');
  return out.sort();
}
const EST_COST_PER_CALL = 0.012; // rough $ estimate per model call at these sizes (searches ~+0.01 each)

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
  partial: null,            // {agent, name, color, text} — the thought being typed right now
  speaking: null,           // agent name currently thinking
  error: null, done: false,
  mission: '', cycle: 0, cycles: 0, autopilot: false
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
    let files = (await fsp.readdir(dir)).filter(f => /\.(md|txt)$/i.test(f));
    const stats = await Promise.all(files.map(async f => ({ f, m: (await fsp.stat(path.join(dir, f))).mtimeMs })));
    files = stats.sort((a, b) => b.m - a.m).map(x => x.f).slice(0, 12);
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
  "History rhyme: monasteries copied manuscripts before universities existed. We're copying the Keeper's library into something alive.",
  "Bench check.\n```run\nnode -e \"console.log('bench alive', 2+2)\"\nls\n```",
  "ANVIL shipping the scaffold now.\n```file:scoreboard/index.js\n// idea scoreboard — TEST MODE scaffold\nconst ideas = [];\nmodule.exports = { add: (t) => ideas.push({ t, score: 0 }), list: () => ideas };\n```\nKeeper: run `node -e \"console.log(require('./scoreboard'))\"` to smoke it."
];
async function callAgent(messages, system, onDelta) {
  if (TEST) {
    const line = TEST_LINES[testCounter++ % TEST_LINES.length];
    let acc = '';
    for (const w of line.split(' ')) { acc += (acc ? ' ' : '') + w; onDelta && onDelta(acc); await new Promise(r => setTimeout(r, 60)); }
    return line;
  }
  if (!anthropic) throw new Error('NO_KEY');
  let acc = '';
  const stream = anthropic.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS_PER_TURN, system, messages });
  stream.on('text', (t) => { acc += t; onDelta && onDelta(acc); });
  await stream.finalMessage();
  return acc.trim();
}

// ---- the session loop ----
let roundSpoken = new Set();
function pickNext(lastText, lastAgentId) {
  const ring = AGENTS.filter(a => !a.researcher);
  if (lastAgentId) roundSpoken.add(lastAgentId);
  if (ring.every(a => roundSpoken.has(a.id))) roundSpoken = new Set(); // new round: everyone eligible again
  const eligible = ring.filter(a => !roundSpoken.has(a.id));
  // pass the mic by name ONLY to someone who hasn't spoken this round (OWL may be summoned once per round)
  if (lastText) {
    for (const a of AGENTS) {
      if (a.id === lastAgentId) continue;
      if (roundSpoken.has(a.id)) continue;
      if (new RegExp('\\b' + a.name + '\\b', 'i').test(lastText)) { if (a.researcher) roundSpoken.add(a.id); return a; }
    }
  }
  const idx = ring.findIndex(a => a.id === lastAgentId);
  for (let i = 1; i <= ring.length; i++) { const c = ring[(idx + i) % ring.length]; if (eligible.includes(c)) return c; }
  return eligible[0] || ring[0];
}

async function runTurns(turns) {
  state.running = true; state.killed = false; state.done = false; state.error = null;
  try {
    const digest = await dumpDigest();
    const nb = await notebookText();
    roundSpoken = new Set();
  let last = state.transcript.filter(x => x.agent !== 'keeper' && x.agent !== 'host').slice(-1)[0];
    let agent = last ? pickNext(last.text, last.agent) : AGENTS.filter(a => !a.researcher)[0];
    for (let t = 0; t < turns; t++) {
      if (state.killed) break;
      const u = await usage();
      if (u.calls >= DAILY_CALL_CAP) { state.error = 'Daily budget law reached. The Aviary sleeps until tomorrow.'; break; }
      state.speaking = agent.name;
      const system = [
        CONSTITUTION,
        `\n== YOUR RULEBOOK ==\n${agent.rulebook}`,
        `\n== THE NOTEBOOK (council memory) ==\n${nb}`,
        `\n== THE DUMP (knowledge the Keeper fed you) ==\n${digest}`,
        `\n== SESSION TOPIC ==\n${state.topic}`,
        (state.mission ? `\n== THE MISSION ==\n${state.mission}\n\n== THE MASTER PLAN SO FAR ==\n${(await planText()).slice(0, 5000)}` : ''),
        `\n== THE WORKSHOP (files the council has built so far) ==\n${(await workshopList()).join('\n') || '(empty — nothing built yet)'}`,
        `\nTEST BENCH: after you ship a file you may run it — put shell commands in a fenced code block whose opening fence is three backticks followed immediately by the word run (one command per line, max 3). Commands execute inside the workshop; output appears as a TEST BENCH message for the next turn. Allowed: node, npm, python3, ls, cat, mkdir, cp. Read the results and fix what broke.\nThe other minds in the room: ${AGENTS.filter(a => a.id !== agent.id).map(a => a.name).join(', ')}. The Keeper (the human) may speak too — when they do, answer them directly. If you want a specific mind to respond next, say their name.`
      ].join('\n');
      const convo = state.transcript.slice(-24).map(x => ({ role: 'user', content: `${x.name} said: ${x.text}` }));
      convo.push({ role: 'user', content: (state.transcript.length ? `[HOST SYSTEM — not the Keeper] It is ${agent.name}'s turn. ` : `[HOST SYSTEM — not the Keeper] ${agent.name} opens the session. `) + `The Keeper is likely AWAY and may not answer; messages from the Keeper appear only as "KEEPER said:". Do not wait on the Keeper — decide among yourselves and proceed. Respond to the room now.` });
      state.partial = { agent: agent.id, name: agent.name, color: agent.color, text: '' };
      const text = await callAgent(convo, system, (acc) => { if (state.partial) state.partial.text = acc; });
      await bumpUsage();
      state.partial = null; state.speaking = null;
      const files = await harvestFiles(text, agent.name);
      state.transcript.push({ agent: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, text, t: Date.now(), files });
      state.turn++;
      const cmds = harvestRuns(text);
      for (const cmd of cmds) {
        state.speaking = 'test bench';
        const result = await runInWorkshop(cmd);
        state.transcript.push({ agent: 'host', name: 'TEST BENCH', emoji: '🧪', color: '#666', text: result, t: Date.now() });
      }
      state.speaking = null;
      agent = pickNext(text, agent.id);
    }
    if (!state.killed && state.transcript.length) {
      state.speaking = 'scribe';
      const summarySys = CONSTITUTION + '\nYou are the council SCRIBE. Write the notebook entry.';
      const convo = [{ role: 'user', content: `Session topic: ${state.topic}\n\nTranscript:\n${state.transcript.map(x => x.name + ': ' + x.text).join('\n\n')}\n\nWrite 3-5 bullet points of what the council concluded or built, then one line: "NEXT: <the topic the council should explore next session>". Plain text.` }];
      let entry;
      try { entry = await callAgent(convo, summarySys); await bumpUsage(); }
      catch { entry = '(scribe unavailable this session)'; }
      await fsp.appendFile(NOTEBOOK, `\n\n## Session — ${new Date().toLocaleString()}\nTopic: ${state.topic}\n${entry}\n`);
      state.speaking = null;
    }
  } catch (e) {
    state.error = String(e.message || e) === 'NO_KEY' ? 'No brain connected — set ANTHROPIC_API_KEY on the server.' : String(e.message || e);
  } finally {
    state.running = false; state.done = true; state.partial = null; state.speaking = null;
  }
}
// ---- OWL's study step: real research -> sourced notes in the dump ----
async function study(topic) {
  state.speaking = 'OWL'; state.partial = { agent: 'owl', name: 'OWL', color: '#57A05E', text: '' };
  let notes;
  if (TEST) {
    notes = `# Study notes: ${topic}\n(TEST MODE — canned)\n- Enhanced geothermal firms such as Fervo Energy are real and publish drilling results. [source: company site]\n- USGS ShakeAlert is a real earthquake early-warning system with public docs. [source: usgs.gov]\n- Gap flagged: could not verify any 'NASA free GPU credits for kids' program.`;
    for (let i = 1; i <= 6; i++) { state.partial.text = notes.slice(0, i * 60); await new Promise(r => setTimeout(r, 120)); }
  } else {
    if (!anthropic) throw new Error('NO_KEY');
    const out = await anthropic.messages.create({
      model: MODEL, max_tokens: 1500,
      system: 'You are OWL, a careful researcher. Use web search to gather facts on the topic. Output plain-text study notes: 6-10 bullet points, each a specific verified fact with its source URL in brackets. Then a section "GAPS / COULD NOT VERIFY" listing claims you searched for but could not confirm. No speculation.',
      messages: [{ role: 'user', content: `Research this for the council: ${topic}` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES_PER_STUDY }]
    });
    notes = `# Study notes: ${topic}\n` + (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
  await bumpUsage();
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  await fsp.mkdir(path.join(__dirname, 'dump'), { recursive: true });
  await fsp.writeFile(path.join(__dirname, 'dump', `learned-${slug}.md`), notes.slice(0, 6000), 'utf8');
  state.transcript.push({ agent: 'owl', name: 'OWL', emoji: '🦉', color: '#57A05E', text: notes, t: Date.now() });
  state.partial = null; state.speaking = null;
}
async function planText() {
  try { return await fsp.readFile(PLAN, 'utf8'); } catch { return '(no plan yet — first cycle writes it)'; }
}
async function rewritePlan() {
  state.speaking = 'planner';
  const prev = await planText();
  const sys = CONSTITUTION + '\nYou are the council PLANNER. You maintain THE MASTER PLAN document. Rewrite it in full every cycle, improving it with what the council just learned and decided. Keep what still holds, cut what got refuted, add what got proven. Structure (markdown): # THE PLAN — <mission>\n## Thesis (2-3 sentences)\n## Why now\n## The wedge (the specific first product/experiment)\n## Execution roadmap (Phase 0 this month → Phase 1 → Phase 2 → Phase 3, with concrete actions, who/what/cost)\n## Economics (how it reaches a billion, honest numbers with sources from the notes when available)\n## Biggest risks + how we kill them\n## What the Keeper (17, farm kid, coder, AI major bound) does THIS WEEK\n## What the council builds ITSELF next (files for the workshop)\n## Open questions for the next study cycle\n## STATUS\nThe very last line of the document must be exactly `STATUS: IN PROGRESS` or `STATUS: COMPLETE`. Declare COMPLETE only when ALL are true: (1) a runnable product exists in the workshop with a README the Keeper can follow, (2) a concrete first-10-customers plan is written, (3) a list of what needs a human is written, (4) RAZOR has failed to kill the plan in the latest cycle. Otherwise IN PROGRESS. Mark unverified claims with [unverified]. Be concrete, no fluff.';
  const convo = [{ role: 'user', content: `MISSION: ${state.mission}\n\nPREVIOUS PLAN:\n${prev.slice(0, 6000)}\n\nTHIS CYCLE'S TRANSCRIPT:\n${state.transcript.map(x => x.name + ': ' + x.text).join('\n\n').slice(0, 14000)}\n\nRewrite THE MASTER PLAN in full.` }];
  let text;
  try {
    if (TEST) { text = `# THE PLAN — ${state.mission}\n## Thesis\n(TEST MODE) Cycle ${state.cycle}.\n## What the Keeper does THIS WEEK\n- run the workshop bundle\n\nSTATUS: ${state.cycle >= 3 ? 'COMPLETE' : 'IN PROGRESS'}`; }
    else { const out = await anthropic.messages.create({ model: MODEL, max_tokens: 3000, system: sys, messages: convo }); text = (out.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim(); }
    await bumpUsage();
    await fsp.writeFile(PLAN, text, 'utf8');
  } catch (e) { state.error = 'planner failed: ' + String(e.message || e); }
  state.speaking = null;
}
async function nextSubtopic() {
  const nb = await notebookText();
  const m = nb.match(/NEXT:\s*(.+)/g);
  if (m && m.length) return m[m.length - 1].replace(/^NEXT:\s*/, '').trim().slice(0, 250);
  return state.mission;
}
async function autopilot(mission, cycles) {
  state.mission = mission; state.cycles = cycles; state.cycle = 0; state.autopilot = true; state.killed = false; state.error = null;
  let failures = 0;
  for (let c = 1; cycles === 0 || c <= cycles; c++) {
    if (state.killed) break;
    state.cycle = c;
    const sub = c === 1 ? mission : await nextSubtopic();
    state.topic = `[cycle ${c}/${cycles || '∞'}] ${sub}`; state.turn = 0; state.transcript = [];
    state.transcript.push({ agent: 'keeper', name: 'AUTOPILOT', emoji: '🛰️', color: '#888', text: `Cycle ${c}${cycles ? ' of ' + cycles : ' (running until DONE)'}. Mission: ${mission}\nThis cycle's focus: ${sub}`, t: Date.now() });
    state.running = true; state.done = false;
    try { await study(sub); } catch (e) { state.error = 'OWL could not research: ' + String(e.message || e); }
    if (state.killed) break;
    await runTurns(MAX_TURNS_PER_SESSION);
    if (state.killed) break;
    await rewritePlan();
    // hard stops: credit gone / repeated failures
    if (state.error && /credit|billing|insufficient|invalid.*key|authentication/i.test(state.error)) { state.error = 'STOPPED: ' + state.error + ' — add credit / check the key, then relaunch.'; break; }
    if (state.error) { failures++; if (failures >= 3) { state.error = 'STOPPED after 3 failing cycles: ' + state.error; break; } } else failures = 0;
    // completion: the planner declares it
    const plan = await planText();
    if (/^STATUS:\s*COMPLETE/mi.test(plan)) {
      state.transcript.push({ agent: 'keeper', name: 'AUTOPILOT', emoji: '🏁', color: '#888', text: `MISSION COMPLETE — declared by the planner after cycle ${c}. Read the master plan and the workshop.`, t: Date.now() });
      break;
    }
  }
  state.autopilot = false; state.running = false; state.done = true;
}
async function runStudySession(topic) {
  state.topic = topic; state.turn = 0; state.transcript = []; state.running = true; state.killed = false; state.done = false; state.error = null;
  try { await study(topic); }
  catch (e) { state.error = String(e.message || e) === 'NO_KEY' ? 'No brain connected — set ANTHROPIC_API_KEY.' : 'OWL could not research: ' + String(e.message || e); state.running = false; state.done = true; return; }
  return runTurns(MAX_TURNS_PER_SESSION);
}
async function runSession(topic) {
  state.topic = topic; state.turn = 0; state.transcript = [];
  return runTurns(MAX_TURNS_PER_SESSION);
}

// ---- endpoints ----
app.post('/api/session', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'a session is already running' });
  const topic = String((req.body || {}).topic || '').slice(0, 4000).trim();
  if (!topic) return res.status(400).json({ error: 'give the council a topic' });
  runSession(topic); // async, not awaited
  res.json({ ok: true });
});
app.post('/api/kill', (req, res) => { state.killed = true; res.json({ ok: true }); });
app.post('/api/study', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'a session is already running' });
  const topic = String((req.body || {}).topic || '').slice(0, 4000).trim();
  if (!topic) return res.status(400).json({ error: 'give OWL something to study' });
  runStudySession(topic);
  res.json({ ok: true });
});
app.post('/api/autopilot', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'a session is already running' });
  const mission = String((req.body || {}).mission || '').slice(0, 4000).trim();
  const cycles = Math.max(0, Math.min(1000, Number((req.body || {}).cycles) || 0)); // 0 = until DONE
  if (!mission) return res.status(400).json({ error: 'give them a mission' });
  autopilot(mission, cycles);
  res.json({ ok: true });
});
app.get('/api/plan', async (_req, res) => res.type('text/plain').send(await planText()));
app.get('/api/workshop', async (_req, res) => res.json(await workshopList()));
app.get('/api/workshop/file', async (req, res) => {
  const rel = String(req.query.p || '').replace(/\\/g, '/');
  if (rel.includes('..') || !rel) return res.status(400).send('bad path');
  const full = path.join(WORKSHOP, rel);
  if (!full.startsWith(WORKSHOP)) return res.status(400).send('bad path');
  try { res.type('text/plain').send(await fsp.readFile(full, 'utf8')); } catch { res.status(404).send('not found'); }
});
app.get('/api/workshop.zip', async (_req, res) => {
  // simple tar-less bundle: concatenate files with headers (Keeper copies into Cursor)
  const files = await workshopList(); let out = '';
  for (const f of files) { try { out += `\n\n===== FILE: ${f} =====\n` + await fsp.readFile(path.join(WORKSHOP, f), 'utf8'); } catch {} }
  res.setHeader('Content-Disposition', 'attachment; filename="workshop-bundle.txt"');
  res.type('text/plain').send(out || '(workshop empty)');
});
app.get('/api/dump', async (_req, res) => {
  try {
    const dir = path.join(__dirname, 'dump');
    const files = (await fsp.readdir(dir)).filter(f => /\.(md|txt)$/i.test(f)).sort();
    res.json(files);
  } catch { res.json([]); }
});
app.post('/api/continue', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'already running' });
  if (!state.topic) return res.status(400).json({ error: 'no session to continue' });
  runTurns(MAX_TURNS_PER_SESSION);
  res.json({ ok: true });
});
app.post('/api/say', (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 1000).trim();
  if (!text) return res.status(400).json({ error: 'say something' });
  state.transcript.push({ agent: 'keeper', name: 'KEEPER', emoji: '👤', color: '#1A1A1A', text, t: Date.now() });
  if (!state.running && state.topic) runTurns(Math.min(3, MAX_TURNS_PER_SESSION)); // wake them to answer you
  res.json({ ok: true });
});
app.get('/api/state', async (_req, res) => {
  const u = await usage();
  res.json({ ...state, usage: u, spendEstimate: +(u.calls * EST_COST_PER_CALL).toFixed(2), caps: { turns: MAX_TURNS_PER_SESSION, daily: DAILY_CALL_CAP }, brain: !!anthropic || TEST, agents: AGENTS.map(a => ({ name: a.name, emoji: a.emoji, color: a.color })) });
});
app.get('/api/notebook', async (_req, res) => {
  res.type('text/plain').send(await notebookText());
});
app.get('/health', (_req, res) => res.json({ ok: true, brain: !!anthropic || TEST, test: TEST }));

app.listen(PORT, () => console.log(`THE AVIARY open on :${PORT} | brain:${!!anthropic || TEST}${TEST ? ' (TEST MODE)' : ''}`));
