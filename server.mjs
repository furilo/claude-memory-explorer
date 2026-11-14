#!/usr/bin/env node
// Local, read-only browser for Claude Code's memories.
// Usage: node server.mjs [--port 4321] [--no-open]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUsageIndex } from './usage.mjs';

const args = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argVal('--port', process.env.PORT || 4321));
const OPEN = !args.includes('--no-open');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'memory-explorer', 'usage.json');
const usage = createUsageIndex({ projectsDir: PROJECTS_DIR, cacheFile: CACHE_FILE });

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
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

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
      const { meta, body } = parseFrontmatter(raw);
      const md = typeof meta.metadata === 'object' ? meta.metadata : {};
      project.memories.push({
        file: f,
        path: shortPath(full),
        name: meta.name || f.replace(/\.md$/, ''),
        description: meta.description || '',
        type: md.type || meta.type || 'untyped',
        modified: md.modified || stat.mtime.toISOString(),
        created: (stat.birthtime.getTime() ? stat.birthtime : stat.mtime).toISOString(),
        session: md.originSessionId || null,
        body: body.trim(),
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
  const STATIC = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/charts.js': ['charts.js', 'text/javascript'], '/graph.js': ['graph.js', 'text/javascript'] };
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
  console.log(`Memory Explorer → ${url}  (reading ${PROJECTS_DIR})`);
  usage.refresh(); // first usage scan, in the background
  if (OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${cmd} ${url}`);
  }
});
