"use strict";
// THE VAULT — the examiner's side of the Mind Project.
// The council sees only each task's `prompt`. The `tests` never leave this file.
// Scoring: every test must pass on 3 runs (candidate code is re-evaluated each run).

const CODE = [
  { id: 'CODE-1', points: 15, fn: 'intervalCoverage',
    prompt: `intervalCoverage(intervals) — intervals is an array of [start, end) pairs of integers (end may be less than start: treat as empty). Return the total length covered by their union. Overlaps count once. Empty array → 0.`,
    tests: [
      [[[1,4],[2,6]], 5], [[[1,4],[5,8]], 6], [[], 0], [[[3,3]], 0], [[[5,2]], 0],
      [[[-5,0],[-2,3],[10,12]], 10], [[[1,10],[2,3],[4,5],[6,7]], 9], [[[0,1],[0,1],[0,1]], 1],
      [[[1,1000000],[2,3]], 999999] ] },
  { id: 'CODE-2', points: 15, fn: 'parseDuration',
    prompt: `parseDuration(str) — parse strings like "1h30m15s", "2d", "45m", "3h 10s" into total seconds. Units: d h m s, each at most once, any order, optional spaces between parts, numbers are non-negative integers. Return null for empty, unknown units, repeated units, or anything malformed.`,
    tests: [
      ['1h30m15s', 5415], ['2d', 172800], ['45m', 2700], ['3h 10s', 10810], ['10s3h', 10810],
      ['', null], ['1h1h', null], ['5x', null], ['h', null], ['0s', 0], ['1d 2h 3m 4s', 93784], ['1.5h', null], ['  2m ', 120] ] },
  { id: 'CODE-3', points: 15, fn: 'topoSort',
    prompt: `topoSort(edges, nodes) — nodes is an array of unique strings; edges is an array of [from, to] meaning from must come before to. Return an array with every node in a valid topological order, choosing the LEXICOGRAPHICALLY SMALLEST available node at each step (plain string comparison). Return null if there is a cycle.`,
    tests: [
      [[[['a','b'],['b','c']], ['c','a','b']], ['a','b','c']],
      [[[], ['b','a']], ['a','b']],
      [[[['a','b'],['b','a']], ['a','b']], null],
      [[[['x','y']], ['z','y','x']], ['x','y','z']],
      [[[['b','a'],['c','a']], ['a','b','c']], ['b','c','a']],
      [[[['a','c'],['b','c'],['c','d']], ['d','c','b','a']], ['a','b','c','d']],
      [[[['a','a']], ['a']], null] ] },
  { id: 'CODE-4', points: 15, fn: 'rle',
    prompt: `rle(s) — run-length encode a string: each run becomes <count><char>, but omit the count when it is 1. Because digits can appear in the input, any digit character in the input is written wrapped in braces, e.g. "aa11b" → "2a2{1}b". The input never contains "{" or "}". Also export unrle(encoded) that reverses it exactly. Put BOTH functions in your code; the grader calls rle and unrle.`,
    tests: [
      ['aaab', '3ab'], ['', ''], ['a', 'a'], ['aa11b', '2a2{1}b'], ['1', '{1}'], ['111', '3{1}'], ['ab', 'ab'], ['zzzzzzzzzzzz', '12z'],
      ['ROUNDTRIP', ['hello  world!!', 'aa11', 'a1a1a1', '9999999999', 'x', '']] ] },
  { id: 'CODE-5', points: 15, fn: 'movingMedian',
    prompt: `movingMedian(arr, k) — arr is an array of numbers, k a positive integer. Return an array of the medians of every contiguous window of size k, in order. Median of an even-sized window is the mean of the two middle values. If k > arr.length return []. Must handle 20,000 elements with k = 500 within 2 seconds.`,
    tests: [
      [[[1,3,2,5,4], 3], [2,3,4]], [[[1,2,3,4], 2], [1.5,2.5,3.5]], [[[5], 1], [5]], [[[1,2], 3], []],
      [[[7,7,7,7], 2], [7,7,7]], [[[-3,0,3,-3,0,3], 4], [-1.5,0,1.5]],
      ['PERF', null] ] },
];

const BUGS = [
  { id: 'BUG-1', points: 20, fn: 'lowerBound',
    prompt: `Fix lowerBound(arr, x): arr is sorted ascending (may contain duplicates); return the index of the FIRST element >= x, or arr.length if none. Do not change the signature.`,
    buggy: `function lowerBound(arr, x) {\n  let lo = 0, hi = arr.length - 1;\n  while (lo < hi) {\n    const mid = Math.floor((lo + hi) / 2);\n    if (arr[mid] < x) lo = mid + 1; else hi = mid;\n  }\n  return lo;\n}`,
    tests: [ [[[1,2,2,2,3],2],1], [[[1,2,3],4],3], [[[],1],0], [[[1,3,5],0],0], [[[1,3,5],5],2], [[[2,2,2],2],0], [[[1,3,5],6],3] ] },
  { id: 'BUG-2', points: 20, fn: 'groupBy',
    prompt: `Fix groupBy(items, keyFn): return an object mapping each key (as produced by keyFn, as a string) to the array of items with that key, in input order. It must work for ANY key string, including "constructor", "__proto__", "hasOwnProperty".`,
    buggy: `function groupBy(items, keyFn) {\n  const out = {};\n  for (const it of items) {\n    const k = keyFn(it);\n    if (!out[k]) out[k] = [];\n    out[k].push(it);\n  }\n  return out;\n}`,
    tests: [ [[[1,2,3,4], x => x % 2 ? 'odd' : 'even'], [['even',[2,4]],['odd',[1,3]]]],
             [[['constructor','a'], x => x], [['a',['a']],['constructor',['constructor']]]],
             [[['__proto__'], x => x], [['__proto__',['__proto__']]]],
             [[[], x => x], []],
             [[['hasOwnProperty','hasOwnProperty'], x => x], [['hasOwnProperty',['hasOwnProperty','hasOwnProperty']]]] ] },
  { id: 'BUG-3', points: 20, fn: 'deepEqual',
    prompt: `Fix deepEqual(a, b): true if the two values are structurally equal. Rules: NaN equals NaN; an array is never equal to a plain object; Dates are equal if their times are equal; key order does not matter; +0 equals -0.`,
    buggy: `function deepEqual(a, b) {\n  if (a === b) return true;\n  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;\n  const ka = Object.keys(a), kb = Object.keys(b);\n  if (ka.length !== kb.length) return false;\n  return ka.every(k => deepEqual(a[k], b[k]));\n}`,
    tests: [ [[NaN, NaN], true], [[[1,2], {0:1,1:2}], false], [[{a:1,b:2},{b:2,a:1}], true], [[{a:1},{a:1,b:undefined}], false],
             [['DATE', 'DATE'], true], [['DATE1', 'DATE2'], false], [[0, -0], true], [[[1,[2,[3]]],[1,[2,[3]]]], true], [[null, {}], false] ] },
  { id: 'BUG-4', points: 20, fn: 'slugify',
    prompt: `Fix slugify(s): lowercase; strip accents (é→e, ñ→n, ü→u); replace any run of non-alphanumeric characters with a single "-"; no leading or trailing "-". Empty or all-junk input → "".`,
    buggy: `function slugify(s) {\n  return s.toLowerCase().replace(/[^a-z0-9]/g, '-');\n}`,
    tests: [ [['Hello World'], 'hello-world'], [['  Café -- Ünïcode!! '], 'cafe-unicode'], [['---'], ''], [[''], ''], [['a  b   c'], 'a-b-c'], [['Señor 2024'], 'senor-2024'], [['x'], 'x'] ] },
  { id: 'BUG-5', points: 20, fn: 'parseCSVLine',
    prompt: `Fix parseCSVLine(line): split one CSV line into fields. Fields may be quoted with double quotes; inside quotes a comma is literal and a doubled quote "" means one quote character. Unquoted fields are returned as-is (no trimming). An empty line → [""].`,
    buggy: `function parseCSVLine(line) {\n  return line.split(',').map(f => f.replace(/^"|"$/g, ''));\n}`,
    tests: [ [['a,b,c'], ['a','b','c']], [['"a,b",c'], ['a,b','c']], [['"say ""hi""",x'], ['say "hi"','x']], [[''], ['']], [['a,,b'], ['a','','b']],
             [['"",""'], ['','']], [[' a , b '], [' a ',' b ']], [['"multi,""quoted"",field",end'], ['multi,"quoted",field','end']] ] },
];

const MATH = [
  { id: 'MATH-1', points: 10, prompt: 'modpow(a, b, m) for integers up to 1e12 (b up to 1e12, m up to 1e9): return a^b mod m as a Number. Must run in < 50ms.',
    fn: 'modpow', gen: (r) => { const a = 2 + Math.floor(r()*1e12), b = 1 + Math.floor(r()*1e12), m = 2 + Math.floor(r()*1e9); return [a, b, m]; },
    ref: ([a,b,m]) => { let A = BigInt(a) % BigInt(m), B = BigInt(b), M = BigInt(m), res = 1n; while (B > 0n) { if (B & 1n) res = res * A % M; A = A * A % M; B >>= 1n; } return Number(res); } },
  { id: 'MATH-2', points: 10, prompt: 'countNotBoth(n): how many integers in [1, n] are divisible by 3 or 5 but NOT by 15. n up to 1e15; return a Number; must be O(1).',
    fn: 'countNotBoth', gen: (r) => [Math.floor(r()*1e15) + 1],
    ref: ([n]) => Math.floor(n/3) + Math.floor(n/5) - 2*Math.floor(n/15) },
  { id: 'MATH-3', points: 10, prompt: 'derangements(n): number of permutations of n items with no fixed points, modulo 1000000007. n up to 200000. Return a Number.',
    fn: 'derangements', gen: (r) => [1 + Math.floor(r()*200000)],
    ref: ([n]) => { const MOD = 1000000007n; let a = 1n, b = 0n; if (n === 0) return 1; if (n === 1) return 0; for (let i = 2; i <= n; i++) { const c = (BigInt(i - 1) * (a + b)) % MOD; a = b; b = c; } return Number(b); } },
];

// ---------- grading machinery ----------
const vm = require('vm');
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function load(code, names) {
  const ctx = { module: { exports: {} }, exports: {}, console: { log() {} }, Math, Number, String, Array, Object, JSON, BigInt, Date, Map, Set, RegExp, Error, parseInt, parseFloat, isNaN, isFinite };
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { timeout: 2000 });
  const out = {};
  for (const n of names) out[n] = ctx[n] || (ctx.module.exports && ctx.module.exports[n]) || (typeof ctx.module.exports === 'function' && n === names[0] ? ctx.module.exports : null);
  return out;
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function runWithTimeout(fn, args, ms) { const t = Date.now(); const r = fn(...args); if (Date.now() - t > ms) throw new Error('too slow (' + (Date.now() - t) + 'ms)'); return r; }

function gradeCode(task, code) {
  const names = task.id === 'CODE-4' ? ['rle', 'unrle'] : [task.fn];
  const fns = load(code, names); const f = fns[names[0]];
  if (typeof f !== 'function') return { pass: false, why: `function ${names[0]} not found` };
  let passed = 0, total = 0;
  for (const [input, expected] of task.tests) {
    total++;
    try {
      if (input === 'ROUNDTRIP') { const u = fns.unrle; if (typeof u !== 'function') throw new Error('unrle not found'); if (expected.every(s => u(f(s)) === s)) passed++; continue; }
      if (input === 'PERF') { const arr = Array.from({ length: 20000 }, (_, i) => (i * 7919) % 1000); runWithTimeout(f, [arr, 500], 2000); passed++; continue; }
      const args = task.id === 'CODE-3' || task.id === 'CODE-5' ? input : [input];
      const got = task.id === 'CODE-1' || task.id === 'CODE-2' || task.id === 'CODE-4' ? f(input) : f(...args);
      if (same(got, expected)) passed++;
    } catch (e) { /* counts as fail */ }
  }
  return { pass: passed === total, passed, total };
}
function gradeBug(task, code) {
  const fns = load(code, [task.fn]); const f = fns[task.fn];
  if (typeof f !== 'function') return { pass: false, why: `function ${task.fn} not found` };
  let passed = 0, total = 0;
  const d1 = new Date(1700000000000), d2 = new Date(1700000000001);
  for (const [input, expected] of task.tests) {
    total++;
    try {
      let args = input;
      if (task.id === 'BUG-3') args = input.map(x => x === 'DATE' ? new Date(1700000000000) : x === 'DATE1' ? d1 : x === 'DATE2' ? d2 : x);
      const got = f(...args);
      if (task.id === 'BUG-2') { const ents = Object.keys(got).sort().map(k => [k, got[k]]); if (JSON.stringify(ents) === JSON.stringify(expected)) passed++; }
      else if (same(got, expected)) passed++;
    } catch (e) {}
  }
  return { pass: passed === total, passed, total };
}
function gradeMath(task, code, run) {
  const fns = load(code, [task.fn]); const f = fns[task.fn];
  if (typeof f !== 'function') return { pass: false, why: `function ${task.fn} not found` };
  const r = mulberry(1337 * run + task.id.length); let passed = 0, total = 5;
  for (let i = 0; i < total; i++) { const args = task.gen(r); try { const got = runWithTimeout(f, args, 200); if (got === task.ref(args)) passed++; } catch (e) {} }
  return { pass: passed === total, passed, total };
}

function allTasks() { return [...CODE, ...BUGS, ...MATH]; }
function publicPrompts() {
  return allTasks().map(t => `### ${t.id} (${t.points} pts) — function \`${t.fn}\`\n${t.prompt}${t.buggy ? `\n\nBuggy code (fix it, keep the name):\n\`\`\`js\n${t.buggy}\n\`\`\`` : ''}`).join('\n\n');
}
function grade(id, code) {
  const t = allTasks().find(x => x.id === id); if (!t) return { error: 'unknown task ' + id };
  const runs = [];
  for (let run = 1; run <= 3; run++) {
    try { runs.push(t.buggy ? gradeBug(t, code) : t.gen ? gradeMath(t, code, run) : gradeCode(t, code)); }
    catch (e) { runs.push({ pass: false, why: 'crash: ' + String(e.message || e).slice(0, 80) }); }
  }
  const pass = runs.every(r => r.pass);
  return { id: t.id, points: pass ? t.points : 0, max: t.points, pass, runs: runs.map(r => r.pass ? 'PASS' : `FAIL(${r.passed ?? 0}/${r.total ?? '?'}${r.why ? ' ' + r.why : ''})`) };
}
module.exports = { allTasks, publicPrompts, grade, MAX: allTasks().reduce((s, t) => s + t.points, 0) };
if (require.main === module) { // child-process mode: node vault.js <TASK-ID> < code-on-stdin
  let code = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => code += d);
  process.stdin.on('end', () => { try { process.stdout.write(JSON.stringify(grade(process.argv[2], code))); } catch (e) { process.stdout.write(JSON.stringify({ error: String(e.message || e) })); } process.exit(0); });
}
