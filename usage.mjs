// Memory usage analysis from session transcripts (~/.claude/projects/**/*.jsonl), with an
// incremental on-disk cache.
//
// Signals extracted:
//   load  → MEMORY.md is loaded at session start (or after compaction) ("AutoMem" attachment)
//   read  → Read, a "file" attachment, or cat/head/grep via Bash on a memory file
//   write → Write/Edit, or a redirect/sed -i via Bash on a memory file
//
// The cache stores each transcript's events and only re-reads the ones that changed
// (mtime/size). Transcripts Claude Code deletes (cleanupPeriodDays) are kept in the cache,
// marked as deleted, so the history is not lost.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const CACHE_VERSION = 1;
const NEEDLE = Buffer.from('/memory/');
const MEMRE = /\/projects\/(-[^/\s"'`\\]+)\/memory\/([\w.\-]+\.md)/g;
const RESCAN_AFTER_MS = 20_000;

export function createUsageIndex({ projectsDir, cacheFile }) {
  let cache = loadCache(cacheFile);
  let status = 'idle';
  let progress = { done: 0, total: 0 };
  let lastScan = 0;
  let summary = Object.keys(cache.files).length ? aggregate(cache) : null;
  let scanning = null;

  async function scan() {
    status = 'scanning';
    const started = Date.now();
    let files = [];
    try {
      files = (await fsp.readdir(projectsDir, { recursive: true }))
        .filter(f => f.endsWith('.jsonl') && !f.includes(`${path.sep}memory${path.sep}`))
        .map(f => path.join(projectsDir, f));
    } catch {}
    progress = { done: 0, total: files.length };
    let changed = false;
    const seen = new Set();
    for (const full of files) {
      seen.add(full);
      let st;
      try { st = await fsp.stat(full); } catch { progress.done++; continue; }
      const prev = cache.files[full];
      if (!prev || prev.deleted || prev.mtime !== st.mtimeMs || prev.size !== st.size) {
        try {
          cache.files[full] = { mtime: st.mtimeMs, size: st.size, ...describe(projectsDir, full), ...(await parseFile(full)) };
          changed = true;
        } catch (e) { /* half-written or unreadable file: retried on the next scan */ }
      }
      progress.done++;
    }
    for (const [full, entry] of Object.entries(cache.files)) {
      if (!seen.has(full) && !entry.deleted) { entry.deleted = true; changed = true; }
    }
    if (changed || !summary) {
      summary = aggregate(cache);
      saveCache(cacheFile, cache);
    }
    lastScan = Date.now();
    summary.scan = { ms: lastScan - started, at: new Date(lastScan).toISOString(), cacheFile };
    status = 'ready';
  }

  function refresh() {
    if (!scanning && Date.now() - lastScan > RESCAN_AFTER_MS) {
      scanning = scan().catch(e => { console.error('Usage analysis failed:', e); status = 'error'; })
        .finally(() => { scanning = null; });
    }
  }

  return {
    refresh,
    get() {
      refresh();
      return { status: summary && status === 'scanning' ? 'refreshing' : status, progress, data: summary };
    },
  };
}

// --- Cache ---
function loadCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.version === CACHE_VERSION) return c;
  } catch {}
  return { version: CACHE_VERSION, files: {} };
}
function saveCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(cache));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.error('Could not save the cache:', e.message); }
}

// projects/<folder>/<session>.jsonl  or  projects/<folder>/<session>/subagents/<agent>.jsonl
function describe(projectsDir, full) {
  const rel = path.relative(projectsDir, full).split(path.sep);
  const side = rel.includes('subagents');
  return { tdir: rel[0], sid: side ? rel[1] : path.basename(rel[1] || '', '.jsonl'), side };
}

// --- Extract events from a transcript ---
async function parseFile(full) {
  const buf = await fsp.readFile(full);
  const head = buf.toString('utf8', 0, Math.min(buf.length, 256 * 1024));
  const tail = buf.toString('utf8', Math.max(0, buf.length - 256 * 1024));
  const first = head.match(/"timestamp":"([^"]+)"/)?.[1] || null;
  const last = [...tail.matchAll(/"timestamp":"([^"]+)"/g)].pop()?.[1] || first;
  const cwd = head.match(/"cwd":"([^"]+)"/)?.[1] || null;

  const ev = [];
  let pos = buf.indexOf(NEEDLE), lastStart = -1;
  while (pos !== -1) {
    const start = buf.lastIndexOf(10, pos) + 1;
    let end = buf.indexOf(10, pos);
    if (end === -1) end = buf.length;
    if (start !== lastStart) {
      lastStart = start;
      const line = buf.toString('utf8', start, end);
      // Only attachments and tool calls matter; avoids parsing huge dumps.
      if (line.includes('"AutoMem"') || line.includes('"tool_use"') || line.includes('"type":"file"')) {
        try { extract(JSON.parse(line), ev); } catch {}
      }
    }
    pos = buf.indexOf(NEEDLE, end);
  }
  return { first, last, cwd, ev };
}

function memRefs(s) {
  return [...String(s || '').matchAll(MEMRE)].map(m => [m[1], m[2]]);
}

function extract(d, ev) {
  const ts = d.timestamp || null;
  const a = d.attachment;
  if (a && typeof a === 'object') {
    if (a.type === 'instructions') {
      for (const f of a.files || []) {
        if (f.type !== 'AutoMem') continue;
        const [ref] = memRefs(f.path);
        if (ref) ev.push(['load', ts, ref[0], ref[1], (f.content || '').length]);
      }
    } else if (a.type === 'file') {
      const [ref] = memRefs(a.filename);
      if (ref) ev.push(['read', ts, ref[0], ref[1]]);
    }
  }
  if (d.type !== 'assistant' || !Array.isArray(d.message?.content)) return;
  for (const c of d.message.content) {
    if (c?.type !== 'tool_use') continue;
    const inp = c.input || {};
    if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(c.name)) {
      const [ref] = memRefs(inp.file_path);
      if (ref) ev.push([c.name === 'Read' ? 'read' : 'write', ts, ref[0], ref[1]]);
    } else if (c.name === 'Bash') {
      const cmd = String(inp.command || '');
      const seen = new Set();
      for (const [mp, file] of memRefs(cmd)) {
        if (seen.has(mp + file)) continue;
        seen.add(mp + file);
        const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const writes = new RegExp(`(>>?|\\btee\\b|sed -i|\\bmv\\b|\\bcp\\b|\\brm\\b)[^|;&]*${esc}`).test(cmd);
        ev.push([writes ? 'write' : 'read', ts, mp, file]);
      }
    }
  }
}

// --- Aggregation ---
const day = ts => (ts || '').slice(0, 10);
function weekOf(ts) {
  const d = new Date(day(ts) + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

function aggregate(cache) {
  const memories = {};   // "mp/file" → usage
  const projects = {};   // mp → index loads, sessions…
  const weeks = {};      // Monday → activity
  const sessions = new Map(); // sid → { first, mps:Set (indexes loaded), reads:Set (mps read) }
  let from = null, to = null, deletedFiles = 0, files = 0;

  const proj = mp => projects[mp] ||= { loads: 0, loadSessions: new Set(), readSessions: new Set(), index: {} };
  const week = w => weeks[w] ||= { sessions: new Set(), by: {} };
  const wp = (w, mp) => (week(w).by[mp] ||= { reads: 0, writes: 0, loads: 0, loaded: 0, read: 0 });

  for (const f of Object.values(cache.files)) {
    files++;
    if (f.deleted) deletedFiles++;
    if (f.first && (!from || f.first < from)) from = f.first;
    if (f.last && (!to || f.last > to)) to = f.last;
    const s = sessions.get(f.sid) || { first: f.first, mps: new Set(), reads: new Set() };
    if (f.first && (!s.first || f.first < s.first)) s.first = f.first;
    sessions.set(f.sid, s);

    for (const [kind, ts, mp, file, len] of f.ev) {
      const w = weekOf(ts);
      if (kind === 'load') {
        const p = proj(mp);
        p.loads++; p.loadSessions.add(f.sid); s.mps.add(mp);
        if (len != null) p.index[day(ts)] = Math.max(p.index[day(ts)] || 0, len);
        if (w) wp(w, mp).loads++;
        continue;
      }
      if (file === 'MEMORY.md') continue;
      const m = memories[`${mp}/${file}`] ||= { reads: 0, writes: 0, sessions: new Set(), lastRead: null, lastWrite: null };
      if (kind === 'read') {
        m.reads++; m.sessions.add(f.sid);
        if (ts && (!m.lastRead || ts > m.lastRead)) m.lastRead = ts;
        proj(mp).readSessions.add(f.sid); s.reads.add(mp);
        if (w) wp(w, mp).reads++;
      } else {
        m.writes++;
        if (ts && (!m.lastWrite || ts > m.lastWrite)) m.lastWrite = ts;
        if (w) wp(w, mp).writes++;
      }
    }
  }
  for (const [sid, s] of sessions) { const w = weekOf(s.first); if (w) week(w).sessions.add(sid); }

  // Per week: total sessions and, per project (by[mp]): reads, writes, index loads, sessions
  // with the index loaded and, of those, how many read a memory of the project
  const weekly = Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b)).map(([w, v]) => {
    for (const sid of v.sessions) {
      const s = sessions.get(sid);
      for (const mp of s.mps) {
        wp(w, mp).loaded++;
        if (s.reads.has(mp)) wp(w, mp).read++;
      }
    }
    return { week: w, sessions: v.sessions.size, by: v.by };
  });

  return {
    window: { from, to, sessions: sessions.size, files, deletedFiles },
    memories: Object.fromEntries(Object.entries(memories).map(([k, m]) => [k, { ...m, sessions: [...m.sessions] }])),
    projects: Object.fromEntries(Object.entries(projects).map(([mp, p]) => [mp, {
      loads: p.loads,
      loadSessions: p.loadSessions.size,
      readSessions: [...p.readSessions].filter(s => p.loadSessions.has(s)).length,
      index: Object.entries(p.index).sort(([a], [b]) => a.localeCompare(b)),
    }])),
    weekly,
  };
}
