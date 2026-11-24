// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. Node 22, standard library
// only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// SPEC.md is the whole contract. In a trial the grader runs this file with
// MAKEFUN_ENV_URL set, and the last lines below hand over to runner.ts:
// keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: exit 2, `error: parse <line>`. */
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit that failed: exit 1, `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own break, its lines, whether it ends with a break. */
interface FileText {
  br: '\n' | '\r\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { br, lines: parts, final };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: pending changes over what is on disk. */
class Tree {
  private disk = new Map<string, string | null>();
  private pending = new Map<string, string | null>();

  private readDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  /** What the file holds before the patch: null when it does not exist. */
  original(p: string): string | null {
    return this.readDisk(p);
  }

  get(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.readDisk(p);
  }

  set(p: string, v: string | null): void {
    this.pending.set(p, v);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.pending);
  }

  restore(s: Map<string, string | null>): void {
    this.pending = new Map(s);
  }

  pendingPaths(): string[] {
    return [...this.pending.keys()];
  }

  knownPaths(): string[] {
    return [...new Set([...this.disk.keys(), ...this.pending.keys()])];
  }
}

/** Section 5: the three matching tiers. */
const NORMS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

/** The first tier at which `old` occurs in `file` at or after `from`, with every occurrence there. */
function locateFrom(file: string[], old: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const norm = NORMS[t]!;
    const want = old.map(norm);
    const pos: number[] = [];
    for (let i = from; i + want.length <= file.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (norm(file[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function locateSingle(file: string[], line: string, strict: boolean, from: number): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const norm = NORMS[t]!;
    const want = norm(line);
    for (let i = from; i < file.length; i++) {
      if (norm(file[i]!) === want) return i;
    }
  }
  return null;
}

interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
  noeol: boolean;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/**
 * Section 5: build the lines that replace a match. A context line is written
 * as the file's own matched line; at tier 2 every other line is re-indented:
 * the leading spaces and tabs of the file's first matched line (F) replace
 * those of the old lines' first line (P) where the line starts with P.
 */
function buildReplacement(fileLines: string[], at: number, oItems: BodyItem[], nItems: BodyItem[], tier: number): string[] {
  const oCtx: number[] = [];
  oItems.forEach((it, idx) => {
    if (it.kind === ' ') oCtx.push(idx);
  });
  const f = tier === 2 ? leadingWs(fileLines[at] ?? '') : '';
  const p = tier === 2 ? leadingWs(oItems.length > 0 ? oItems[0]!.text : '') : '';
  const out: string[] = [];
  let seen = 0;
  for (const it of nItems) {
    if (it.kind === ' ') {
      out.push(fileLines[at + oCtx[seen]!]!);
      seen++;
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** The body lines of a hunk or chunk, with `\` lines folded onto the line before them. */
function parseBody(raw: string[]): BodyItem[] {
  const items: BodyItem[] = [];
  for (const rl of raw) {
    if (rl.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.noeol = true;
    } else if (rl === '') {
      items.push({ kind: ' ', text: '', noeol: false });
    } else {
      items.push({ kind: rl[0] as ' ' | '-' | '+', text: rl.slice(1), noeol: false });
    }
  }
  return items;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastNoEol(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === ' ' || it.kind === '+') return it.noeol;
  }
  return false;
}

/** One edit: applies itself to the tree, or throws Fail. Returns a move when it moved a file. */
type EditFn = (tree: Tree, strict: boolean) => { move?: { from: string; to: string } } | void;

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function applyUnifiedHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    const oItems = h.items.filter((it) => it.kind === ' ' || it.kind === '-');
    const nItems = h.items.filter((it) => it.kind === ' ' || it.kind === '+');
    const oLen = oItems.length;
    const nLen = nItems.length;
    if (oLen === 0) {
      const at = Math.min(Math.max(h.a + d, 0), cur.lines.length);
      const repl = nItems.map((it) => it.text);
      const lines = [...cur.lines.slice(0, at), ...repl, ...cur.lines.slice(at)];
      const fin = at === cur.lines.length ? !lastNoEol(h.items) : cur.final;
      cur = { br: cur.br, lines, final: fin };
      d += nLen;
      continue;
    }
    const old = oItems.map((it) => it.text);
    const loc = locateFrom(cur.lines, old, strict, 0);
    if (loc === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = loc.pos[0]!;
    let best = Math.abs(at - target);
    for (const p of loc.pos) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        at = p;
        best = dist;
      }
    }
    const repl = buildReplacement(cur.lines, at, oItems, nItems, loc.tier);
    const fin = at + oLen === cur.lines.length ? !lastNoEol(h.items) : cur.final;
    const lines = [...cur.lines.slice(0, at), ...repl, ...cur.lines.slice(at + oLen)];
    cur = { br: cur.br, lines, final: fin };
    d += nLen - oLen;
  }
  return cur;
}

function unifiedSectionEdit(sec: Section): EditFn {
  return (tree, strict) => {
    if (sec.oldPath !== null && !safePath(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safePath(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    const isCreate = sec.oldPath === null || sec.isCreate;
    const isDelete = sec.newPath === null || sec.isDelete;
    if (isCreate) {
      const p = sec.newPath ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let hasPlus = false;
      let lastPlusNoEol = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') {
            lines.push(it.text);
            hasPlus = true;
            lastPlusNoEol = it.noeol;
          }
        }
      }
      tree.set(p, lines.length === 0 ? '' : lines.join('\n') + (hasPlus && lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = sec.oldPath ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const p = sec.oldPath!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.newPath !== p && tree.get(sec.newPath!) !== null) throw new Fail('exists', sec.newPath!);
    const after = applyUnifiedHunks(parseFile(before), sec.hunks, strict, p);
    const text = renderFile(after);
    if (sec.newPath !== p) {
      tree.set(p, null);
      tree.set(sec.newPath!, text);
      return { move: { from: p, to: sec.newPath! } };
    }
    tree.set(p, text);
  };
}

function parseUnified(lines: string[]): EditFn[] {
  interface Draft {
    gitOld: string | null;
    gitNew: string | null;
    pairOld: string | null;
    pairNew: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: Hunk[];
    hasPair: boolean;
  }
  const pathOf = (line: string): string | null => {
    let s = line.slice(4);
    const tab = s.indexOf('\t');
    if (tab >= 0) s = s.slice(0, tab);
    s = s.trim();
    if (s === '/dev/null') return null;
    if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
    return s;
  };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      cur = { gitOld: m[1]!, gitNew: m[2]!, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [], hasPair: false };
      drafts.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = pathOf(line);
        cur.pairNew = pathOf(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = { gitOld: null, gitNew: null, pairOld: pathOf(line), pairNew: pathOf(lines[i + 1]!), renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [], hasPair: true };
      drafts.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      const a = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          i++;
        } else break;
      }
      while (raw.length > 0) {
        const last = raw[raw.length - 1]!;
        if (last === '' || last === ' ') raw.pop();
        else break;
      }
      cur.hunks.push({ a, items: parseBody(raw) });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseErr(i + 2);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return drafts.map((d) =>
    unifiedSectionEdit({
      oldPath: d.pairOld ?? d.renameFrom ?? d.gitOld,
      newPath: d.pairNew ?? d.renameTo ?? d.gitNew,
      isCreate: d.isCreate,
      isDelete: d.isDelete,
      hunks: d.hunks,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[]): EditFn {
  return (tree, strict) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const loc = locateFrom(f.lines, oldLines, strict, 0);
    if (loc === null) throw new Fail('no-match', path);
    if (loc.pos.length > 1) throw new Fail('ambiguous', path);
    const at = loc.pos[0]!;
    const oItems: BodyItem[] = oldLines.map((t) => ({ kind: '-' as const, text: t, noeol: false }));
    const nItems: BodyItem[] = newLines.map((t) => ({ kind: '+' as const, text: t, noeol: false }));
    const repl = buildReplacement(f.lines, at, oItems, nItems, loc.tier);
    const lines = [...f.lines.slice(0, at), ...repl, ...f.lines.slice(at + oldLines.length)];
    tree.set(path, renderFile({ br: f.br, lines, final: f.final }));
  };
}

function parseSearchReplace(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseErr(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(searchIdx + 1);
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(searchIdx + 1);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function applyV4aChunks(f: FileText, chunks: Chunk[], strict: boolean, path: string): FileText {
  let cur = f;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const at = locateSingle(cur.lines, ch.anchor, strict, cursor);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const items = parseBody(ch.body);
    const oItems = items.filter((it) => it.kind === ' ' || it.kind === '-');
    const nItems = items.filter((it) => it.kind === ' ' || it.kind === '+');
    const oLen = oItems.length;
    if (oLen === 0) {
      const at = ch.eof ? cur.lines.length : cursor;
      const repl = nItems.map((it) => it.text);
      const lines = [...cur.lines.slice(0, at), ...repl, ...cur.lines.slice(at)];
      cur = { br: cur.br, lines, final: cur.final };
      cursor = at + repl.length;
      continue;
    }
    const old = oItems.map((it) => it.text);
    const loc = locateFrom(cur.lines, old, strict, cursor);
    if (loc === null) throw new Fail('no-match', path);
    const at = loc.pos[0]!;
    if (ch.eof && at + oLen !== cur.lines.length) throw new Fail('no-match', path);
    const repl = buildReplacement(cur.lines, at, oItems, nItems, loc.tier);
    const lines = [...cur.lines.slice(0, at), ...repl, ...cur.lines.slice(at + oLen)];
    cur = { br: cur.br, lines, final: cur.final };
    cursor = at + repl.length;
  }
  return cur;
}

function v4aAddEdit(path: string, content: string[]): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[]): EditFn {
  return (tree, strict) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const after = applyV4aChunks(parseFile(before), chunks, strict, path);
    const text = renderFile(after);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, text);
      return { move: { from: path, to: moveTo } };
    }
    tree.set(path, text);
  };
}

function parseV4aUpdate(lines: string[], start: number, last: number): { edit: EditFn; next: number } {
  const path = lines[start]!.slice('*** Update File:'.length).trim();
  let moveTo: string | null = null;
  let i = start + 1;
  if (i < last && lines[i]!.startsWith('*** Move to:')) {
    moveTo = lines[i]!.slice('*** Move to:'.length).trim();
    i++;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  let firstChunk = true;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  while (i < last) {
    const line = lines[i]!;
    if (isSectionStart(line)) break;
    if (line.trimEnd() === '*** End of File' && !line.startsWith(' ')) {
      if (cur !== null) {
        cur.eof = true;
        cur = null;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      firstChunk = false;
      i++;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (firstChunk) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
        } else {
          throw new ParseErr(i + 1);
        }
      }
      cur.body.push(line);
      i++;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (chunks.length > 0) {
    const lc = chunks[chunks.length - 1]!;
    while (lc.body.length > 0) {
      const l = lc.body[lc.body.length - 1]!;
      if (l === '' || l === ' ') lc.body.pop();
      else break;
    }
    // Blank lines at the end of a section are not part of it: a chunk left
    // with no body lines, no anchor and no end-of-file mark is no chunk.
    if (lc.body.length === 0 && lc.anchor === null && !lc.eof) chunks.pop();
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(start + 1);
  return { edit: v4aUpdateEdit(path, moveTo, chunks), next: i };
}

function parseV4a(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      const content: string[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l === '') {
          content.push('');
          i++;
        } else if (l.startsWith('+')) {
          content.push(l.slice(1));
          i++;
        } else break;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push(v4aAddEdit(path, content));
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      edits.push(v4aDeleteEdit(line.slice('*** Delete File:'.length).trim()));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const res = parseV4aUpdate(lines, i, last);
      edits.push(res.edit);
      i = res.next;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits                                               */
/* ------------------------------------------------------------------ */

function jsonEditFn(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, renderFile({ br: f.br, lines, final: f.final }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEditFn(x);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditFn(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(idx + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 4: detecting the format                                     */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: the command line, the output, the write       */
/* ------------------------------------------------------------------ */

function parsePatch(kind: string, text: string, lines: string[]): EditFn[] {
  if (kind === 'unified') return parseUnified(lines);
  if (kind === 'search-replace') return parseSearchReplace(lines);
  if (kind === 'v4a') return parseV4a(lines);
  return parseJson(text, lines);
}

function outputRows(tree: Tree, moves: { from: string; to: string }[]): string[] {
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const m of moves) {
    const wasFrom = tree.original(m.from);
    const nowFrom = tree.get(m.from);
    const wasTo = tree.original(m.to);
    const nowTo = tree.get(m.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      consumed.add(m.from);
      consumed.add(m.to);
    }
  }
  for (const p of tree.knownPaths()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` });
  }
  rows.sort((a, b) => {
    const c = Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8'));
    if (c !== 0) return c;
    return a.line < b.line ? -1 : a.line > b.line ? 1 : 0;
  });
  return rows.map((r) => r.line);
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 ? null : pos[0]!;
  let text: string;
  try {
    text = readFileSync(patchArg === null || patchArg === '-' ? 0 : patchArg, 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parsePatch(kind, text, lines);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      const r = edit(tree, strict);
      if (r !== undefined && r.move !== undefined) moves.push(r.move);
    } catch (e) {
      if (e instanceof Fail) {
        tree.restore(snap);
        fails.push(e);
      } else {
        throw e;
      }
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = outputRows(tree, moves);
  if (!check) {
    for (const p of [...tree.pendingPaths()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const v = tree.get(p);
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows, `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
