#!/usr/bin/env node
// Local, read-only browser for Claude Code's memories.
// Usage: node server.mjs [--port 4321] [--no-open] [--demo]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createUsageIndex } from './usage.mjs';
import { makeDemo } from './demo.mjs';

const args = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argVal('--port', process.env.PORT || 4321));
const OPEN = !args.includes('--no-open');
const DEMO = args.includes('--demo');
const DEFAULT_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_DIR = DEMO ? makeDemo() : path.resolve(process.env.CLAUDE_CONFIG_DIR || DEFAULT_DIR);
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HERE = path.dirname(fileURLToPath(import.meta.url));
// One cache per data folder, so another CLAUDE_CONFIG_DIR never mixes with yours. The demo is
// rebuilt on every run, so its cache lives inside it and goes away with it.
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'memory-explorer');
const LEGACY_CACHE = path.join(CACHE_DIR, 'usage.json'); // older versions used it for any folder
const CACHE_FILE = DEMO ? path.join(CLAUDE_DIR, 'usage-cache.json')
  : real(CLAUDE_DIR) === real(DEFAULT_DIR) ? LEGACY_CACHE
  : path.join(CACHE_DIR, `usage-${createHash('sha1').update(real(CLAUDE_DIR)).digest('hex').slice(0, 10)}.json`);
// Optional folder → path map (used by the demo, whose project paths do not exist on disk)
let PATH_MAP = {};
try { PATH_MAP = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'paths.json'), 'utf8')); } catch {}
const usage = createUsageIndex({ projectsDir: PROJECTS_DIR, cacheFile: CACHE_FILE, legacyCacheFile: DEMO || CACHE_FILE === LEGACY_CACHE ? null : LEGACY_CACHE });

// --- Frontmatter: minimal YAML subset (key: value, one level of nesting) ---
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, rawVal] = kv;
    const val = unquote(rawVal.trim());
    if (indent.length === 0) {
      if (val === '') { meta[key] = {}; parent = key; }
      else { meta[key] = val; parent = null; }
    } else if (parent) {
      meta[parent][key] = val;
    }
  }
  return { meta, body: text.slice(m[0].length) };
}
function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try { return v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1); } catch { return v.slice(1, -1); }
  }
  return v;
}

// --- Project folder name -> real path ---
// Claude replaces "/" (and ".") with "-", so it is ambiguous. We try to rebuild the path
// by looking on disk; if it no longer exists, an approximate version is shown.
const pathCache = new Map();
function resolveProjectPath(dirName) {
  if (pathCache.has(dirName)) return pathCache.get(dirName);
  if (PATH_MAP[dirName]) return { path: PATH_MAP[dirName], exists: true };
  const parts = dirName.replace(/^-/, '').split('-');
  let found = null;
  const walk = (base, i) => {
    if (found) return;
    if (i === parts.length) { found = base; return; }
    // try consuming 1..n segments joined by "-", "." or "_"
    for (let j = i + 1; j <= parts.length && !found; j++) {
      const chunk = parts.slice(i, j);
      const candidates = new Set([chunk.join('-'), chunk.join('.'), chunk.join('_')]);
      if (chunk[0] === '') candidates.add('.' + chunk.slice(1).join('-'));
      for (const name of candidates) {
        const p = path.join(base, name);
        try { if (fs.statSync(p).isDirectory()) walk(p, j); } catch {}
        if (found) return;
      }
    }
  };
  walk('/', 0);
  const result = found || '/' + parts.join('/');
  pathCache.set(dirName, { path: result, exists: !!found });
  return pathCache.get(dirName);
}

function shortPath(p) {
  if (DEMO && p.startsWith(CLAUDE_DIR)) return '~/.claude' + p.slice(CLAUDE_DIR.length);
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

const birthOk = st => st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs + 1000;

// --- Read every memory ---
function loadAll() {
  const projects = [];
  const emptyDirs = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const memDir = path.join(PROJECTS_DIR, d.name, 'memory');
    let files;
    try { files = fs.readdirSync(memDir).filter(f => f.endsWith('.md')); } catch { continue; }
    if (!files.length) {
      const r = resolveProjectPath(d.name);
      emptyDirs.push({ id: d.name, path: shortPath(r.path), exists: r.exists, memDir: shortPath(memDir) });
      continue;
    }
    const resolved = resolveProjectPath(d.name);
    const project = {
      id: d.name,
      path: shortPath(resolved.path),
      exists: resolved.exists,
      memDir: shortPath(memDir),
      index: null,
      memories: [],
    };
    for (const f of files) {
      const full = path.join(memDir, f);
      let raw, stat;
      try { raw = fs.readFileSync(full, 'utf8'); stat = fs.statSync(full); } catch { continue; }
      if (f === 'MEMORY.md') {
        project.index = { body: raw, mtime: stat.mtime.toISOString(), bytes: Buffer.byteLength(raw), lines: raw.split('\n').filter((l, i, a) => i < a.length - 1 || l).length };
        continue;
      }
      const { meta } = parseFrontmatter(raw);
      const md = typeof meta.metadata === 'object' ? meta.metadata : {};
      project.memories.push({
        file: f,
        path: shortPath(full),
        name: meta.name || f.replace(/\.md$/, ''),
        description: meta.description || '',
        type: md.type || meta.type || 'untyped',
        modified: md.modified || stat.mtime.toISOString(),
        // Birth time is missing on some filesystems, and can't be moved back in time on Linux
        // (so it ends up after the mtime): then fall back to the mtime and say it is a guess
        created: (birthOk(stat) ? stat.birthtime : stat.mtime).toISOString(),
        createdExact: birthOk(stat),
        session: md.originSessionId || null,
        raw, // the whole file, exactly as on disk (the client strips the frontmatter itself)
      });
    }
    project.memories.sort((a, b) => b.modified.localeCompare(a.modified));
    projects.push(project);
  }
  projects.sort((a, b) => a.path.localeCompare(b.path));
  emptyDirs.sort((a, b) => a.path.localeCompare(b.path));
  // Limits Claude Code applies when loading MEMORY.md at the start of each session
  return { claudeDir: shortPath(CLAUDE_DIR), projects, emptyDirs, indexLimits: { lines: 200, bytes: 25 * 1024 } };
}

// --- Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/memories') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(loadAll()));
  }
  if (url.pathname === '/api/usage') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(usage.get()));
  }
  if (url.pathname === '/api/timeline') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(usage.timeline()));
  }
  const STATIC = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/charts.js': ['charts.js', 'text/javascript'], '/graph.js': ['graph.js', 'text/javascript'], '/logo.svg': ['logo.svg', 'image/svg+xml'] };
  const file = STATIC[url.pathname];
  if (file) {
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(HERE, file[0])));
  }
  res.writeHead(404).end('Not found');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is in use. Try --port 4322`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Memory Explorer → ${url}  (${DEMO ? 'demo data' : 'reading ' + PROJECTS_DIR})`);
  usage.refresh(); // first usage scan, in the background
  if (OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${cmd} ${url}`);
  }
});
