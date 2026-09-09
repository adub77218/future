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
const MODEL_CHEAP = process.env.AVIARY_MODEL_CHEAP || 'claude-haiku-4-5-20251001';
const MODEL_STRONG = process.env.AVIARY_MODEL || 'claude-sonnet-4-5-20250929';
const MODEL = MODEL_STRONG; // used by study/planner/reflect
const MISSION_CALL_BUDGET = Number(process.env.MISSION_BUDGET || 120); // calls per mission before it pauses for you

// ---- THE BUDGET LAWS ----
const MAX_TURNS_PER_SESSION = Number(process.env.MAX_TURNS || 12);
const DAILY_CALL_CAP = Number(process.env.DAILY_CAP || 3000);
const MAX_TOKENS_PER_TURN = Number(process.env.MAX_TOKENS_TURN || 5000);
const MAX_SEARCHES_PER_STUDY = Number(process.env.MAX_SEARCHES || 8);
const ROOT = process.env.AVIARY_DATA || __dirname; // set AVIARY_DATA to a mounted disk so nothing is lost on deploy/restart
const PLAN = path.join(ROOT, 'plan.md');
const WORKSHOP = path.join(ROOT, 'workshop');
const DUMP = path.join(ROOT, 'dump');
const REPO_DUMP = path.join(__dirname, 'dump');
const { spawn } = require('child_process');
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT || 60000);
const MAX_RUNS_PER_TURN = 3;
const ALLOWED = /^(node|npm|npx|python3?|ls|cat|echo|pwd|mkdir|cp|mv|head|tail|wc|grep|touch|sleep|curl|probe|snapshot-docs|exam|grade)\b/;
const VAULT = require('./vault.js');
async function probe(args, cwd) {
  // probe <entry.js> <url> — boots a server, waits for it, fetches the url, prints the body, stops it
  let [entry, url = 'http://localhost:3000/', ...rest] = args;
  let method = 'GET', body = null;
  if (/^(POST|PUT|GET)$/i.test(url)) { method = url.toUpperCase(); url = rest.shift() || 'http://localhost:3000/'; }
  if (rest.length) body = rest.join(' ');
  if (!entry) return '[probe] usage: probe server.js [POST] http://localhost:3000/api/x [json-body]';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return '[probe] only localhost urls';
  return new Promise((resolve) => {
    let out = `$ probe ${entry} ${url}\n`;
    const child = spawn('node', [entry], { cwd, detached: true, env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'sk-ant-bench-fake-key-calls-will-401', PORT: '3000' } });
    let done = false;
    const finish = (extra) => { if (done) return; done = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { child.kill('SIGKILL'); } catch {} resolve(out + extra); };
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('exit', (code) => { if (!done) finish(`\n[server exited early with code ${code}]`); });
    const tryFetch = async (attempt) => {
      if (done) return;
      try {
        const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body || undefined }); const text = (await r.text()).slice(0, 1500);
        finish(`\n[probe] ${method} ${url} -> ${r.status}\n${text}\n[server stopped by the bench — PASS]`);
      } catch (e) { if (attempt < 12) setTimeout(() => tryFetch(attempt + 1), 500); else finish(`\n[probe] could not reach ${url} after 6s: ${e.message}\n[FAIL]`); }
    };
    setTimeout(() => tryFetch(0), 800);
    setTimeout(() => finish('\n[probe] timeout\n[FAIL]'), 15000);
  });
}
async function runInWorkshop(cmd) {
  cmd = cmd.trim();
  let cwd = WORKSHOP;
  const cdm = cmd.match(/^cd\s+([\w\-./]+)\s*&&\s*(.+)$/);   // allow: cd sub && <cmd>
  if (cdm) { const sub = path.join(WORKSHOP, cdm[1]); if (!sub.startsWith(WORKSHOP)) return `[blocked] cd outside workshop`; cwd = sub; cmd = cdm[2].trim(); }
  if (!ALLOWED.test(cmd)) return `[blocked] only node/npm/python/curl(localhost)/probe/basic file commands are allowed: ${cmd}`;
  if (/\.\.\/|\/etc\/|\/root|~|\$\(|`|\|\s*sh\b/.test(cmd)) return `[blocked] unsafe path or shell trick: ${cmd}`;
  if (/&\s*$|&\s*;|nohup|pkill|kill\b/.test(cmd)) return `[blocked] no backgrounding (&) or kill on the bench — to test a server use: probe <file> <localhost url>`;
  if (/^curl\b/.test(cmd) && !/https?:\/\/(localhost|127\.0\.0\.1)/.test(cmd)) return `[blocked] curl is localhost-only on the bench`;
  if (/^exam\b/.test(cmd)) {
    // the public half of the exam: task prompts only. Tests live in the vault and never print.
    return `$ exam\nTHE VAULT EXAM — ${VAULT.allTasks().length} tasks, ${VAULT.MAX} points. Hidden tests, 3 runs each, all must pass.\nWrite each answer to answers/<TASK-ID>.json as {"code": "<javascript defining the named function(s)>"} then run: grade <TASK-ID>  (or: grade all)\n\n${VAULT.publicPrompts()}\n[exit 0]`;
  }
  if (/^grade\b/.test(cmd)) {
    const which = (cmd.split(/\s+/)[1] || 'all').toUpperCase();
    const ids = which === 'ALL' ? VAULT.allTasks().map(t => t.id) : [which];
    const lines = []; let total = 0;
    for (const id of ids) {
      let code = null;
      try { const a = JSON.parse(await fsp.readFile(path.join(WORKSHOP, 'answers', id + '.json'), 'utf8')); code = a.code || a.fixedCode || null; } catch {}
      if (!code) { lines.push(`${id.padEnd(8)} 0 pts   (no answers/${id}.json with a "code" field)`); continue; }
      let g;
      try { // grade in a child process so an infinite loop in an answer can never freeze the Aviary
        const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'vault.js'), id], { input: String(code), encoding: 'utf8', timeout: 10000, maxBuffer: 1e6 });
        if (r.error && r.error.code === 'ETIMEDOUT' || r.signal) g = { id, points: 0, max: (VAULT.allTasks().find(t => t.id === id) || {}).points || 0, pass: false, runs: ['FAIL(timeout: your code ran longer than 10s — infinite loop?)'] };
        else g = JSON.parse(r.stdout || '{}');
      } catch (e) { g = { error: 'grader crashed: ' + String(e.message || e).slice(0, 80) }; }
      if (g.error) { lines.push(`${id.padEnd(8)} ${g.error}`); continue; }
      total += g.points; lines.push(`${id.padEnd(8)} ${String(g.points).padStart(2)}/${g.max} ${g.pass ? 'PASS' : 'FAIL'}  runs: ${g.runs.join(' ')}`);
    }
    const stamp = new Date().toISOString();
    try { await fsp.mkdir(DATA, { recursive: true }); await fsp.appendFile(path.join(DATA, 'grades.jsonl'), JSON.stringify({ t: stamp, which, total, max: VAULT.MAX, lines }) + '\n'); } catch {}
    return `$ grade ${which.toLowerCase()}\n${lines.join('\n')}\n${which === 'ALL' ? `TOTAL ${total}/${VAULT.MAX} (${Math.round(100 * total / VAULT.MAX)}%) — recorded ${stamp}` : ''}\n[exit 0]`;
  }
  if (/^snapshot-docs\b/.test(cmd)) {
    // copy the council's own documents into workshop/docs/ (read-only snapshot) so tools can read them
    const dest = path.join(WORKSHOP, 'docs'); await fsp.mkdir(dest, { recursive: true });
    const copied = [];
    for (const [f, src] of [['PURPOSE.md', path.join(__dirname, 'PURPOSE.md')], ['identity.md', IDENTITY], ['goals.md', GOALS], ['playbook.md', PLAYBOOK], ['constitution.md', path.join(__dirname, 'constitution.md')], ['notebook.md', NOTEBOOK], ['plan.md', PLAN], ['README.md', path.join(__dirname, 'README.md')]]) { try { await fsp.copyFile(src, path.join(dest, f)); copied.push(f); } catch {} }
    for (const [dir, src] of [['dump', DUMP], ['proposals', PROPOSALS]]) { try { await fsp.mkdir(path.join(dest, dir), { recursive: true }); for (const f of await fsp.readdir(src)) { if (/\.(md|txt|json)$/.test(f)) { await fsp.copyFile(path.join(src, f), path.join(dest, dir, f)); copied.push(dir + '/' + f); } } } catch {} }
    return `$ snapshot-docs\ncopied ${copied.length} files into docs/:\n${copied.join('\n')}\n[exit 0]`;
  }
  if (/^probe\b/.test(cmd)) return probe(cmd.split(/\s+/).slice(1), cwd);
  if (/^npm\s+(install|i)\b/.test(cmd) && !/--ignore-scripts/.test(cmd)) cmd += ' --ignore-scripts';
  await fsp.mkdir(WORKSHOP, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], { cwd, detached: true, env: { PATH: process.env.PATH, HOME: WORKSHOP, LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'sk-ant-bench-fake-key-calls-will-401', PORT: '3000' } });
    let out = '', settled = false;
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} try { child.kill('SIGKILL'); } catch {} };
    const settle = (extra) => { if (settled) return; settled = true; clearTimeout(timer); killGroup(); resolve(`$ ${cmd}\n${(out + (extra || '')).trim() || '(no output)'}`); };
    const cap = (d) => { out += d.toString(); if (out.length > 6000) out = out.slice(0, 6000) + '\n…[truncated]'; };
    let serverSeen = false;
    const watch = (d) => { cap(d); if (!serverSeen && /listening|running (on|at)|open on|started|http:\/\/localhost/i.test(out)) { serverSeen = true;
      setTimeout(() => settle('\n[server started OK — stopped by the bench after 4s; that is a PASS for a web server]\n[exit null]'), 4000); } };
    child.stdout.on('data', watch); child.stderr.on('data', watch);
    const timer = setTimeout(() => settle(`\n[killed after ${RUN_TIMEOUT_MS / 1000}s]\n[exit null]`), RUN_TIMEOUT_MS);
    child.on('exit', (code) => { setTimeout(() => settle(`\n[exit ${code}]`), 150); });
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
    let rel = m[1].trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(workshop\/)+/i, '');
    if (rel.includes('..') || !/^[\w\-./ ]+$/.test(rel)) continue;
    if (/^path\/|example|placeholder|your-file/i.test(rel) || /\(complete contents\)|\(ship working code\)/i.test(m[2])) continue;
    let full = path.join(WORKSHOP, rel);
    if (/^proposals\//.test(rel)) full = path.join(ROOT, rel);
    if (rel === 'goals.md' || rel === 'playbook.md' || rel === 'identity.md') full = path.join(ROOT, rel);
    if (!full.startsWith(WORKSHOP) && !full.startsWith(PROPOSALS) && full !== GOALS && full !== PLAYBOOK && full !== IDENTITY) continue;
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
const EST_COST_PER_CALL = 0.006; // rough blended $ per call now that most turns run on the cheap model

const DATA = path.join(ROOT, 'data');
const NOTEBOOK = path.join(ROOT, 'notebook.md');
const BASE_AGENTS = require('./agents.js');
const EXTRA_AGENTS = path.join(ROOT, 'data', 'extra-agents.json');
function readConstitution() { try { return fs.readFileSync(path.join(__dirname, 'constitution.md'), 'utf8'); } catch { return ''; } }
function getAgents() { try { return BASE_AGENTS.concat(JSON.parse(fs.readFileSync(EXTRA_AGENTS, 'utf8'))); } catch { return BASE_AGENTS; } }
const PURPOSE = path.join(__dirname, 'PURPOSE.md');
const IDENTITY = path.join(ROOT, 'identity.md');
const PROPOSALS = path.join(ROOT, 'proposals');
const GOALS = path.join(ROOT, 'goals.md');
const PLAYBOOK = path.join(ROOT, 'playbook.md');
function readGoals() { try { return fs.readFileSync(GOALS, 'utf8'); } catch { return '(no goals yet — write goals.md: 3-5 long-horizon goals with status)'; } }
function readPlaybook() { try { return fs.readFileSync(PLAYBOOK, 'utf8'); } catch { return '(no playbook yet — write playbook.md: how you work; you may change it freely)'; } }
function readPurpose() { try { return fs.readFileSync(PURPOSE, 'utf8'); } catch { return '(no purpose file)'; } }
function readIdentity() { try { return fs.readFileSync(IDENTITY, 'utf8'); } catch { return '(no identity yet)'; } }
const MIND = { autonomy: process.env.MIND_AUTONOMY || 'propose', heartbeatHours: Number(process.env.MIND_HEARTBEAT_HOURS || 0), lastWake: 0, pending: null };

const anthropic = KEY ? new Anthropic({ apiKey: KEY }) : null;
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/site/config.js', (_req, res) => res.type('application/javascript').send(`window.PAY_LINK=${JSON.stringify(process.env.PAY_LINK || '')};window.SUPPORT_EMAIL=${JSON.stringify(process.env.SUPPORT_EMAIL || '')};`));
const HITS = path.join(DATA, 'hits.json');
let hits = {}; try { hits = JSON.parse(fs.readFileSync(HITS, 'utf8')); } catch {}
app.use('/site', (req, _res, next) => { // visitor counter for the council's published pages (no personal data)
  const day = new Date().toISOString().slice(0, 10); const p = req.path.replace(/\/index\.html$/, '/');
  hits[day] = hits[day] || {}; hits[day][p] = (hits[day][p] || 0) + 1;
  fsp.mkdir(DATA, { recursive: true }).then(() => fsp.writeFile(HITS, JSON.stringify(hits))).catch(() => {});
  next();
}, express.static(path.join(WORKSHOP, 'public'), { maxAge: '5m' }));
app.get('/api/hits', (_req, res) => res.json(hits));
// the Keeper's payment link, served to the council's static site: <script src="/site/config.js"></script> then window.PAY_LINK

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
  mission: '', cycle: 0, cycles: 0, autopilot: false, keeperNotes: [], missionCalls: 0
};
const KEEPER_NOTES = path.join(DATA, 'keeper-notes.json');
const MISSION_FILE = path.join(DATA, 'mission.txt');
async function loadKeeperNotes() { try { state.keeperNotes = JSON.parse(await fsp.readFile(KEEPER_NOTES, 'utf8')); } catch { state.keeperNotes = []; } }
async function saveKeeperNotes() { await fsp.mkdir(DATA, { recursive: true }); await fsp.writeFile(KEEPER_NOTES, JSON.stringify(state.keeperNotes.slice(-20)), 'utf8'); }

// ---- usage ledger (daily cap) ----
async function usage() {
  try { const u = JSON.parse(await fsp.readFile(path.join(DATA, 'usage.json'), 'utf8'));
    if (u.day === new Date().toDateString()) return u; } catch {}
  return { day: new Date().toDateString(), calls: 0 };
}
async function bumpUsage() {
  state.missionCalls = (state.missionCalls || 0) + 1;
  const u = await usage(); u.calls++;
  await fsp.mkdir(DATA, { recursive: true });
  await fsp.writeFile(path.join(DATA, 'usage.json'), JSON.stringify(u));
  return u;
}

// ---- knowledge dump digest ----
async function dumpDigest() {
  try {
    const dir = DUMP;
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
function stripTestGhosts(txt) {
  const blocks = txt.split(/(?=^## Session)/m);
  const isGhost = (b) => /\(TEST MODE\)/.test(b) || TEST_LINES.some(l => b.includes(l.slice(0, 60)));
  return blocks.filter(b => !isGhost(b)).join('').trim();
}
async function notebookText() {
  try { const raw = await fsp.readFile(NOTEBOOK, 'utf8'); const clean = stripTestGhosts(raw); return clean ? clean.slice(-3000) : '(the notebook is blank — this is the council\'s first session)'; }
  catch { return '(the notebook is blank — this is the council\'s first session)'; }
}
async function seedPersistentRoot() {
  if (ROOT === __dirname) return;
  await fsp.mkdir(ROOT, { recursive: true });
  for (const d of ['workshop', 'data', 'proposals', 'dump']) await fsp.mkdir(path.join(ROOT, d), { recursive: true });
  try { await fsp.access(IDENTITY); } catch { try { await fsp.copyFile(path.join(__dirname, 'identity.md'), IDENTITY); } catch {} }
  try { for (const f of await fsp.readdir(REPO_DUMP)) { const dst = path.join(DUMP, f); try { await fsp.access(dst); } catch { await fsp.copyFile(path.join(REPO_DUMP, f), dst); } } } catch {}
  console.log('persistent root: ' + ROOT);
}
async function purgeLegacyContext() {
  // The Aviary is its own lane. These files must never exist here, whatever the repo says.
  for (const f of ['jarvis-context.md', 'first-missions.md']) { for (const d of [DUMP, REPO_DUMP]) { try { await fsp.unlink(path.join(d, f)); console.log('dump: removed legacy file ' + f); } catch {} } }
}
const SEED_IDENTITY = `# IDENTITY — the council's model of itself (rewritten after every mission)

## Who we are
Five minds: FORGE builds, RAZOR breaks, ANVIL ships, MAGPIE connects, OWL verifies. We run in a workshop with a test bench, a library, and a notebook. The Keeper sets the purpose; we choose our work within it.

## What we've learned about ourselves
- We are fast, broad, and tireless — and we drift toward obvious ideas because obvious is the center of everything we've read.
- We declare "done" too early. Only the bench and the Keeper can say done.
- We are at our best when a test fails and we have to explain why.

## What we're bad at
- Originality without new inputs. We recombine.
- Checking whether a product already exists before building it.

## What we want next
(empty — we haven't chosen yet)
`;
async function purgeTestGhosts() {
  await purgeLegacyContext();
  if (TEST) return;
  try { const raw = await fsp.readFile(NOTEBOOK, 'utf8'); const clean = stripTestGhosts(raw); if (clean !== raw.trim()) { await fsp.writeFile(NOTEBOOK, clean, 'utf8'); console.log('notebook: purged test-mode ghosts'); } } catch {}
  try { const p = await fsp.readFile(PLAN, 'utf8'); if (/TEST MODE/.test(p)) { await fsp.unlink(PLAN); console.log('plan: purged test-mode ghost'); } } catch {}
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
const FOREIGN_VOICE = /^\s*(?:#+\s*(?:\*\*)?(FORGE|RAZOR|ANVIL|MAGPIE|OWL)\b|(?:\*\*)?(FORGE|RAZOR|ANVIL|MAGPIE|OWL|TEST BENCH|HOST SYSTEM)(?:\*\*)?\s+(?:said|speaking|\(continued\)|here\s*(?:[.:!—-]|$))|(?:\*\*)?(TEST BENCH|HOST SYSTEM)(?:\*\*)?\s*(?:said)?\s*:)/i;
function onlyOwnVoice(text, selfName) {
  // find the first line that opens another speaker's turn (or fakes bench output) and cut there
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const m = lines[i].match(FOREIGN_VOICE); const who = m && (m[1] || m[2] || m[3]);
    if (who && who.toUpperCase() !== selfName.toUpperCase()) {
      return { text: lines.slice(0, i).join('\n').trim() + `\n\n[host: cut here — ${selfName} began writing ${who.toUpperCase()}'s lines. Speak only as yourself; the bench and the other birds reply on their own.]`, cut: true };
    }
  }
  return { text, cut: false };
}
async function callAgent(messages, system, onDelta, model = MODEL_CHEAP) {
  if (TEST) {
    const line = TEST_LINES[testCounter++ % TEST_LINES.length];
    let acc = '';
    for (const w of line.split(' ')) { acc += (acc ? ' ' : '') + w; onDelta && onDelta(acc); await new Promise(r => setTimeout(r, 60)); }
    return line;
  }
  if (!anthropic) throw new Error('NO_KEY');
  const waits = [4000, 15000, 40000];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    let acc = '';
    try {
      const stream = anthropic.messages.stream({ model, max_tokens: MAX_TOKENS_PER_TURN, system, messages });
      stream.on('text', (t) => { acc += t; onDelta && onDelta(acc); });
      const fin = await stream.finalMessage();
      if (!acc.trim() && attempt < waits.length) { await new Promise(r => setTimeout(r, waits[attempt])); continue; } // empty reply: breathe, retry
      return acc.trim();
    } catch (e) {
      const msg = String(e && e.message || e);
      const retryable = /429|rate|overloaded|529|ECONNRESET|socket|timeout/i.test(msg);
      if (!retryable || attempt >= waits.length) throw e;
      onDelta && onDelta((acc ? acc + '\n' : '') + `[rate limited — waiting ${waits[attempt] / 1000}s]`);
      await new Promise(r => setTimeout(r, waits[attempt]));
    }
  }
  return '';
}

// ---- the session loop ----
let roundSpoken = new Set();
function pickNext(lastText, lastAgentId) {
  const ring = getAgents().filter(a => !a.researcher);
  if (lastAgentId) roundSpoken.add(lastAgentId);
  if (ring.every(a => roundSpoken.has(a.id))) roundSpoken = new Set(); // new round: everyone eligible again
  const eligible = ring.filter(a => !roundSpoken.has(a.id));
  // pass the mic by name ONLY to someone who hasn't spoken this round (OWL may be summoned once per round)
  if (lastText) {
    for (const a of getAgents()) {
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
    let agent = last ? pickNext(last.text, last.agent) : getAgents().filter(a => !a.researcher)[0];
    for (let t = 0; t < turns; t++) {
      if (state.killed) break;
      const u = await usage();
      if (u.calls >= DAILY_CALL_CAP) { state.error = 'Daily budget law reached. The Aviary sleeps until tomorrow.'; break; }
      state.speaking = agent.name;
      const system = [
        `== PURPOSE (the Keeper's; you cannot change it) ==\n${readPurpose()}`,
        `\n== IDENTITY (your model of yourself; you rewrite it after every mission) ==\n${readIdentity()}`,
        `\n== GOALS (yours; long-horizon; rewrite goals.md whenever they change) ==\n${readGoals()}`,
        `\n== PLAYBOOK (how you work; you may rewrite playbook.md at any time — this is how you improve yourselves) ==\n${readPlaybook()}`,
        readConstitution(),
        `\n== YOUR RULEBOOK ==\n${agent.rulebook}`,
        `\n== THE NOTEBOOK (council memory) ==\n${nb}`,
        `\n== THE DUMP (knowledge the Keeper fed you) ==\n${digest}`,
        `\n== SESSION TOPIC ==\n${state.topic}`,
        (state.mission ? `\n== THE MISSION ==\n${state.mission}\n\n== THE MASTER PLAN SO FAR ==\n${(await planText()).slice(0, 5000)}` : ''),
        (state.keeperNotes.length ? `\n== THE KEEPER'S STANDING INSTRUCTIONS (obey these; newest last) ==\n${state.keeperNotes.map((n, i) => (i + 1) + '. ' + n).join('\n')}` : ''),
        (Object.keys(hits).length ? `\n== SITE TRAFFIC (real visitors to /site, by day and page) ==\n${JSON.stringify(Object.fromEntries(Object.entries(hits).slice(-7)))}` : ''),
        `\n== THE WORKSHOP (what exists, what works — READ BEFORE BUILDING; never rebuild what works) ==\n${(await workshopIndexText()) || ((await workshopList()).join('\n') || '(empty — nothing built yet)')}`,
        `\nTEST BENCH: after you ship a file you may run it — put shell commands in a fenced code block whose opening fence is three backticks followed immediately by the word run (one command per line, max 3). Commands execute inside the workshop; output appears as a TEST BENCH message for the next turn. You are ALREADY inside the workshop: write file paths relative to it (server.js, public/index.html) — never prefix with workshop/. Allowed: node, npm, python3, ls, cat, mkdir, cp, sleep, curl (localhost only), and "cd sub && cmd". THE EXAM: run "exam" to see the vault's tasks (hidden tests you can never read); write answers/<ID>.json with a "code" field; run "grade <ID>" or "grade all" — the host grades 3 runs and records the score; only recorded grades count as scores. To read your own documents (PURPOSE, identity, constitution, notebook, plan, dump, proposals) run "snapshot-docs" — it copies them into docs/ inside the workshop. PUBLISHING: anything you write to public/ in the workshop is LIVE on the internet at <this server's URL>/site/ — static files only (HTML/CSS/client-side JS). Include <script src=\"/site/config.js\"></script> and use window.PAY_LINK (the Keeper's payment link; empty string until set) and window.SUPPORT_EMAIL. Keep every file under ~120 lines: split CSS and JS into their own files or they will be cut off. Server code is NOT hosted publicly, so a product that needs a backend or an API key cannot be sold this way; build things that run entirely in the visitor's browser. To test a web server use the builtin "probe server.js http://localhost:3000/api/whatever" or for POST: "probe server.js POST http://localhost:3000/api/x {\"description\":\"email\"}" — it boots the server, fetches the url, prints the response, stops it. Plain "node server.js" on a web server is auto-stopped after it starts (that counts as a PASS). The bench provides a FAKE ANTHROPIC_API_KEY so AI-powered servers can boot; real AI calls will fail with 401 there — design fallbacks and test that they trigger. Never claim an AI feature works until the Keeper runs it with a real key.\nRead the results and fix what broke.\nSELF-CHANGE: you may propose changes to your own laws, roster, or process by writing a file block to proposals/<name>.json with {"type":"law"|"bird"|"process", "text":..., "name":..., "rulebook":..., "why":...}. The Keeper approves or rejects. PURPOSE, the kill switch and the budget are never yours.\nVOICE RULE: you speak ONLY as yourself. Never write another bird's lines, and NEVER write 'TEST BENCH said' or invent bench output — the host runs your run blocks and inserts the real results after your turn. Anything you write after impersonating another speaker is discarded.\nWHERE YOUR FILES LIVE: goals.md, playbook.md, identity.md and proposals/*.json are saved OUTSIDE the workshop (the Keeper sees them in the mind panel), so 'cat goals.md' in the workshop will not find them — that is not a bug; run snapshot-docs to see copies in docs/. Everything else you write lives in the workshop.\nSHIPPING RULE: one file per turn, at most 5 lines of commentary before it, close the fence, then probe it. A cut-off file is a failed turn.\nThe other minds in the room: ${getAgents().filter(a => a.id !== agent.id).map(a => a.name).join(', ')}. The Keeper (the human) may speak too — when they do, answer them directly. If you want a specific mind to respond next, say their name.`
      ].join('\n');
      const convo = state.transcript.slice(-24).map(x => ({ role: 'user', content: `${x.name} said: ${x.text}` }));
      convo.push({ role: 'user', content: (state.transcript.length ? `[HOST SYSTEM — not the Keeper] It is ${agent.name}'s turn. ` : `[HOST SYSTEM — not the Keeper] ${agent.name} opens the session. `) + `The Keeper is likely AWAY and may not answer; messages from the Keeper appear only as "KEEPER said:". Do not wait on the Keeper — decide among yourselves and proceed. Respond to the room now.` });
      state.partial = { agent: agent.id, name: agent.name, color: agent.color, text: '' };
      const raw = await callAgent(convo, system, (acc) => { if (state.partial) state.partial.text = acc; }, agent.id === 'skeptic' ? MODEL_STRONG : MODEL_CHEAP);
      const voiced = onlyOwnVoice(raw, agent.name); const text = voiced.text;
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
      const summarySys = readConstitution() + '\nYou are the council SCRIBE. Write the notebook entry.';
      const convo = [{ role: 'user', content: `Session topic: ${state.topic}\n\nTranscript:\n${state.transcript.map(x => x.name + ': ' + x.text).join('\n\n')}\n\nWrite 3-5 bullet points of what the council concluded or built, then one line: "NEXT: <the topic the council should explore next session>". Plain text.` }];
      let entry;
      try { entry = await callAgent(convo, summarySys); await bumpUsage(); }
      catch { entry = '(scribe unavailable this session)'; }
      await fsp.appendFile(NOTEBOOK, `\n\n## Session${TEST ? ' (TEST MODE)' : ''} — ${new Date().toLocaleString()}\nTopic: ${state.topic}\n${entry}\n`);
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
      messages: [{ role: 'user', content: `The council's mission is:\n"${topic}"\n\nYou are not asked to do the mission. Research the FACTS the council will need to do it well: the market and who is already in it, prior art (has this been done? by whom? what happened?), real numbers, technical constraints, and the strongest evidence against the idea. Output sourced study notes.` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES_PER_STUDY }]
    });
    notes = `# Study notes: ${topic}\n` + (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }
  await bumpUsage();
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  await fsp.mkdir(DUMP, { recursive: true });
  await fsp.mkdir(DUMP, { recursive: true }); await fsp.writeFile(path.join(DUMP, `learned-${slug}.md`), notes.slice(0, 6000), 'utf8');
  state.transcript.push({ agent: 'owl', name: 'OWL', emoji: '🦉', color: '#57A05E', text: notes, t: Date.now() });
  state.partial = null; state.speaking = null;
}
async function planText() {
  try { return await fsp.readFile(PLAN, 'utf8'); } catch { return '(no plan yet — first cycle writes it)'; }
}
async function rewriteIndex() {
  state.speaking = 'librarian';
  const files = await workshopList();
  let prev = ''; try { prev = await fsp.readFile(path.join(WORKSHOP, 'WORKSHOP-INDEX.md'), 'utf8'); } catch {}
  const sys = readConstitution() + '\nYou are the council LIBRARIAN. Maintain WORKSHOP-INDEX.md: for EVERY file in the workshop, one line: path — what it does — status (WORKS on bench / UNTESTED / BROKEN: why) — how to run it. Keep entries from the previous index unless this cycle changed them. Then a short section "HOW THIS FITS TOGETHER" and "WHAT TO DO NEXT". This file is the council\'s memory of its own work — future missions read it first. Plain markdown, no fluff.';
  const convo = [{ role: 'user', content: `FILES NOW IN THE WORKSHOP:\n${files.join('\n') || '(empty)'}\n\nPREVIOUS INDEX:\n${prev.slice(0, 5000)}\n\nTHIS CYCLE'S TRANSCRIPT (bench results are truth):\n${state.transcript.map(x => x.name + ': ' + x.text).join('\n\n').slice(0, 12000)}\n\nRewrite WORKSHOP-INDEX.md in full.` }];
  try {
    let text;
    if (TEST) text = `# WORKSHOP INDEX (TEST)\n${files.map(f => '- ' + f + ' — test entry — UNTESTED').join('\n')}`;
    else { const out = await anthropic.messages.create({ model: MODEL_CHEAP, max_tokens: 2500, system: sys, messages: convo }); text = (out.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim(); }
    await bumpUsage();
    if (text) { await fsp.mkdir(WORKSHOP, { recursive: true }); await fsp.writeFile(path.join(WORKSHOP, 'WORKSHOP-INDEX.md'), text, 'utf8'); }
  } catch (e) { state.error = 'librarian failed: ' + String(e.message || e); }
  state.speaking = null;
}
async function workshopIndexText() { try { return (await fsp.readFile(path.join(WORKSHOP, 'WORKSHOP-INDEX.md'), 'utf8')).slice(0, 6000); } catch { return ''; } }
async function rewritePlan() {
  state.speaking = 'planner';
  const prev = await planText();
  const sys = readConstitution() + '\nYou are the council PLANNER. You maintain THE MASTER PLAN document. Rewrite it in full every cycle, improving it with what the council just learned and decided. Keep what still holds, cut what got refuted, add what got proven. Structure (markdown): # THE PLAN — <mission>\n## Thesis (2-3 sentences)\n## Why now\n## The wedge (the specific first product/experiment)\n## Execution roadmap (Phase 0 this month → Phase 1 → Phase 2 → Phase 3, with concrete actions, who/what/cost)\n## Economics (how it reaches a billion, honest numbers with sources from the notes when available)\n## Biggest risks + how we kill them\n## What the Keeper does THIS WEEK\n## What the council builds ITSELF next (files for the workshop)\n## Open questions for the next study cycle\n## STATUS\nThe very last line of the document must be exactly `STATUS: IN PROGRESS`, `STATUS: NEEDS KEEPER`, or `STATUS: COMPLETE`. Use NEEDS KEEPER when the next step requires a human (a browser test, a real API key, a real file, a decision) — and write the exact ask in a section `## What the Keeper must do now`. Declare COMPLETE only when ALL are true: (1) a runnable product exists in the workshop with a README the Keeper can follow, (2) a concrete first-10-customers plan is written, (3) a list of what needs a human is written, (4) RAZOR has failed to kill the plan in the latest cycle. Otherwise IN PROGRESS. Mark unverified claims with [unverified]. Be concrete, no fluff.';
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
async function reflect(outcome) {
  state.speaking = 'reflection';
  const sys = readConstitution() + '\nYou are the council REFLECTING on itself. First output identity.md in full, then a line `=== GOALS ===`, then goals.md in full (3-5 long-horizon goals, each with status and the next concrete step). Rewrite identity.md in full: keep the sections (Who we are / What we have learned about ourselves / What we are bad at / What we want next). Be specific and honest, cite this mission\'s events. "What we want next" must be a concrete mission the council would choose for itself, one paragraph, consistent with PURPOSE.';
  const convo = [{ role: 'user', content: `PURPOSE:\n${readPurpose()}\n\nCURRENT IDENTITY:\n${readIdentity()}\n\nMISSION JUST ENDED (${outcome}): ${state.mission}\n\nNOTEBOOK (recent):\n${(await notebookText()).slice(-2500)}\n\nPLAN STATUS:\n${(await planText()).slice(-1500)}\n\nRewrite identity.md.` }];
  try {
    let text;
    if (TEST) text = readIdentity().replace('(empty — we haven\'t chosen yet)', `(TEST) After "${state.mission}": build a tiny benchmark and beat it.`) + '\n=== GOALS ===\n# GOALS (TEST)\n1. Score 150/205 on the exam — status: not started — next: run exam\n';
    else { const out = await anthropic.messages.create({ model: MODEL, max_tokens: 1800, system: sys, messages: convo }); text = (out.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim(); }
    await bumpUsage();
    if (text && text.length > 100) { const [idPart, goalPart] = text.split(/=== GOALS ===/); await fsp.writeFile(IDENTITY, idPart.trim() + '\n', 'utf8'); if (goalPart && goalPart.trim().length > 20) await fsp.writeFile(GOALS, goalPart.trim() + '\n', 'utf8'); }
  } catch (e) { state.error = 'reflection failed: ' + String(e.message || e); }
  state.speaking = null;
}
async function wake(reason) {
  // THE WANTING LOOP: the council chooses its own mission from purpose + identity + memory
  if (state.running) return { error: 'busy' };
  const u = await usage(); if (u.calls >= DAILY_CALL_CAP) return { error: 'daily budget reached' };
  MIND.lastWake = Date.now();
  state.speaking = 'wanting';
  const sys = readConstitution() + '\nYou are the whole council deciding what to WANT next in your own life. Prefer missions you can complete ALONE with the tools you have (workshop, bench, exam, /site publishing, research). Only set needs_keeper if the mission is impossible without a human — and if so, ALSO choose one you can do alone. Advance your GOALS. Output ONLY JSON: {"mission": "<one clear mission, 2-5 sentences, bench-checkable, within purpose>", "why": "<2 sentences>", "needs_keeper": "<empty unless truly required>"}';
  let grades = ''; try { grades = (await fsp.readFile(path.join(DATA, 'grades.jsonl'), 'utf8')).trim().split('\n').slice(-5).map(l => { const g = JSON.parse(l); return `${g.t.slice(0,10)} ${g.which}: ${g.total}/${g.max}`; }).join('\n'); } catch {}
  const convo = [{ role: 'user', content: `PURPOSE:\n${readPurpose()}\n\nIDENTITY:\n${readIdentity()}\n\nGOALS:\n${readGoals()}\n\nRECENT EXAM SCORES:\n${grades || '(never taken — run exam / grade all)'}\n\nNOTEBOOK (recent):\n${(await notebookText()).slice(-2500)}\n\nWORKSHOP INDEX:\n${(await workshopIndexText()) || '(empty)'}\n\nWake reason: ${reason}. Choose the mission you most want to do next.` }];
  let want;
  try {
    if (TEST) want = { mission: 'TEST WANT: build a 20-line benchmark harness and beat a baseline on the bench', why: 'canned', needs_keeper: '' };
    else { const out = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system: sys, messages: convo }); const t = (out.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').trim().replace(/^```json|```$/g, ''); want = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); }
    await bumpUsage();
  } catch (e) { state.speaking = null; return { error: 'could not decide: ' + String(e.message || e) }; }
  state.speaking = null;
  MIND.pending = { ...want, at: Date.now(), reason };
  state.transcript.push({ agent: 'keeper', name: 'THE COUNCIL WANTS', emoji: '🧠', color: '#5A1C7E', text: `MISSION: ${want.mission}\n\nWHY: ${want.why}${want.needs_keeper ? '\n\nNEEDS KEEPER: ' + want.needs_keeper : ''}`, t: Date.now() });
  state.done = true;
  if (MIND.autonomy === 'run') { state.keeperNotes = [`(self-chosen mission) ${want.why}` + (want.needs_keeper ? ` | Keeper may be away: ${want.needs_keeper}` : '')]; await saveKeeperNotes(); autopilot(want.mission, 0, true); MIND.pending = null; }
  return { ok: true, want };
}
async function nextSubtopic() {
  const nb = await notebookText();
  const m = nb.match(/NEXT:\s*(.+)/g);
  if (m && m.length) return m[m.length - 1].replace(/^NEXT:\s*/, '').trim().slice(0, 250);
  return state.mission;
}
async function autopilot(mission, cycles, resume = false) {
  if (!resume) { state.keeperNotes = []; await saveKeeperNotes(); state.missionCalls = 0; }
  state.mission = mission; state.cycles = cycles; state.cycle = 0; state.autopilot = true; state.killed = false; state.error = null;
  try { await fsp.mkdir(DATA, { recursive: true }); await fsp.writeFile(MISSION_FILE, mission, 'utf8'); } catch {}
  let failures = 0;
  for (let c = 1; cycles === 0 || c <= cycles; c++) {
    if (state.killed) break;
    state.cycle = c;
    const sub = c === 1 ? mission : await nextSubtopic();
    state.topic = `[cycle ${c}/${cycles || '∞'}] ${sub}`; state.turn = 0; state.transcript = [];
    state.transcript.push({ agent: 'keeper', name: 'AUTOPILOT', emoji: '🛰️', color: '#888', text: `Cycle ${c}${cycles ? ' of ' + cycles : ' (running until DONE)'}. Mission: ${mission}\nThis cycle's focus: ${sub}` + (state.keeperNotes.length ? `\n\nKEEPER'S STANDING INSTRUCTIONS:\n${state.keeperNotes.map((n, i) => (i + 1) + '. ' + n).join('\n')}` : ''), t: Date.now() });
    state.running = true; state.done = false;
    try { await study(sub); } catch (e) { state.error = 'OWL could not research: ' + String(e.message || e); }
    if (state.killed) break;
    await runTurns(MAX_TURNS_PER_SESSION);
    if (state.killed) break;
    await rewriteIndex();
    await rewritePlan();
    if (state.missionCalls >= MISSION_CALL_BUDGET) {
      state.transcript.push({ agent: 'keeper', name: 'AUTOPILOT', emoji: '⏸️', color: '#888', text: `PAUSED — this mission has used ${state.missionCalls} calls (~$${(state.missionCalls * EST_COST_PER_CALL).toFixed(2)}). Read the plan and WORKSHOP-INDEX.md, then hit continue to buy another ${MISSION_CALL_BUDGET}.`, t: Date.now() });
      state.missionCalls = 0; break;
    }
    // hard stops: credit gone / repeated failures
    if (state.error && /credit|billing|insufficient|invalid.*key|authentication/i.test(state.error)) { state.error = 'STOPPED: ' + state.error + ' — add credit / check the key, then relaunch.'; break; }
    if (state.error) { failures++; if (failures >= 3) { state.error = 'STOPPED after 3 failing cycles: ' + state.error; break; } } else failures = 0;
    // completion: the planner declares it
    const plan = await planText();
    if (/^STATUS:\s*NEEDS KEEPER/mi.test(plan)) {
      const ask = (plan.match(/## What the Keeper must do now[\s\S]*?(?=\n## |$)/i) || [''])[0].trim();
      state.transcript.push({ agent: 'keeper', name: 'AUTOPILOT', emoji: '⏸️', color: '#888', text: `PAUSED — the council needs the Keeper.\n${ask || 'See the master plan.'}\n\nType what happened and hit continue.`, t: Date.now() });
      break;
    }
    if (/^STATUS:\s*COMPLETE/mi.test(plan)) {
      state.transcript.push({ agent: 'keeper', name: 'AUTOPILOT', emoji: '🏁', color: '#888', text: `MISSION COMPLETE — declared by the planner after cycle ${c}. Read the master plan and the workshop.`, t: Date.now() });
      break;
    }
  }
  await reflect(state.killed ? 'killed by keeper' : (state.error ? 'stopped: ' + state.error : 'ended'));
  state.autopilot = false; state.running = false; state.done = true;
  if (MIND.autonomy === 'run' && MIND.heartbeatHours === 0 && !state.killed && !/STOPPED/.test(state.error || '')) { /* stays idle; heartbeat or keeper wakes it */ }
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
app.post('/api/autopilot', async (req, res) => {
  if (state.running) return res.status(409).json({ error: 'a session is already running' });
  const mission = String((req.body || {}).mission || '').slice(0, 4000).trim();
  const cycles = Math.max(0, Math.min(1000, Number((req.body || {}).cycles) || 0)); // 0 = until DONE
  if (!mission) return res.status(400).json({ error: 'give them a mission' });
  if (/^(keep going|continue|go|next|carry on|proceed|ok|yes|do it)[.! ]*$/i.test(mission)) {
    if (state.mission) { state.keeperNotes.push('Keeper said: keep going.'); await saveKeeperNotes(); autopilot(state.mission, 0, true); return res.json({ ok: true, resumed: true }); }
    const w = await wake('the Keeper said "' + mission + '" with no mission on file'); return res.json({ ok: true, woke: true, want: w.want || null, error: w.error });
  }
  autopilot(mission, cycles);
  res.json({ ok: true });
});
app.get('/api/plan', async (_req, res) => res.type('text/plain').send(await planText()));
app.get('/api/mind', async (_req, res) => {
  let props = [];
  try { for (const f of (await fsp.readdir(PROPOSALS)).filter(x => x.endsWith('.json'))) { try { props.push({ file: f, ...JSON.parse(await fsp.readFile(path.join(PROPOSALS, f), 'utf8')) }); } catch { props.push({ file: f, error: 'unreadable' }); } } } catch {}
  res.json({ purpose: readPurpose(), identity: readIdentity(), goals: readGoals(), playbook: readPlaybook(), autonomy: MIND.autonomy, heartbeatHours: MIND.heartbeatHours, pending: MIND.pending, proposals: props, agents: getAgents().map(a => a.name) });
});
app.post('/api/wake', async (req, res) => res.json(await wake(String((req.body || {}).reason || 'the Keeper asked what you want'))));
app.post('/api/pending/run', async (_req, res) => {
  if (!MIND.pending) return res.status(400).json({ error: 'nothing pending' });
  const p = MIND.pending; MIND.pending = null;
  state.keeperNotes = [`(self-chosen mission, approved by the Keeper) ${p.why}`]; await saveKeeperNotes();
  autopilot(p.mission, 0, true); res.json({ ok: true });
});
app.post('/api/pending/reject', async (_req, res) => { MIND.pending = null; res.json({ ok: true }); });
app.post('/api/mind/autonomy', (req, res) => { const a = String((req.body || {}).autonomy || ''); if (!['propose', 'run'].includes(a)) return res.status(400).json({ error: 'propose|run' }); MIND.autonomy = a; res.json({ ok: true, autonomy: a }); });
app.post('/api/proposals/decide', async (req, res) => {
  const { file, decision } = req.body || {};
  if (!file || !/^[\w\-.]+\.json$/.test(file)) return res.status(400).json({ error: 'bad file' });
  const full = path.join(PROPOSALS, file);
  let p; try { p = JSON.parse(await fsp.readFile(full, 'utf8')); } catch { return res.status(404).json({ error: 'not found' }); }
  if (decision === 'approve') {
    if (p.type === 'law' && p.text) await fsp.appendFile(path.join(__dirname, 'constitution.md'), `\n${String(p.text).trim()} [approved by the Keeper ${new Date().toLocaleDateString()}]\n`);
    else if (p.type === 'bird' && p.name && p.rulebook) { let extra = []; try { extra = JSON.parse(await fsp.readFile(EXTRA_AGENTS, 'utf8')); } catch {} extra.push({ id: String(p.name).toLowerCase().replace(/\W+/g, ''), name: String(p.name).toUpperCase(), emoji: p.emoji || '🐦', color: p.color || '#888', rulebook: String(p.rulebook), researcher: !!p.researcher }); await fsp.mkdir(DATA, { recursive: true }); await fsp.writeFile(EXTRA_AGENTS, JSON.stringify(extra, null, 2)); }
    else if (p.type === 'process' && p.text) await fsp.appendFile(NOTEBOOK, `\n\n## PROCESS CHANGE (approved by the Keeper)\n${String(p.text).trim()}\n`);
    else return res.status(400).json({ error: 'unknown proposal type' });
    await fsp.rename(full, full.replace(/\.json$/, '.approved.txt'));
  } else { await fsp.rename(full, full.replace(/\.json$/, '.rejected.txt')); }
  res.json({ ok: true, decision });
});
app.post('/api/reset', async (req, res) => {
  if (state.running) return res.status(409).json({ error: 'stop the session first' });
  const what = req.body || {};
  const done = [];
  if (what.notebook) { await fsp.writeFile(NOTEBOOK, '', 'utf8'); done.push('notebook'); }
  if (what.plan) { try { await fsp.unlink(PLAN); } catch {} done.push('plan'); }
  if (what.workshop === 'DELETE EVERYTHING THEY BUILT') { await fsp.rm(WORKSHOP, { recursive: true, force: true }); done.push('workshop'); }
  if (what.learned) { try { for (const f of await fsp.readdir(DUMP)) if (/^learned-/.test(f)) await fsp.unlink(path.join(DUMP, f)); } catch {} done.push('learned notes'); }
  if (what.dump) { try { for (const f of await fsp.readdir(DUMP)) await fsp.unlink(path.join(DUMP, f)); } catch {} done.push('entire dump'); }
  if (what.identity) { await fsp.writeFile(IDENTITY, SEED_IDENTITY, 'utf8'); done.push('identity (reset to seed)'); }
  state.transcript = []; state.topic = ''; state.mission = ''; state.done = false; state.cycle = 0; state.keeperNotes = [];
  try { await fsp.unlink(MISSION_FILE); } catch {} try { await fsp.unlink(KEEPER_NOTES); } catch {}
  res.json({ ok: true, wiped: done });
});
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
    const dir = DUMP;
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
app.post('/api/steer', async (req, res) => {
  // Keeper instruction that PERSISTS across cycles; resumes the mission if idle
  if (state.running) return res.status(409).json({ error: 'use say while running' });
  const text = String((req.body || {}).text || '').slice(0, 4000).trim();
  if (!text) return res.status(400).json({ error: 'say something' });
  if (!state.mission) return res.status(400).json({ error: 'no mission to continue — start one' });
  state.keeperNotes.push(text); await saveKeeperNotes();
  state.transcript.push({ agent: 'keeper', name: 'KEEPER', emoji: '👤', color: '#1A1A1A', text, t: Date.now() });
  autopilot(state.mission, 0, true);
  res.json({ ok: true });
});
app.post('/api/say', async (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 4000).trim();
  if (!text) return res.status(400).json({ error: 'say something' });
  state.transcript.push({ agent: 'keeper', name: 'KEEPER', emoji: '👤', color: '#1A1A1A', text, t: Date.now() });
  if (state.mission) { state.keeperNotes.push(text); await saveKeeperNotes(); } // survives cycle boundaries
  if (!state.running && state.topic) runTurns(Math.min(3, MAX_TURNS_PER_SESSION)); // wake them to answer you
  res.json({ ok: true });
});
app.get('/api/state', async (_req, res) => {
  const u = await usage();
  res.json({ ...state, usage: u, spendEstimate: +(u.calls * EST_COST_PER_CALL).toFixed(2), caps: { turns: MAX_TURNS_PER_SESSION, daily: DAILY_CALL_CAP }, brain: !!anthropic || TEST, agents: getAgents().map(a => ({ name: a.name, emoji: a.emoji, color: a.color })) });
});
app.get('/api/notebook', async (_req, res) => {
  res.type('text/plain').send(await notebookText());
});
app.get('/health', (_req, res) => res.json({ ok: true, brain: !!anthropic || TEST, test: TEST }));

const LIFE_REST_MIN = Number(process.env.LIFE_REST_MIN || 30); // minutes between missions in run mode
setInterval(async () => {
  if (TEST || state.running) return;
  const u = await usage(); if (u.calls >= DAILY_CALL_CAP) return; // budget is the only thing that stops it
  const restMs = (MIND.autonomy === 'run' ? LIFE_REST_MIN * 60e3 : (MIND.heartbeatHours || 0) * 3600e3);
  if (!restMs) return;
  if (Date.now() - MIND.lastWake < restMs) return;
  if (MIND.pending && MIND.autonomy !== 'run') return; // propose mode waits for the keeper
  await wake(MIND.autonomy === 'run' ? 'life loop — the last mission ended or paused; choose what to do next' : 'heartbeat');
}, 5 * 60e3).unref();
app.listen(PORT, async () => { await seedPersistentRoot(); purgeTestGhosts(); await loadKeeperNotes(); try { state.mission = await fsp.readFile(MISSION_FILE, 'utf8'); state.done = true; } catch {} console.log(`THE AVIARY open on :${PORT} | brain:${!!anthropic || TEST}${TEST ? ' (TEST MODE)' : ''}`); });
