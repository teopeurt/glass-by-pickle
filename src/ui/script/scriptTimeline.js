/**
 * scriptTimeline.js — the parser behind the Script window.
 *
 * A copy of the tasksbaby rehearsal player's `viewer/timeline.mjs` (main
 * branch), so Glass reads a `play_by_play_*.md` script exactly as the viewer
 * does: scenes, beats, "In plain words", paste stages, reference sections,
 * scene slides and pacing. Pure (no imports, no DOM, no clock), so Node can
 * unit-test it and the renderer imports it as-is. Keep it byte-identical to the
 * viewer's file above the "plain scripts" section.
 *
 * Added below that section: `parsePlainScript` / `loadScript`, so a script
 * without `### Scene N` headings (a talk track, any plain text) still plays,
 * one beat per paragraph, timed by reading speed.
 */

// ------------------------------------------------------------------- clock
// The script's own shape is `H:MM` (variable-width hours, always two-digit
// minutes): `0:28`, `2:00`, `10:58`, `40:00`. `M:SS` is the same shape for the
// first hour, so one function round-trips every time token in the archive.

const CLOCK = /^(\d+):([0-5]\d)$/;

/** `"10:58"` -> `658`; anything that is not `H:MM` -> `null`. */
export function parseClock(value) {
  const m = String(value).match(CLOCK);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** `658` -> `"10:58"`. Clamps negatives/NaN to `0:00`; floors fractional seconds. */
export function formatClock(totalSeconds) {
  const n = Number(totalSeconds);
  const s = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ------------------------------------------------------------ text helpers
const lineAt = (lines, i) => lines[i];
const anyHeading = /^#{1,6}\s/;

/** The scene body: the lines after its heading, up to the next scene/section
 *  heading (`#` to `###`). A `####` sub-block — `#### In plain words` — belongs to
 *  the scene, so the Checkpoint / Hard-evidence lines after it are still its own. */
const sceneBoundary = /^#{1,3}\s/;
const FENCE = /^\s*(```|~~~)/;
function bodyOf(lines, i) {
  let j = i + 1;
  let inFence = false;
  // A `# comment` inside a fenced code block is code, not a heading.
  while (j < lines.length && (inFence || !sceneBoundary.test(lines[j]))) {
    if (FENCE.test(lines[j])) inFence = !inFence;
    j++;
  }
  return lines.slice(i + 1, j);
}

/** Lines of a body with fenced blocks removed (so tables/notes inside code are ignored). */
function unfenced(bodyLines) {
  const out = [];
  let inFence = false;
  for (const l of bodyLines) {
    if (FENCE.test(l)) { inFence = !inFence; continue; }
    if (!inFence) out.push(l);
  }
  return out;
}

/** Fenced code blocks of a scene body, in order. A block written as a numbered
 *  list (`1. $match …`, continuation lines indented) also yields `items`, so a
 *  beat that says "paste stage 2" can be shown just that item. Verbatim. */
function codeBlocksOf(bodyLines) {
  const blocks = [];
  let cur = null;
  for (const l of bodyLines) {
    const f = l.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (f) {
      if (cur) { blocks.push(cur); cur = null; } else cur = { lang: f[2] || '', lines: [] };
      continue;
    }
    if (cur) cur.lines.push(l);
  }
  return blocks.map((b) => {
    const items = [];
    for (const l of b.lines) {
      const m = l.match(/^(\d+)[.)]\s+(.*)$/);
      if (m) {
        // `2. $group   { … }`: the operator (`$group`) is a label, the body is
        // what gets pasted; continuation lines are dedented to the body column.
        const prefix = l.length - m[2].length;
        const op = m[2].match(/^(\$[A-Za-z]+)\s+(?=\S)/);
        items.push({ n: Number(m[1]), lines: [m[2]], op: op ? op[1] : '', col: prefix + (op ? op[0].length : 0), body: [op ? m[2].slice(op[0].length) : m[2]] });
      } else if (items.length) {
        const it = items[items.length - 1];
        it.lines.push(l);
        const lead = l.length - l.trimStart().length;
        it.body.push(l.slice(Math.min(lead, it.col)));
      }
    }
    const trimEnd = (x) => x.join('\n').replace(/\s+$/, '');
    return {
      lang: b.lang,
      text: trimEnd(b.lines),
      items: items.map((it) => ({ n: it.n, op: it.op, text: trimEnd(it.lines), body: trimEnd(it.body) })),
    };
  });
}

/** `#### In plain words` bullets -> Map(atSeconds -> text). Optional: a scene
 *  without the block yields an empty map. A bullet is `- **M:SS** - text`; lines
 *  that follow it, up to the next bullet / `**...**` callout / rule, continue it,
 *  and a blank line between continuation lines starts a new paragraph. */
function plainWordsOf(bodyLines) {
  const out = new Map();
  const at = bodyLines.findIndex((l) => /^####\s+In plain words\s*$/i.test(l.trim()));
  if (at < 0) return out;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const paras = cur.lines.join('\n').split(/\n\s*\n/).map((p) => p.split('\n').map((x) => x.trim()).filter(Boolean).join(' ')).filter(Boolean);
    if (paras.length && cur.sec != null && !out.has(cur.sec)) out.set(cur.sec, paras.join('\n\n'));
    cur = null;
  };
  for (let j = at + 1; j < bodyLines.length; j++) {
    const raw = bodyLines[j];
    const t = raw.trim();
    if (/^\*\*[^*]+\*\*/.test(t) && !/^[-*]\s/.test(t)) { flush(); break; } // **Hard evidence...** / **Checkpoint...**
    if (/^---+\s*$/.test(t) || anyHeading.test(t)) { flush(); break; }
    const b = /^[-*]\s+\*\*(\d+:\d\d)\*\*\s*[-\u2013\u2014:]?\s*(.*)$/.exec(t);
    if (b) { flush(); cur = { sec: parseClock(b[1]), lines: [b[2]] }; continue; }
    if (cur) cur.lines.push(raw);
  }
  flush();
  return out;
}

/** `| a | b | c |` -> `['a','b','c']` (leading/trailing pipe dropped). */
function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const isBeatRow = (cells) => cells.length >= 3 && CLOCK.test(cells[0]);

/**
 * splitHeading(headLine) -> { duration, rangeStart, rangeEnd, labelLine }
 *
 * `duration` is the raw duration token: `'2:00'` for a single duration, or the
 * `'<start>–<end>'` range for a range heading. `rangeStart` / `rangeEnd` are the
 * two clocks of a RANGE heading (or `null` for a single duration).
 *
 * `labelLine` is the heading with the `### ` marker and the `Scene N — ` prefix
 * stripped UNCONDITIONALLY — not only when a duration matched — and the duration
 * group removed, so a heading a duration pattern misses never keeps its prefix.
 * The duration is the LAST matching group, so an inner parenthesis in the label
 * (`Wrap + Dispatch (draft-only) (3:00)`) survives.
 */
function splitHeading(headLine) {
  const rest = String(headLine)
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^Scene\s+\d+\s*[—–-]\s*/, '')
    .trim();

  const range = [...rest.matchAll(/\((\d+:\d\d)\s*[–—-]\s*(\d+:\d\d)\)/g)];
  if (range.length) {
    const last = range[range.length - 1];
    const labelLine = (rest.slice(0, last.index) + rest.slice(last.index + last[0].length))
      .replace(/\s+/g, ' ').trim();
    return { duration: `${last[1]}–${last[2]}`, rangeStart: last[1], rangeEnd: last[2], labelLine };
  }

  const single = [...rest.matchAll(/\((\d+:\d\d)\)/g)];
  if (!single.length) return { duration: '', rangeStart: null, rangeEnd: null, labelLine: rest };
  const last = single[single.length - 1];
  const labelLine = (rest.slice(0, last.index) + rest.slice(last.index + last[0].length))
    .replace(/\s+/g, ' ').trim();
  return { duration: last[1], rangeStart: null, rangeEnd: null, labelLine };
}

/**
 * `Scene 2 — Docker: run …` -> `{ app: 'Docker', contribution: 'run …' }`.
 *
 * Three dialects, kept distinct so the archive parses exactly as before:
 *   - `App: <name> — <contribution>`: strip the `App: ` marker, then split the
 *     remainder on the em dash, so `App: Postman — test the endpoints` becomes
 *     `Postman` / `test the endpoints` (never app `'App'`).
 *   - `<App>: <contribution>`: split on the first `: `.
 *   - no colon (`Wrap + Dispatch (draft-only)`): the whole remainder is the app.
 */
function splitApp(labelLine) {
  const rest = ((labelLine.match(/^Scene\s+\d+\s*[—–-]\s*(.*)$/) || [, ''])[1] || labelLine).trim();
  if (/^App:\s+/.test(rest)) {
    const body = rest.replace(/^App:\s+/, '').trim();
    const dash = body.indexOf('—');
    if (dash >= 0) return { app: body.slice(0, dash).trim(), contribution: body.slice(dash + 1).trim() };
    return { app: body, contribution: '' };
  }
  const at = rest.indexOf(': ');
  if (at < 0) return { app: rest, contribution: '' };
  return { app: rest.slice(0, at).trim(), contribution: rest.slice(at + 2).trim() };
}

const A_NARRATION_DASH = /^[—–-]$/;

// ------------------------------------------------------------------ parse
/**
 * parseScript(text) -> { title, baseSlug, scenes, totalSeconds, warnings }
 *
 *   scene = { n, app, contribution, duration, seconds, startSeconds,
 *             checkpoint, evidence, beats }
 *   beat  = { at, atSeconds, action, narration, plain }
 *
 * `at` is the script's own clock string; `atSeconds` is absolute seconds from the
 * recording start. `narration` is `''` when the script wrote a bare `—`.
 */
export function parseScript(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  const warnings = [];

  const title = (src.match(/^\*\*Title:\*\*\s*(.+?)\s*$/m) || [, ''])[1] || '';
  const baseSlug = (src.match(/\*\*Base slug:\*\*\s*`([^`]+)`/) || [, ''])[1] || '';

  // --- scenes ---------------------------------------------------------------
  const scenes = [];
  const explicitStarts = []; // range start per scene, or null for a cumulative scene
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const hm = lineAt(lines, i).match(/^###\s+Scene\s+(\d+)\b/);
    if (!hm) continue;
    const n = Number(hm[1]);
    const head = splitHeading(lines[i]);
    const { app, contribution } = splitApp(head.labelLine);
    const explicitStart = head.rangeStart == null ? null : parseClock(head.rangeStart);
    let seconds;
    if (head.rangeStart != null) {
      const s = parseClock(head.rangeStart);
      const e = parseClock(head.rangeEnd);
      seconds = s != null && e != null && e >= s ? e - s : null;
    } else {
      seconds = parseClock(head.duration);
    }
    if (seconds == null) warnings.push(`scene ${n} has no (H:MM) duration — its beats cannot be placed`);

    const rawBody = bodyOf(lines, i);
    const plainBody = unfenced(rawBody);
    const body = plainBody.join('\n');
    const checkpoint = (body.match(/\*\*Checkpoint[^:]*:\*\*\s*([^\n]*)/) || [, ''])[1].trim();
    const evidence = (body.match(/\*\*Hard evidence produced:\*\*\s*([^\n]*)/) || [, ''])[1].trim();

    const beats = [];
    for (const line of plainBody) {
      const t = line.trim();
      if (!t.startsWith('|')) continue;
      const cells = cellsOf(t);
      if (!isBeatRow(cells)) continue;
      const at = cells[0];
      const atSeconds = parseClock(at);
      if (atSeconds == null) continue; // CLOCK already guaranteed it; belt and braces
      const action = cells[1] || '';
      const rawNarration = cells[2] || '';
      const narration = A_NARRATION_DASH.test(rawNarration) ? '' : rawNarration;
      beats.push({ at, atSeconds, action, narration, plain: '' });
    }
    const code = codeBlocksOf(rawBody);
    // Operator notes (`*Operator note (not spoken):* …`) and `Expected …:` lines
    // belong to the scene; they are read by the operator, never spoken. They are
    // read from the WHOLE scene (a generator script puts its "In plain words"
    // block before the code block and its Expected line, a hand-written one
    // after) and are taken OUT of the lines the plain-words reader sees, or the
    // last plain-words bullet would swallow them as continuation text.
    const notes = [];
    const expects = [];
    const sceneLines = [];
    for (const l of plainBody) {
      const t = l.trim();
      const n = t.match(/^\*Operator note[^*]*\*\s*(.+)$/i);
      if (n) { notes.push(n[1].trim()); continue; }
      if (/^Expected\b[^:]{0,60}:\s*\S/.test(t)) { expects.push(t); continue; }
      sceneLines.push(l);
    }
    const plainWords = plainWordsOf(sceneLines);
    for (const b of beats) b.plain = plainWords.get(b.atSeconds) || '';

    scenes.push({
      n,
      app,
      contribution,
      duration: head.duration,
      seconds: seconds == null ? 0 : seconds,
      startSeconds: 0, // filled below (cumulative, or the range's explicit start)
      checkpoint,
      evidence,
      beats,
      code,
      notes,
      expects,
    });
    explicitStarts.push(explicitStart);
    cursor = i;
  }
  void cursor;

  // Starts: a ranged scene uses its authored absolute start; a single-duration
  // scene opens where the previous scene ended. The two never fight.
  let start = 0;
  for (let k = 0; k < scenes.length; k++) {
    const sc = scenes[k];
    if (explicitStarts[k] != null) {
      sc.startSeconds = explicitStarts[k];
      start = sc.startSeconds + sc.seconds;
    } else {
      sc.startSeconds = start;
      start += sc.seconds;
    }
  }
  const summedSeconds = start;

  // --- total (the budget table is the authority) ---------------------------
  let budgetTotal = null;
  const budIdx = lines.findIndex((l) => /^##\s+Total runtime budget/.test(l));
  if (budIdx >= 0) {
    for (let j = budIdx + 1; j < lines.length; j++) {
      if (anyHeading.test(lines[j])) break;
      if (!/\bTotal\b/i.test(lines[j])) continue;
      const clocks = [...lines[j].matchAll(/(\d+:\d\d)/g)];
      if (clocks.length) { budgetTotal = parseClock(clocks[clocks.length - 1][1]); break; }
    }
  }
  if (budgetTotal == null) {
    budgetTotal = summedSeconds;
    // A ranged last scene carries an authored end, so its total is not a guess;
    // only a single-duration script falls back to a summed estimate worth noting.
    const lastRanged = explicitStarts.length > 0 && explicitStarts[explicitStarts.length - 1] != null;
    if (scenes.length && !lastRanged) {
      warnings.push('no "## Total runtime budget" total found — using the summed scene durations');
    }
  } else if (summedSeconds !== budgetTotal) {
    warnings.push(`summed scene durations (${formatClock(summedSeconds)}) differ from the budget total (${formatClock(budgetTotal)})`);
  }

  // --- degradation warnings ------------------------------------------------
  if (!scenes.length) warnings.push('no "### Scene N" heading found — nothing to lay out');
  const beatCount = scenes.reduce((a, s) => a + s.beats.length, 0);
  if (scenes.length && beatCount === 0) {
    warnings.push('no beat rows found — degrading to scene-level timing only');
  }

  return { title, baseSlug, scenes, totalSeconds: budgetTotal, warnings, ...referenceOf(lines) };
}

// -------------------------------------------------------------- reference
/** The body lines of a `## <name>` section (up to the next `#`–`###` heading). */
function sectionLines(lines, nameRe) {
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${nameRe.source}`, 'i').test(l.trim()));
  if (at < 0) return [];
  let j = at + 1;
  while (j < lines.length && !/^#{1,3}\s/.test(lines[j])) j++;
  return unfenced(lines.slice(at + 1, j));
}

/** Script-level reference material the operator glances at, all verbatim:
 *    definitions  `- **Term:** text` bullets of "## Definitions…"
 *    facts        rows of the "## Facts from the pack" table { fact, value, file }
 *    prep         list items of "## Before you record" */
function referenceOf(lines) {
  const definitions = [];
  for (const l of sectionLines(lines, /Definitions/)) {
    const m = l.trim().match(/^[-*]\s+\*\*(.+?):?\*\*:?\s*(.*)$/);
    if (m) definitions.push({ term: m[1].replace(/:$/, '').trim(), text: m[2].trim() });
  }
  const facts = [];
  for (const l of sectionLines(lines, /Facts from the pack/)) {
    const t = l.trim();
    if (!t.startsWith('|')) continue;
    const c = cellsOf(t);
    if (c.length < 2 || /^-+$/.test(c[0].replace(/:/g, '')) || /^fact$/i.test(c[0])) continue;
    facts.push({ fact: c[0], value: c[1], file: (c[2] || '').replace(/`/g, '') });
  }
  const prep = [];
  for (const l of sectionLines(lines, /Before you record/)) {
    const m = l.trim().match(/^(?:\d+[.)]|[-*])\s+(.+)$/);
    if (m) prep.push(m[1].trim());
  }
  return { definitions, facts, prep };
}

/**
 * beatCode(scene, beat) -> [{ label, text }] — the paste text for a beat.
 * "paste stage 2" / "with stage 3, then … stage 4" pick those numbered items of
 * the scene's code block — the stage BODY (what a stage editor takes), with the
 * operator (`$group`) moved into the label; a beat that says paste/type/enter without a number
 * gets the whole block. A beat that names no code gets nothing.
 */
export function beatCode(scene, beat) {
  const blocks = (scene && scene.code) || [];
  if (!blocks.length || !beat) return [];
  const action = String(beat.action || '');
  const wanted = [...action.matchAll(/\bstages?\s+(\d+)(?:\s*(?:,|and|&|to|-|–)\s*(\d+))?/gi)]
    .flatMap((m) => (m[2] ? [Number(m[1]), Number(m[2])] : [Number(m[1])]));
  const items = blocks.flatMap((b) => b.items);
  if (wanted.length && items.length) {
    // One operator on item 1 and bare lines after it = the lines of ONE stage body typed a line at a time: call them lines, not stages.
    const oneStage = items.length > 1 && items.filter((it) => it.op).length === 1 && items[0].op;
    const noun = oneStage ? 'Line' : 'Stage';
    return [...new Set(wanted)].map((n) => items.find((it) => it.n === n))
      .filter(Boolean).map((it) => ({ label: it.op ? `${noun} ${it.n} · ${it.op}` : `${noun} ${it.n}`, text: it.body }));
  }
  if (/\b(paste|type the (?:query|expression|pipeline|code)|enter the (?:query|expression|pipeline))\b/i.test(action)) {
    return blocks.map((b, k) => ({ label: blocks.length > 1 ? `Block ${k + 1}` : 'Paste', text: b.text }));
  }
  return [];
}

/**
 * formatCode(text, { width = 60 }) -> text for DISPLAY only (Copy keeps the
 * script's exact text). A one-line object/array literal — a Mongo stage body,
 * a JSON value — is broken one key per line with 2-space indent; any nested
 * group that fits in `width` characters stays on one line. String contents are
 * never touched. Multi-line text, non-literals and unbalanced input come back
 * unchanged, so nothing the script wrote is ever lost.
 */
export function formatCode(text, { width = 60 } = {}) {
  const src = String(text == null ? '' : text);
  const t = src.trim();
  if (src.includes('\n') || t.length <= width || !/^[[{]/.test(t)) return src;
  // Tokenise: strings, brackets, commas, colons; everything else is atom text.
  const tokens = [];
  let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < t.length && t[j] !== ch) j += t[j] === '\\' ? 2 : 1;
      if (j >= t.length) return src; // unterminated string
      tokens.push(t.slice(i, j + 1));
      i = j + 1;
    } else if ('{}[],:'.includes(ch)) {
      tokens.push(ch);
      i++;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      let j = i;
      while (j < t.length && !'{}[],:"\''.includes(t[j]) && !/\s/.test(t[j])) j++;
      tokens.push(t.slice(i, j));
      i = j;
    }
  }
  // Parse into a tree: a group is { open, close, items: [[token…]…] }.
  let k = 0;
  function group() {
    const open = tokens[k++];
    const close = open === '{' ? '}' : ']';
    const items = [];
    let cur = [];
    while (k < tokens.length && tokens[k] !== close) {
      const tok = tokens[k];
      if (tok === '{' || tok === '[') cur.push(group());
      else if (tok === '}' || tok === ']') throw new Error('mismatched');
      else if (tok === ',') { items.push(cur); cur = []; k++; }
      else { cur.push(tok); k++; }
    }
    if (tokens[k] !== close) throw new Error('unbalanced');
    k++;
    if (cur.length) items.push(cur);
    return { open, close, items };
  }
  const inline = (node) => {
    if (typeof node === 'string') return node;
    if (!node.items.length) return `${node.open}${node.close}`;
    const body = node.items.map(itemInline).join(', ');
    return node.open === '[' ? `[${body}]` : `{ ${body} }`;
  };
  // Join an item's parts: one space between parts, none before a colon.
  const joinItem = (parts) => parts.reduce((acc, p, n) => (n === 0 ? p : p === ':' ? `${acc}:` : `${acc} ${p}`), '');
  function itemInline(item) { return joinItem(item.map(inline)); }
  function block(node, depth) {
    const flat = inline(node);
    if (flat.length + depth * 2 <= width || !node.items.length) return flat;
    const pad = '  '.repeat(depth + 1);
    const lines = node.items.map((item) => pad + joinItem(item.map((p) => (typeof p === 'string' ? p : block(p, depth + 1)))));
    return `${node.open}\n${lines.join(',\n')}\n${'  '.repeat(depth)}${node.close}`;
  }
  try {
    const root = group();
    if (k !== tokens.length) return src; // trailing text after the literal
    return block(root, 0);
  } catch (err) {
    return src;
  }
}

/**
 * highlightCode(text) -> [{ t, v }] — display tokens for a Paste card. `t` is one
 * of: str, num, op ($operator), key (name before a colon), kw (true/false/null/
 * undefined and a few SQL/Python words), com (# // -- comment), punc, text.
 * Concatenating every `v` gives back `text` exactly, so highlighting never
 * changes what is shown or copied.
 */
const KW = new Set(['true', 'false', 'null', 'undefined', 'select', 'from', 'where', 'group', 'by', 'order', 'having', 'join', 'on', 'as', 'and', 'or', 'not', 'in', 'limit', 'def', 'return', 'import', 'for', 'if', 'else', 'print', 'with', 'None', 'True', 'False']);
export function highlightCode(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  const push = (t, v) => { if (!v) return; const last = out[out.length - 1]; if (last && last.t === t && t !== 'punc') last.v += v; else out.push({ t, v }); };
  const re = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|((?:#|\/\/|--)[^\n]*)|(\$[A-Za-z_][\w.]*)|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][\w.]*)|([{}[\](),:;=<>+\-*/|&!]+)|(\s+|.)/gi;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[1] !== undefined) {
      // A quoted word directly before a colon is a key too (JSON).
      push(/^\s*:/.test(src.slice(re.lastIndex)) ? 'key' : 'str', m[1]);
    } else if (m[2] !== undefined) push('com', m[2]);
    else if (m[3] !== undefined) push('op', m[3]);
    else if (m[4] !== undefined) push('num', m[4]);
    else if (m[5] !== undefined) push(/^\s*:/.test(src.slice(re.lastIndex)) ? 'key' : (KW.has(m[5]) || KW.has(m[5].toLowerCase())) ? 'kw' : 'text', m[5]);
    else if (m[6] !== undefined) push('punc', m[6]);
    else push('text', m[7]);
  }
  return out;
}

// --------------------------------------------------------------- flat view
/**
 * flatTimeline(parsed) -> every beat in order, on one absolute clock:
 *   { sceneN, beatIndex, atSeconds, endSeconds, action, narration }
 *
 * A beat runs until the next beat in its own scene; a scene's final beat runs to
 * that scene's end (`startSeconds + seconds`). Every generated scene's first beat
 * sits on the scene start, so no beat is preceded by dead time, and its last beat
 * starts strictly before the scene end, so a terminal beat always has a non-zero
 * span. No time is invented.
 */
export function flatTimeline(parsed) {
  const scenes = (parsed && parsed.scenes) || [];
  const out = [];
  for (const sc of scenes) {
    const sceneEnd = sc.startSeconds + sc.seconds;
    for (let i = 0; i < sc.beats.length; i++) {
      const b = sc.beats[i];
      const next = sc.beats[i + 1];
      out.push({
        sceneN: sc.n,
        beatIndex: i,
        atSeconds: b.atSeconds,
        endSeconds: next ? next.atSeconds : sceneEnd,
        action: b.action,
        narration: b.narration,
        plain: b.plain || '',
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ scene slides
/** Strip ONE pair of surrounding straight (" ") or curly (“ ”) quotes. */
function unquote(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === '\u201C' && t[t.length - 1] === '\u201D'))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** First sentence of an action: cut at the first '. ' keeping the period. */
function firstSentence(s) {
  const t = String(s).trim();
  const at = t.indexOf('. ');
  return at < 0 ? t : t.slice(0, at + 1).trim();
}

/** The verbatim narration a slide may use: the whole line, or its first
 *  sentence when the line is longer than MAX_WORDS. Never generated text —
 *  the fragment is cut from the line itself, and a fragment that is still
 *  too long is rejected by `rejected()` so the beat falls back to its action. */
function slideSay(narration) {
  const say = narration ? unquote(narration) : '';
  if (!say || wordCount(say) <= MAX_WORDS) return say;
  const first = firstSentence(say);
  return first && wordCount(first) <= MAX_WORDS ? first : say;
}

/** A pack file name as the scripts write it: `<stem>_r<N>.<ext>`. */
const FILE_NAME = /`?([A-Za-z0-9][\w.-]*_r\d+\.[A-Za-z0-9]+)`?/g;

/** Template lines every generated scene repeats; never a talking point. */
export const STOCK = [
  /under the naming convention/i,
  /is on disk and matches/i,
  /^show what this stage picks up/i,
];

const MAX_WORDS = 20;
const MAX_USES = 4;
const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/** Comparison key: lowercase, the scene's app name (whole words only) folded to
 *  `<app>`, punctuation dropped. */
function normKey(text, app) {
  let t = String(text).toLowerCase();
  const a = String(app || '').toLowerCase().trim();
  if (a) {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, 'g'), '$1<app>');
  }
  return t.replace(/[^a-z0-9<> ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function filesIn(text) {
  return [...String(text || '').matchAll(FILE_NAME)].map((m) => m[1]);
}

/**
 * shortFile(name, baseSlug) -> the display name of a pack file:
 * `it_event_triage_slo_baseline_r1.csv`, `it_event_triage` -> `slo_baseline.csv`.
 * Without a matching slug only the `_rN` revision is dropped; a name that is not
 * `<stem>_rN.<ext>` comes back unchanged.
 */
export function shortFile(name, baseSlug) {
  const s = String(name == null ? '' : name);
  const m = s.match(/^(.*)_r\d+(\.[A-Za-z0-9]+)$/);
  if (!m) return s;
  let stem = m[1];
  const slug = String(baseSlug || '');
  if (slug && stem.startsWith(`${slug}_`) && stem.length > slug.length + 1) stem = stem.slice(slug.length + 1);
  return stem + m[2];
}

/**
 * sceneSlides(parsed, { max = 3 }) -> one slide per scene:
 *   { n, app, objective, startSeconds, seconds, endSeconds, points, uses, makes }
 *
 * `points` are at most `max` VERBATIM lines (never generated): narrated beats
 * (quotes stripped) first, topped up from un-narrated beats' first action
 * sentence. A narration line longer than 20 words is cut to its own first
 * sentence when that fits, so a long pedantic line still reaches the slide; a
 * beat is topped up from its action only when its narration is missing or its
 * first sentence is still too long. A candidate is dropped when it recurs in
 * two or more scenes of the script, equals the objective, runs over 20 words, carries a `→` / "fall back"
 * instruction, names the scene's evidence file, or matches STOCK. Narration
 * scores +2 with a digit or file name and -1 on the scene's first beat; an
 * action scores -2 (+1 with a digit) and never starts with "Open". The top
 * `max` by score (ties: earlier) are returned in time order.
 *
 * `makes` = the first pack file named in the scene's hard evidence, or ''.
 * `uses` = distinct pack files named in the scene's beats, minus `makes`, in
 * first-mention order, at most 4.
 */
export function sceneSlides(parsed, { max = 3 } = {}) {
  const scenes = (parsed && parsed.scenes) || [];

  // How many scenes each candidate line appears in (template detection).
  const seenIn = new Map();
  for (const sc of scenes) {
    const mine = new Set();
    for (const b of sc.beats || []) {
      for (const t of [slideSay(b.narration), firstSentence(b.action || '')]) {
        if (!t) continue;
        const k = normKey(t, sc.app);
        if (mine.has(k)) continue;
        mine.add(k);
        seenIn.set(k, (seenIn.get(k) || 0) + 1);
      }
    }
  }

  return scenes.map((sc) => {
    const beats = sc.beats || [];
    const objective = sc.contribution || '';
    const evidenceFiles = filesIn(sc.evidence);
    const makes = evidenceFiles[0] || '';
    const objKey = normKey(objective, sc.app);

    const rejected = (t) => {
      if (!t) return true;
      const k = normKey(t, sc.app);
      if ((seenIn.get(k) || 0) > 1) return true;
      if (objKey && k === objKey) return true;
      if (wordCount(t) > MAX_WORDS) return true;
      if (/→|fall back/i.test(t)) return true;
      if (evidenceFiles.some((f) => t.includes(f))) return true;
      return STOCK.some((re) => re.test(t));
    };

    const cands = [];
    beats.forEach((b, i) => {
      const say = slideSay(b.narration);
      if (say && !rejected(say)) {
        const score = (/\d/.test(say) || filesIn(say).length ? 2 : 0) - (i === 0 ? 1 : 0);
        cands.push({ i, at: b.atSeconds, text: say, score });
      }
    });
    if (cands.length < max) {
      beats.forEach((b, i) => {
        if (cands.some((c) => c.i === i)) return;
        const act = firstSentence(b.action || '');
        if (!act || /^open\b/i.test(act) || rejected(act)) return;
        cands.push({ i, at: b.atSeconds, text: act, score: -2 + (/\d/.test(act) ? 1 : 0) });
      });
    }
    const picked = cands
      .slice()
      .sort((a, b) => b.score - a.score || a.at - b.at || a.i - b.i)
      .slice(0, Math.max(0, max))
      .sort((a, b) => a.at - b.at || a.i - b.i);

    const uses = [];
    for (const b of beats) {
      for (const f of filesIn(`${b.action || ''} ${b.narration || ''}`)) {
        if (f !== makes && !uses.includes(f)) uses.push(f);
      }
    }

    return {
      n: sc.n,
      app: sc.app,
      objective,
      startSeconds: sc.startSeconds,
      seconds: sc.seconds,
      endSeconds: sc.startSeconds + sc.seconds,
      points: picked.map((c) => c.text),
      uses: uses.slice(0, MAX_USES),
      makes,
    };
  });
}

// --------------------------------------------------------------- scene pace
const fin = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * scenePace({ budget, plannedStart, enteredAt, watch }) ->
 *   { spent, left, ratio, level, driftSeconds }
 *
 * spent = max(0, watch - enteredAt); left = budget - spent (negative = over).
 * ratio = spent / budget, finite-safe: when budget <= 0 it is 0 if nothing is
 * spent, else 1. level: 'idle' (watch not > 0), 'over' (spent > budget),
 * 'warn' (ratio >= 0.85), else 'ok'. driftSeconds = (enteredAt - plannedStart)
 * + max(0, spent - budget); positive = behind plan, negative = ahead.
 * Non-finite inputs count as 0.
 */
export function scenePace({ budget, plannedStart, enteredAt, watch } = {}) {
  const b = fin(budget), p = fin(plannedStart), e = fin(enteredAt), w = fin(watch);
  const spent = Math.max(0, w - e);
  const ratio = b > 0 ? spent / b : (spent > 0 ? 1 : 0);
  let level;
  if (!(w > 0)) level = 'idle';
  else if (spent > b) level = 'over';
  else if (ratio >= 0.85) level = 'warn';
  else level = 'ok';
  return { spent, left: b - spent, ratio, level, driftSeconds: (e - p) + Math.max(0, spent - b) };
}

/**
 * sceneAutoAdvanceDue({ budget, enteredAt, watch }) -> boolean
 *
 * True once the stopwatch has spent a scene's whole budget since the scene was
 * entered (spent >= budget). A budget <= 0 never advances (nothing to wait for).
 * Pure: it only reads the stopwatch, so pausing the clock pauses the dwell.
 * Non-finite inputs count as 0.
 */
export function sceneAutoAdvanceDue({ budget, enteredAt, watch } = {}) {
  const b = fin(budget);
  return b > 0 && Math.max(0, fin(watch) - fin(enteredAt)) >= b;
}

// -------------------------------------------------------------- beat steps
// "In plain words" text -> a click-through card. Two dialects exist in the
// archive: numbered paragraphs (`1. …`, `You should see: …`) and one prose
// paragraph mixing explanation with instructions. Every output string is a
// verbatim piece of the input; nothing is rewritten.

const STEP_VERB = '(?:click|double-click|right-click|press|type|choose|select|open|drag|drop|enter|paste|copy|run|save|export|import|add|set|pick|scroll|switch|close|rename|tick|uncheck|go|navigate|hover|toggle|fill|attach|write|address|apply|insert|delete|remove|create|start|stop|restart|connect|load|wait|read|confirm|show|point|highlight|zoom|resize|sort|filter|group|name|label|upload|download|leave|keep|use|make|put|find|locate|expand|collapse|check|give|search|look|return|minimize|maximize|drag)';
const STEP_START = new RegExp(`^(?:then,? |next,? |now,? |first,? |finally,? |also |and )?(?:${STEP_VERB}\\b|(?:in|on|at|from) (?:the |a |your )?[^,.]{1,60}, (?:then )?${STEP_VERB}\\b)`, 'i');
const CHECK_START = /^(?:you know (?:it|this) (?:has )?work(?:ed|s)|when (?:it|this) (?:has )?work(?:ed|s)|when it is done|you should see|the screen should show|it worked when|if it worked|success looks like)/i;
const FIX_START = /^if\b/i;
// A hidden instruction: "we/you" + an on-screen action verb inside an explanatory
// sentence ("so we click the plus sign…"). Only hands-on UI verbs count — "we
// add it because…" or "we export the result set rather than…" is reasoning — and
// "until / never / if / do not" phrasing is not an instruction.
const UI_VERB = '(?:click|double-click|right-click|press|type|choose|select|drag|paste|copy|tick|untick|hover|scroll|rename|attach)';
const HIDDEN_STEP = new RegExp(`(?<!\\buntil )(?<!\\bnever )(?<!\\bif )(?<!\\bunless )(?<!\\bafter )(?<!\\bonce )(?<!\\bwhen )\\b(?:we|you) (?:then |now |simply |just |also |first )?${UI_VERB}\\b(?! that\\b)`, 'i');

/** Sentences of a prose block. A sentence ends at . ! ? followed by space or the
 *  end, so file names (`a_r1.csv`), decimals (`0.0006`) and `$match` survive. */
function sentencesOf(text) {
  const out = [];
  for (const m of String(text).matchAll(/[^.!?]+(?:[.!?]+(?=\S)[^.!?]*)*(?:[.!?]+(?=\s|$)|$)/g)) {
    const t = m[0].trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * beatSteps(plain) -> { kind, why, steps, check, fix, hidden }
 *
 *   kind   'none' (no text) | 'steps' | 'mixed' | 'explanation'
 *   why    explanatory sentences / paragraphs (string[])
 *   steps  the instructions, in order (string[])
 *   check  the "you should see" sentences (string[], usually one)
 *   fix    "if it goes wrong" sentences (string[])
 *   hidden the `why` sentences that still carry an instruction ("we click…") —
 *          the flag that the plain words mix explanation and clicks.
 */
export function beatSteps(plain) {
  const text = String(plain == null ? '' : plain).trim();
  const empty = { kind: 'none', why: [], steps: [], check: [], fix: [], hidden: [] };
  if (!text) return empty;
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  if (paras.some((p) => /^\d+[.)]\s/.test(p))) {
    const why = [], steps = [], fix = [];
    const check = [];
    for (const p of paras) {
      if (/^\d+[.)]\s/.test(p)) steps.push(p.replace(/^\d+[.)]\s+/, ''));
      else if (/^you should see:?/i.test(p)) check.push(p.replace(/^you should see:?\s*/i, ''));
      else if (FIX_START.test(p)) fix.push(p);
      else why.push(p);
    }
    const hidden = why.filter((w) => HIDDEN_STEP.test(w));
    return { kind: 'steps', why, steps, check, fix, hidden };
  }

  const why = [], steps = [], checks = [], fix = [];
  for (const sn of sentencesOf(paras.join(' '))) {
    if (CHECK_START.test(sn)) checks.push(sn);
    else if (FIX_START.test(sn)) fix.push(sn);
    else if (STEP_START.test(sn)) steps.push(sn);
    else why.push(sn);
  }
  const hidden = why.filter((w) => HIDDEN_STEP.test(w));
  const kind = steps.length === 0 ? 'explanation' : (why.length > steps.length ? 'mixed' : 'steps');
  return { kind, why, steps, check: checks, fix, hidden };
}

/**
 * stepFlags(parsed) -> { totals: { steps, mixed, explanation, none, flagged },
 *                        beats: [{ sceneN, app, at, action, kind, hidden }] }
 * One row per beat that HAS plain words; `hidden` is the count of explanatory
 * sentences still carrying an instruction. `flagged` counts beats with hidden > 0.
 */
export function stepFlags(parsed) {
  const totals = { steps: 0, mixed: 0, explanation: 0, none: 0, flagged: 0 };
  const beats = [];
  for (const sc of (parsed && parsed.scenes) || []) {
    for (const b of sc.beats || []) {
      if (!b.plain) continue;
      const r = beatSteps(b.plain);
      totals[r.kind]++;
      if (r.hidden.length) totals.flagged++;
      beats.push({ sceneN: sc.n, app: sc.app, at: b.at, action: b.action, kind: r.kind, hidden: r.hidden.length });
    }
  }
  return { totals, beats };
}

/**
 * beatExpects(scene, beat) -> string[] — the scene's `Expected …:` lines that
 * belong to this beat: a line is kept when a content word of its label (the text
 * before the colon, e.g. "export header") appears in the beat's action. Verbatim.
 */
export function beatExpects(scene, beat) {
  const lines = (scene && scene.expects) || [];
  if (!lines.length || !beat) return [];
  const action = String(beat.action || '').toLowerCase();
  return lines.filter((l) => {
    const label = l.slice(0, l.indexOf(':')).replace(/^Expected\s*/i, '').toLowerCase();
    return label.split(/[^a-z0-9_]+/).some((w) => w.length > 3 && action.includes(w));
  });
}

// ------------------------------------------------------------ plain scripts
export const DEFAULT_WPM = 150;
const MIN_BEAT_SECONDS = 3;


/** Drop the markdown a teleprompter should not show: emphasis, code ticks, list bullets. */
function plainLine(line) {
    return line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

/**
 * parsePlainScript(text, { wpm }) -> the same shape as `parseScript`, plus `mode: 'plain'`.
 *
 * Every paragraph (blank-line separated) is one beat; a markdown heading starts a
 * new scene named after it. A beat opens when the previous one has had time to be
 * read aloud at `wpm` words per minute (never less than 3 seconds), so unlike the
 * play-by-play dialect these times are ESTIMATES — `warnings` says so.
 */
export function parsePlainScript(text, { wpm = DEFAULT_WPM } = {}) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const rate = Number(wpm) > 0 ? Number(wpm) : DEFAULT_WPM;
    const scenes = [];
    let title = '';
    let clock = 0;
    let scene = null;
    let paragraph = [];

    const openScene = name => {
        scene = {
            n: scenes.length + 1,
            app: name,
            contribution: '',
            duration: '',
            seconds: 0,
            startSeconds: clock,
            checkpoint: '',
            evidence: '',
            beats: [],
        };
        scenes.push(scene);
    };
    const flush = () => {
        const body = paragraph.map(plainLine).filter(Boolean).join(' ');
        paragraph = [];
        if (!body) return;
        if (!scene) openScene('Script');
        const seconds = Math.max(MIN_BEAT_SECONDS, Math.round((wordCount(body) / rate) * 60));
        scene.beats.push({ at: formatClock(clock), atSeconds: clock, action: body, narration: '' });
        clock += seconds;
        scene.seconds = clock - scene.startSeconds;
    };

    for (const line of src.split('\n')) {
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) {
            flush();
            const name = plainLine(heading[1]);
            if (!title) title = name;
            openScene(name || 'Script');
        } else if (!line.trim()) {
            flush();
        } else {
            paragraph.push(line);
        }
    }
    flush();

    // A heading with nothing under it is not a scene worth showing.
    const kept = scenes.filter(s => s.beats.length).map((s, i) => ({ ...s, n: i + 1 }));
    const warnings = kept.length
        ? [`no "### Scene N" headings — plain script, beat times estimated at ${rate} words per minute`]
        : ['the script is empty — nothing to lay out'];
    return { title, baseSlug: '', scenes: kept, totalSeconds: clock, warnings, mode: 'plain' };
}

/**
 * loadScript(text, opts) -> a parsed script with `mode`:
 *   'timed' — a play-by-play script (`### Scene N — … (H:MM)` + beat tables), read by its own clock;
 *   'plain' — anything else, via `parsePlainScript`.
 */
export function loadScript(text, opts = {}) {
    const parsed = parseScript(text);
    if (parsed.scenes.length) return { ...parsed, mode: 'timed' };
    return parsePlainScript(text, opts);
}
