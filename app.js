import { columns, bars, lines, installTooltip } from './charts.js';
import { packedLayout, communities, hullPath, installPanZoom } from './graph.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOCALE = 'en-US';
const TYPES = ['project', 'feedback', 'reference', 'user'];
const TYPE_LABEL = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };
const typeColor = t => TYPES.includes(t) ? `var(--t-${t})` : 'var(--t-other)';
const VIEWS = { memories: 'Memories', graph: 'Graph', stats: 'Stats', health: 'Health' };
const SORTS = { recent: 'Recent', reads: 'Most read', lastRead: 'Last read', name: 'Name' };

const icon = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  memories: icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  graph: icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.4 7l7.2 1.4M7 8.4l1.3 7.2M16.3 11l-5.6 5.4"/>'),
  stats: icon('<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>'),
  health: icon('<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>'),
  all: icon('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  refresh: icon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
};

let data = { projects: [], emptyDirs: [] };
let all = [];                    // flattened memories, each with .project
let usage = { status: 'loading', data: null, progress: null };
// view = tab; project = scope ('*' = all); selProject/file = open memory
const state = {
  view: 'memories', project: '*', selProject: null, file: null, q: '', types: new Set(), sort: 'recent',
  pfilter: '', graphIsolated: true, graphSize: 'reads', graphPin: null,
};

// ---------- Routing: #/<view>/<scope>/<project>/<file> ----------
function readHash() {
  const [view, scope, p, f] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  state.view = VIEWS[view] ? view : 'memories';
  state.project = scope || '*';
  state.selProject = p || null;
  state.file = f || null;
}
const hrefFor = (view, scope, project, file) => '#/' + [view, scope, project, file].filter(Boolean).map(encodeURIComponent).join('/');
const memHref = (project, file) => hrefFor('memories', state.project, project, file);
window.addEventListener('hashchange', () => { readHash(); render(); });

// ---------- Loading ----------
async function loadMemories() {
  data = await (await fetch('/api/memories')).json();
  all = data.projects.flatMap(p => p.memories.map(m => ({ ...m, project: p })));
}
let usageTimer = null;
async function loadUsage() {
  clearTimeout(usageTimer);
  try { usage = await (await fetch('/api/usage')).json(); } catch { usage = { status: 'error', data: null }; }
  // poll every second while the transcripts are being scanned
  if (usage.status === 'scanning' || usage.status === 'refreshing') usageTimer = setTimeout(loadUsage, 1000);
  render();
}
async function load() {
  await loadMemories();
  readHash();
  render();
  loadUsage();
}
async function refresh() { await loadMemories(); render(); loadUsage(); }

// ---------- Utilities ----------
const projLabel = p => p.path.split('/').filter(Boolean).pop() || p.path;
const projParent = p => p.path.split('/').slice(0, -1).join('/') || '/';
const projectById = id => data.projects.find(p => p.id === id);
function fmtDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(LOCALE, opts);
}
const fmtShort = iso => fmtDate(iso, { day: 'numeric', month: 'short' });
const fmtTime = iso => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const fmtKB = b => (b / 1024).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + ' KB';
const pct = (a, b) => b ? Math.round((a / b) * 100) + '%' : '–';
const plural = (n, one, many) => `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`;
const daysAgo = iso => Math.floor((Date.now() - new Date(iso)) / 86400000);
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(`(${esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}
const unesc = s => new DOMParser().parseFromString(s, 'text/html').documentElement.textContent;
function findMemory(project, ref) {
  ref = unesc(ref).trim().replace(/\.md$/, '').toLowerCase();
  const match = m => m.name.toLowerCase() === ref || m.file.toLowerCase() === ref + '.md';
  return project.memories.find(match) || null;
}
const usageReady = () => !!usage.data;
function usageOf(m) {
  const u = usage.data?.memories[`${m.project.id}/${m.file}`];
  const sessions = u?.sessions || [];
  return {
    reads: u?.reads || 0, writes: u?.writes || 0, lastRead: u?.lastRead || null, lastWrite: u?.lastWrite || null,
    sessions: sessions.length,
    otherSessions: sessions.filter(s => s !== m.session).length, // not counting the session that created it
  };
}
const typeTag = t => `<span class="tag"><i style="background:${typeColor(t)}"></i>${esc(TYPE_LABEL[t] || t)}</span>`;
const windowText = () => {
  const w = usage.data?.window;
  return w ? `${plural(w.sessions, 'session', 'sessions')} between ${fmtDate(w.from)} and ${fmtDate(w.to)}` : '';
};

// ---------- Minimal markdown ----------
function inline(s, project) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, ref) => {
    const m = project && findMemory(project, ref);
    return m ? `<a href="${memHref(project.id, m.file)}">${ref}</a>`
             : `<a class="broken" title="This memory does not exist">${ref}</a>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    if (project && /^[\w.-]+\.md$/.test(u)) {
      const m = findMemory(project, u);
      if (m) return `<a href="${memHref(project.id, m.file)}">${t}</a>`;
    }
    return /^(https?:|mailto:)/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : `<a class="broken">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  return s;
}
function markdown(src, project) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let out = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    if (/^\s*$/.test(l)) { i++; continue; }
    const h = l.match(/^(#{1,6})\s+(.*)/);
    if (h) { out += `<h${h[1].length}>${inline(h[2], project)}</h${h[1].length}>`; i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out += '<hr>'; i++; continue; }
    if (/^>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out += `<blockquote>${markdown(buf.join('\n'), project)}</blockquote>`; continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item, project)}</li>`);
      }
      out += ordered ? `<ol start="${parseInt(l, 10) || 1}">${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`; continue;
    }
    if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); i += 2; const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(row(lines[i++]));
      out += `<table><tr>${head.map(c => `<th>${inline(c, project)}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, project)}</td>`).join('')}</tr>`).join('')}</table>`;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s+|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out += `<p>${buf.map(b => inline(b, project)).join('<br>')}</p>`;
  }
  return out;
}

// ---------- Health checks ----------
const LIMIT_WARN = 0.7; // warn from 70% of a limit
function indexStatus(p) {
  const L = data.indexLimits;
  if (!p.index) return { level: 'critical', label: 'No MEMORY.md', ratio: 0 };
  const ratio = Math.max(p.index.bytes / L.bytes, p.index.lines / L.lines);
  return ratio >= 1 ? { level: 'critical', label: 'Over the limit', ratio }
       : ratio >= LIMIT_WARN ? { level: 'warning', label: 'Near the limit', ratio }
       : { level: 'good', label: 'OK', ratio };
}
function indexRefs(p) {
  return new Set([...(p.index?.body || '').matchAll(/\]\(([^)\s]+\.md)\)/g)].map(m => m[1]));
}
const stripCode = s => s.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, ''); // code does not count
function brokenLinks(projects) {
  const out = [];
  for (const p of projects) for (const m of p.memories) {
    for (const [, ref] of stripCode(m.body).matchAll(/\[\[([^\]]+)\]\]/g)) {
      if (!findMemory(p, esc(ref))) out.push({ p, m, ref });
    }
  }
  return out;
}
function healthOf(scope) {
  const projects = scope === '*' ? data.projects : data.projects.filter(p => p.id === scope);
  const mems = all.filter(m => projects.includes(m.project));
  const index = projects.map(p => {
    const refs = indexRefs(p), files = new Set(p.memories.map(m => m.file));
    return { p, status: indexStatus(p), notIndexed: p.memories.filter(m => !refs.has(m.file)), dangling: [...refs].filter(r => !files.has(r)) };
  });
  const unread = usageReady() ? mems.filter(m => usageOf(m).reads === 0).sort((a, b) => a.modified.localeCompare(b.modified)) : null;
  return { projects, mems, index, broken: brokenLinks(projects), unread, empty: scope === '*' ? data.emptyDirs : [] };
}
// Did any analysed session load this project's index?
const hasSessions = p => (usage.data?.projects[p.id]?.loadSessions || 0) > 0;
const projectIssues = p => (indexStatus(p).level !== 'good' ? 1 : 0) + brokenLinks([p]).length;
const STATUS_ICON = { good: '✓', warning: '!', critical: '✕', info: 'i' };
const statusPill = (level, label) => `<span class="status ${level}"><b>${STATUS_ICON[level]}</b>${esc(label)}</span>`;

// ---------- Render ----------
function render() {
  document.body.dataset.view = state.view;
  const tip = document.getElementById('tip');
  if (tip) tip.style.display = 'none'; // the content under the cursor may have changed
  renderSidebar();
  if (state.view === 'memories') { renderChips(); renderList(); renderDetail(); }
  else if (state.view === 'graph') renderGraph();
  else if (state.view === 'stats') renderStats();
  else renderHealth();
}

function renderSidebar() {
  $('#sub').textContent = `${plural(all.length, 'memory', 'memories')} · ${plural(data.projects.length, 'project', 'projects')}`;

  const issues = data.projects.reduce((a, p) => a + projectIssues(p), 0);
  $('#views').innerHTML = Object.entries(VIEWS).map(([k, label], i) =>
    `<a class="nav ${state.view === k ? 'sel' : ''}" href="${hrefFor(k, state.project)}">
      ${ICONS[k]}<span>${label}</span>
      ${k === 'health' && issues ? `<span class="badge" title="${plural(issues, 'warning', 'warnings')}">${issues}</span>` : ''}
      <kbd>${i + 1}</kbd></a>`).join('');

  const f = state.pfilter.toLowerCase();
  const projects = data.projects.filter(p => !f || p.path.toLowerCase().includes(f));
  $('#pfilter').hidden = data.projects.length <= 6;
  const item = (id, title, sub, count, mono, extra = '', warn = 0) =>
    `<a class="proj ${state.project === id ? 'sel' : ''} ${extra}" href="${hrefFor(state.view, id)}" title="${esc(sub || title)}">
       <span class="mono">${mono}</span>
       <span class="pname"><span>${esc(title)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
       ${warn ? `<span class="pwarn" title="${plural(warn, 'warning', 'warnings')}"></span>` : ''}
       <span class="count">${count}</span>
     </a>`;
  $('#projects').innerHTML = item('*', 'All projects', '', all.length, ICONS.all) +
    projects.map(p => item(p.id, projLabel(p), projParent(p) + (p.exists ? '' : ' · missing'), p.memories.length,
      esc(projLabel(p).replace(/^[^a-z0-9]*/i, '').slice(0, 1).toUpperCase() || '?'), p.exists ? '' : 'gone', projectIssues(p))).join('') +
    (f && !projects.length ? '<div class="side-empty">No projects match</div>' : '');

  let foot;
  if (usage.status === 'scanning' && !usage.data) foot = `<span class="spin"></span>Scanning transcripts… ${usage.progress?.done || 0}/${usage.progress?.total || '?'}`;
  else if (usage.status === 'error') foot = 'Usage analysis failed';
  else if (usage.data) foot = `<span class="live ${usage.status === 'refreshing' ? 'busy' : ''}"></span>Usage from ${plural(usage.data.window.sessions, 'session', 'sessions')}<br><span class="muted">updated ${fmtTime(usage.data.scan?.at || Date.now())}</span>`;
  else foot = 'Loading…';
  $('#side-foot').innerHTML = `<div class="foot-text">${foot}</div><button class="icon-btn" id="refresh" title="Reload memories and usage">${ICONS.refresh}</button>`;
}

// ----- Memories view -----
const scoped = () => state.project === '*' ? all : all.filter(m => m.project.id === state.project);
function filtered() {
  const q = state.q.toLowerCase();
  const items = scoped().filter(m =>
    (!state.types.size || state.types.has(m.type)) &&
    (!q || (m.name + '\n' + m.description + '\n' + m.body).toLowerCase().includes(q)));
  const by = {
    recent: (a, b) => b.modified.localeCompare(a.modified),
    reads: (a, b) => usageOf(b).reads - usageOf(a).reads || usageOf(b).sessions - usageOf(a).sessions || b.modified.localeCompare(a.modified),
    lastRead: (a, b) => (usageOf(b).lastRead || '').localeCompare(usageOf(a).lastRead || '') || b.modified.localeCompare(a.modified),
    name: (a, b) => a.name.localeCompare(b.name, LOCALE),
  }[state.sort];
  return items.sort(by);
}

function renderChips() {
  const counts = {};
  scoped().forEach(m => counts[m.type] = (counts[m.type] || 0) + 1);
  const types = [...TYPES.filter(t => counts[t]), ...Object.keys(counts).filter(t => !TYPES.includes(t))];
  $('#chips').innerHTML = types.map(t =>
    `<button class="chip ${state.types.has(t) ? 'on' : ''}" data-t="${esc(t)}"><i style="background:${typeColor(t)}"></i>${esc(TYPE_LABEL[t] || t)} ${counts[t]}</button>`).join('') +
    `<select id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, l]) =>
      `<option value="${k}" ${state.sort === k ? 'selected' : ''} ${k !== 'recent' && k !== 'name' && !usageReady() ? 'disabled' : ''}>${l}</option>`).join('')}</select>`;
}

function usageLine(m) {
  if (!usageReady()) return '';
  const u = usageOf(m);
  if (!u.reads) return ' · <span class="unread">never read</span>';
  return ` · ${plural(u.reads, 'read', 'reads')} · ${plural(u.sessions, 'session', 'sessions')}` +
    (state.sort === 'lastRead' ? ` · last ${fmtShort(u.lastRead)}` : '');
}

let lastListed = null;
function renderList() {
  const items = filtered();
  const proj = projectById(state.project);
  let html = '';
  if (proj?.index && !state.q && !state.types.size) {
    html += `<a class="item ${state.selProject === proj.id && state.file === 'MEMORY.md' ? 'sel' : ''}" href="${memHref(proj.id, 'MEMORY.md')}">
      <div class="title"><span class="tag index">Index</span> MEMORY.md</div>
      <div class="desc">The index Claude loads at the start of every session</div></a>`;
  }
  html += items.map(m => `
    <a class="item ${m.project.id === state.selProject && m.file === state.file ? 'sel' : ''}" href="${memHref(m.project.id, m.file)}">
      <div class="title">${typeTag(m.type)} ${highlight(m.name, state.q)}</div>
      <div class="desc">${highlight(m.description, state.q)}</div>
      <div class="meta">${fmtDate(m.modified)}${state.project === '*' ? ' · ' + esc(projLabel(m.project)) : ''}${usageLine(m)}</div>
    </a>`).join('');
  $('#list').innerHTML = html || '<div class="empty">No memories match</div>';
  const key = state.selProject + '/' + state.file;
  if (state.file && key !== lastListed) { $('#list .item.sel')?.scrollIntoView({ block: 'nearest' }); lastListed = key; }
}

function usageFacts(m) {
  if (!usageReady()) return `<div class="usage muted">${usage.status === 'error' ? 'Usage not available' : 'Analysing usage…'}</div>`;
  const u = usageOf(m);
  const parts = [];
  if (u.reads) {
    parts.push(`<b>${plural(u.reads, 'read', 'reads')}</b> in ${plural(u.sessions, 'session', 'sessions')}` +
      (m.session ? ` (${u.otherSessions} besides the one that created it)` : ''));
    parts.push(`last read ${fmtDate(u.lastRead)}`);
  } else {
    parts.push('<b class="unread">Never read</b> in the analysed sessions');
  }
  if (u.writes) parts.push(`${plural(u.writes, 'write', 'writes')}, last on ${fmtDate(u.lastWrite)}`);
  return `<div class="usage">${parts.join(' · ')}<div class="muted">Usage measured over ${windowText()}</div></div>`;
}

let lastShown = null;
function renderDetail() {
  const proj = projectById(state.selProject);
  if (!proj || !state.file) { $('#detail').innerHTML = '<div class="placeholder">Pick a memory<br><br><kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>1</kbd>–<kbd>4</kbd> views</div>'; return; }
  let html;
  if (state.file === 'MEMORY.md' && proj.index) {
    const st = indexStatus(proj), L = data.indexLimits;
    html = `<article>
      <div class="head"><span class="tag index">Index</span><h2>MEMORY.md</h2>
      <p class="desc">${esc(proj.path)}</p></div>
      <div class="facts"><span>Modified ${fmtDate(proj.index.mtime)}</span>
        <span>${fmtKB(proj.index.bytes)} of ${fmtKB(L.bytes)} · ${proj.index.lines} of ${L.lines} lines</span>
        ${statusPill(st.level, st.label)}
        <span><code>${esc(proj.memDir)}/MEMORY.md</code></span></div>
      <div class="md">${markdown(proj.index.body, proj)}</div></article>`;
  } else {
    const m = proj.memories.find(x => x.file === state.file);
    if (!m) { $('#detail').innerHTML = '<div class="placeholder">Memory not found</div>'; return; }
    const mm = all.find(x => x.project === proj && x.file === m.file);
    const backlinks = proj.memories.filter(o => o !== m && (o.body.includes(`[[${m.name}]]`) || o.body.includes(`(${m.file})`)));
    html = `<article>
      <div class="head">${typeTag(m.type)}<h2>${esc(m.name)}</h2><p class="desc">${esc(m.description)}</p></div>
      <div class="facts">
        <span>Modified ${fmtDate(m.modified)}</span>
        <span>${esc(proj.path)}</span>
        <span><code>${esc(m.path)}</code> <button class="copy" data-copy="${esc(m.path)}">copy path</button></span>
        ${m.session ? `<span>session <code>${esc(m.session.slice(0, 8))}</code></span>` : ''}
        <a class="facts-link" href="${hrefFor('graph', state.project)}" data-graph-sel="${esc(proj.id + '/' + m.file)}">View in graph →</a>
      </div>
      ${usageFacts(mm)}
      <div class="md">${markdown(m.body, proj)}</div>
      ${backlinks.length ? `<div class="backlinks"><h4>Linked from</h4>${backlinks.map(b =>
        `<a href="${memHref(proj.id, b.file)}">${esc(b.name)}</a>`).join('')}</div>` : ''}
    </article>`;
  }
  $('#detail').innerHTML = html;
  const key = proj.id + '/' + state.file;
  if (key !== lastShown) { $('#detail').scrollTop = 0; lastShown = key; }
}

// ----- Stats view -----
const typeSeries = mems => TYPES.filter(t => mems.some(m => m.type === t))
  .concat([...new Set(mems.map(m => m.type))].filter(t => !TYPES.includes(t)))
  .map(t => ({ key: t, label: TYPE_LABEL[t] || t, color: typeColor(t) }));
const INK = 'var(--ink-series)', INK_SOFT = 'var(--ink-soft)';

function monthsBetween(a, b) {
  const out = [], d = new Date(a.slice(0, 7) + '-01T00:00:00Z'), end = b.slice(0, 7);
  for (; d.toISOString().slice(0, 7) <= end; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(d.toISOString().slice(0, 7));
  return out;
}
const monthLabel = (ym, short) => new Date(ym + '-01T00:00:00Z').toLocaleDateString(LOCALE, short ? { month: 'short', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekLabel = (r, short) => short ? fmtShort(r.x + 'T12:00:00') : `Week of ${fmtDate(r.x + 'T12:00:00')}`;

function tile(label, value, sub) {
  return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}</div>`;
}

function renderStats() {
  const scope = state.project, proj = projectById(scope);
  const projects = proj ? [proj] : data.projects;
  const mems = scoped();
  const U = usage.data;
  const scopeName = proj ? projLabel(proj) : 'all projects';
  const types = typeSeries(mems);
  let html = `<div class="page"><header class="page-head"><h2>Stats</h2><p>${esc(scopeName)}${U ? ` · usage measured over ${windowText()}` : ''}</p></header>`;

  // Headline numbers
  const read = U ? mems.filter(m => usageOf(m).reads > 0).length : null;
  const pu = projects.map(p => U?.projects[p.id]).filter(Boolean);
  const loadSessions = pu.reduce((a, p) => a + p.loadSessions, 0), readSessions = pu.reduce((a, p) => a + p.readSessions, 0);
  const loads = pu.reduce((a, p) => a + p.loads, 0);
  const biggest = projects.filter(p => p.index).sort((a, b) => b.index.bytes - a.index.bytes)[0];
  html += `<div class="tiles">
    ${tile('Memories', mems.length.toLocaleString(LOCALE), proj ? types.map(t => `${mems.filter(m => m.type === t.key).length} ${t.label.toLowerCase()}`).join(' · ') : plural(projects.length, 'project', 'projects'))}
    ${tile('Read at least once', U ? `${read} <small>of ${mems.length}</small>` : '…', U ? `${pct(read, mems.length)} · ${mems.length - read} never read` : 'analysing…')}
    ${tile('Sessions that opened a memory', U ? `${readSessions} <small>of ${loadSessions}</small>` : '…', U ? `${pct(readSessions, loadSessions)} of sessions with the index loaded` : '')}
    ${tile('Index loads', U ? loads.toLocaleString(LOCALE) : '…', U ? 'at session start or after compaction' : '')}
    ${biggest ? tile(proj ? 'Index size' : 'Largest index', fmtKB(biggest.index.bytes), `${pct(biggest.index.bytes, data.indexLimits.bytes)} of the ${fmtKB(data.indexLimits.bytes)} limit${proj ? '' : ' · ' + esc(projLabel(biggest))}`) : ''}
  </div><div class="grid2">`;

  // Inventory
  if (!proj) {
    html += bars({
      title: 'Memories by project', note: 'By type. Click a project to filter.',
      rows: projects.map(p => ({ label: projLabel(p), href: hrefFor('stats', p.id), v: Object.fromEntries(types.map(t => [t.key, p.memories.filter(m => m.type === t.key).length])) }))
        .sort((a, b) => Object.values(b.v).reduce((x, y) => x + y, 0) - Object.values(a.v).reduce((x, y) => x + y, 0)),
      series: types,
    });
  }
  if (mems.length) {
    const created = mems.map(m => m.created).sort();
    const months = monthsBetween(created[0], new Date().toISOString());
    html += columns({
      title: 'Memories created per month', note: 'By type, from the file creation date.',
      rows: months.map(ym => ({ x: ym, v: Object.fromEntries(types.map(t => [t.key, mems.filter(m => m.type === t.key && m.created.startsWith(ym)).length])) })),
      series: types, xLabel: (r, s) => monthLabel(r.x, s),
    });
  }

  if (U) {
    // Weekly usage (only weeks with analysed sessions)
    const ids = new Set(projects.map(p => p.id));
    const sum = (w, k) => Object.entries(w.by).filter(([mp]) => ids.has(mp)).reduce((a, [, v]) => a + v[k], 0);
    const weeks = U.weekly.filter(w => w.sessions > 0 && w.week >= (U.weekly.find(x => x.sessions >= 3)?.week || ''));
    html += columns({
      title: 'Memory reads per week', note: 'Read, cat/grep via Bash, or file attachments on memory files.',
      rows: weeks.map(w => ({ x: w.week, v: { reads: sum(w, 'reads') } })),
      series: [{ key: 'reads', label: 'Reads', color: INK }], xLabel: weekLabel,
    });
    html += columns({
      title: 'Sessions per week', note: 'Sessions with the index loaded, and how many opened a memory.',
      rows: weeks.map(w => ({ x: w.week, v: { read: sum(w, 'read'), onlyIndex: sum(w, 'loaded') - sum(w, 'read') } })),
      series: [{ key: 'read', label: 'Opened a memory', color: INK }, { key: 'onlyIndex', label: 'Only loaded the index', color: INK_SOFT }], xLabel: weekLabel,
    });
    html += columns({
      title: 'Memory writes per week', note: 'Memories created or edited (Write, Edit or Bash).',
      rows: weeks.map(w => ({ x: w.week, v: { writes: sum(w, 'writes') } })),
      series: [{ key: 'writes', label: 'Writes', color: INK }], xLabel: weekLabel,
    });
    const dashes = [null, 'dash', 'dot'];
    html += lines({
      title: 'MEMORY.md index size', note: 'What was loaded in each session. Claude Code only loads the first 200 lines or 25 KB.',
      series: projects.filter(p => U.projects[p.id]?.index.length).sort((a, b) => b.index?.bytes - a.index?.bytes).slice(0, 3)
        .map((p, i) => ({ label: projLabel(p), color: INK, dash: dashes[i], points: U.projects[p.id].index.map(([d, len]) => [d, len / 1024]) })),
      ref: { value: data.indexLimits.bytes / 1024, label: '25 KB limit' },
      fmtY: v => v.toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + ' KB',
      empty: 'No index loads recorded',
    });

    // Most read and read rate by type
    const top = mems.map(m => ({ m, u: usageOf(m) })).filter(x => x.u.reads).sort((a, b) => b.u.reads - a.u.reads).slice(0, 10);
    html += bars({
      title: 'Most read', note: 'Reads, and in how many distinct sessions.',
      rows: top.map(({ m, u }) => ({ label: m.name, href: memHref(m.project.id, m.file), v: { reads: u.reads }, sessions: u.sessions, tip: `${plural(u.sessions, 'session', 'sessions')}${proj ? '' : ' · ' + projLabel(m.project)}` })),
      series: [{ key: 'reads', label: 'Reads', color: INK }],
      valueText: r => `${r.v.reads} · ${r.sessions} sess.`, labelW: 230, empty: 'No memory read in the analysed sessions',
    });
    html += bars({
      title: 'Which types get read', note: 'Share of memories of each type read at least once.',
      rows: types.map(t => {
        const ms = mems.filter(m => m.type === t.key), r = ms.filter(m => usageOf(m).reads).length;
        return { label: `${t.label} (${r} of ${ms.length})`, v: { [t.key]: ms.length ? (r / ms.length) * 100 : 0 } };
      }),
      series: types, max: 100, valueText: (r, total) => Math.round(total) + '%', labelW: 170, showLegend: false,
    });
  } else {
    html += `<div class="chart chart-empty">${usage.status === 'error' ? 'Usage analysis failed.' : `Scanning transcripts… ${usage.progress?.done || 0}/${usage.progress?.total || '?'}`}</div>`;
  }
  html += '</div></div>';
  $('#detail').innerHTML = html;
}

// ----- Health view -----
function renderHealth() {
  const h = healthOf(state.project), proj = projectById(state.project), L = data.indexLimits;
  const worstIndex = h.index.reduce((w, i) => (!w || i.status.ratio > w.status.ratio ? i : w), null);
  const indexIssues = h.index.filter(i => i.status.level !== 'good');
  const noSessions = h.unread ? h.unread.filter(m => !hasSessions(m.project)).length : 0;

  const cards = [
    ['Index', indexIssues.length ? indexIssues.some(i => i.status.level === 'critical') ? 'critical' : 'warning' : 'good',
      worstIndex ? `${indexIssues.length ? worstIndex.status.label : 'Within the limit'} · ${pct(worstIndex.p.index?.bytes || 0, L.bytes)} of 25 KB${h.index.length > 1 ? ' (' + esc(projLabel(worstIndex.p)) + ')' : ''}` : '–', '#s-index'],
    ['Broken links', h.broken.length ? 'warning' : 'good', h.broken.length ? plural(h.broken.length, 'link', 'links') : 'None', '#s-links'],
    ['Never read', !h.unread ? 'info' : h.unread.length ? 'warning' : 'good', !h.unread ? 'Analysing…' : `${h.unread.length} of ${h.mems.length} memories` +
      (noSessions ? ` · ${noSessions} in projects without sessions` : ''), '#s-unread'],
    ...(state.project === '*' ? [['Empty folders', h.empty.length ? 'info' : 'good', h.empty.length ? plural(h.empty.length, 'folder', 'folders') : 'None', '#s-empty']] : []),
  ];
  let html = `<div class="page"><header class="page-head"><h2>Health</h2><p>${esc(proj ? projLabel(proj) : 'all projects')}</p></header>
    <div class="tiles">${cards.map(([t, lvl, txt, a]) => `<a class="tile check" href="${a}" data-anchor="${a}"><div class="tile-label">${t}</div>${statusPill(lvl, txt)}</a>`).join('')}</div>`;

  // Index
  html += `<section class="hsec" id="s-index"><h3>MEMORY.md index</h3>
    <p class="muted">Claude Code loads the first ${L.lines} lines or ${fmtKB(L.bytes)} of MEMORY.md in every session, whichever comes first; anything past that is not loaded. Warnings start at ${LIMIT_WARN * 100}%.</p>
    <table class="htable"><tr><th>Project</th><th>Size</th><th>Lines</th><th>Status</th><th>Coverage</th></tr>
    ${h.index.map(({ p, status, notIndexed, dangling }) => `<tr>
      <td><a href="${hrefFor('memories', state.project, p.id, 'MEMORY.md')}">${esc(projLabel(p))}</a></td>
      <td>${p.index ? meter(p.index.bytes / L.bytes, `${fmtKB(p.index.bytes)} of 25 KB`) : '–'}</td>
      <td>${p.index ? meter(p.index.lines / L.lines, `${p.index.lines} of ${L.lines}`) : '–'}</td>
      <td>${statusPill(status.level, status.label)}</td>
      <td>${!notIndexed.length && !dangling.length ? '<span class="muted">All indexed</span>' :
        [notIndexed.length ? `${notIndexed.length} not in the index: ${notIndexed.map(m => `<a href="${memHref(p.id, m.file)}">${esc(m.name)}</a>`).join(', ')}` : '',
         dangling.length ? `${dangling.length} entries without a file: ${dangling.map(esc).join(', ')}` : ''].filter(Boolean).join('<br>')}</td>
    </tr>`).join('')}</table></section>`;

  // Broken links
  html += `<section class="hsec" id="s-links"><h3>Broken links <span class="count">${h.broken.length}</span></h3>
    <p class="muted"><code>[[...]]</code> links that match no memory in the project. The memory system allows them to mark something not written yet.</p>
    ${h.broken.length ? `<table class="htable"><tr><th>Memory</th><th>Links to</th>${proj ? '' : '<th>Project</th>'}</tr>
      ${h.broken.map(b => `<tr><td><a href="${memHref(b.p.id, b.m.file)}">${esc(b.m.name)}</a></td><td><code>[[${esc(b.ref)}]]</code></td>${proj ? '' : `<td>${esc(projLabel(b.p))}</td>`}</tr>`).join('')}
    </table>` : '<p>None.</p>'}</section>`;

  // Never read
  html += `<section class="hsec" id="s-unread"><h3>Never-read memories ${h.unread ? `<span class="count">${h.unread.length}</span>` : ''}</h3>`;
  if (!h.unread) html += `<p class="muted">Scanning transcripts… ${usage.progress?.done || 0}/${usage.progress?.total || '?'}</p>`;
  else {
    html += `<p class="muted">No session opened them in ${windowText()}. They still take a line of the index in every session. Oldest first.</p>
      ${h.unread.length ? `<table class="htable"><tr><th>Memory</th><th>Type</th><th>Modified</th>${proj ? '' : '<th>Project</th>'}</tr>
      ${h.unread.map(m => `<tr><td><a href="${memHref(m.project.id, m.file)}">${esc(m.name)}</a>${daysAgo(m.created) < 7 ? ' <span class="muted">· recent</span>' : ''}${hasSessions(m.project) ? '' : ' <span class="muted">· project has no analysed sessions</span>'}<div class="muted small">${esc(m.description)}</div></td>
        <td>${typeTag(m.type)}</td><td class="nowrap">${fmtDate(m.modified)}</td>${proj ? '' : `<td>${esc(projLabel(m.project))}</td>`}</tr>`).join('')}
      </table>` : '<p>Every memory has been read at least once.</p>'}`;
  }
  html += '</section>';

  // Empty folders
  if (state.project === '*') {
    html += `<section class="hsec" id="s-empty"><h3>Empty memory folders <span class="count">${h.empty.length}</span></h3>
      <p class="muted">Projects with a <code>memory/</code> folder but no memories. They do no harm and can be deleted safely.</p>
      ${h.empty.length ? `<table class="htable"><tr><th>Project</th><th>Folder</th></tr>
        ${h.empty.map(e => `<tr><td>${esc(e.path)}${e.exists ? '' : ' <span class="muted">· no longer exists</span>'}</td><td><code>${esc(e.memDir)}</code></td></tr>`).join('')}
      </table>` : '<p>None.</p>'}</section>`;
  }
  html += '</div>';
  $('#detail').innerHTML = html;
}
function meter(ratio, label) {
  const level = ratio >= 1 ? 'critical' : ratio >= LIMIT_WARN ? 'warning' : 'good';
  return `<div class="meter ${level}" title="${Math.round(ratio * 100)}%"><span style="width:${Math.min(100, ratio * 100)}%"></span></div><div class="small">${label}</div>`;
}

// ----- Graph view -----
// Links between memories: [[name]] and markdown links to another .md file in the same project
function linkGraph(mems) {
  const idx = new Map(mems.map((m, i) => [`${m.project.id}/${m.file}`, i]));
  const out = mems.map(() => new Set()), inc = mems.map(() => new Set());
  const edges = [], seen = new Set();
  mems.forEach((m, i) => {
    const text = stripCode(m.body);
    const refs = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(x => x[1])
      .concat([...text.matchAll(/\]\(([\w.\-]+\.md)\)/g)].map(x => x[1]));
    for (const ref of refs) {
      const t = findMemory(m.project, esc(ref));
      const j = t ? idx.get(`${m.project.id}/${t.file}`) : undefined;
      if (j === undefined || j === i) continue;
      out[i].add(j); inc[j].add(i);
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(key)) { seen.add(key); edges.push({ s: i, t: j }); }
    }
  });
  const nbrs = mems.map((_, i) => new Set([...out[i], ...inc[i]]));
  return { edges, out, inc, nbrs };
}

// Short topic for a group: the word that appears in most memory names (e.g. "superdoc").
// Ties go to the word whose memories have more links; null when no word repeats.
const STOP = new Set(['feedback', 'with', 'from', 'that', 'this', 'para', 'como', 'sobre', 'memory', 'notes']);
function topicOf(ms, degs) {
  const count = new Map(), weight = new Map();
  ms.forEach((m, k) => {
    const words = new Set(`${m.name} ${m.file.replace(/\.md$/, '')}`.toLowerCase().split(/[^a-z0-9áéíóúñü]+/));
    for (const w of words) {
      if (w.length < 4 || /^\d+$/.test(w) || STOP.has(w)) continue;
      count.set(w, (count.get(w) || 0) + 1);
      weight.set(w, (weight.get(w) || 0) + degs[k]);
    }
  });
  const best = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || weight.get(b[0]) - weight.get(a[0]))[0];
  return best ? best[0] : null;
}

const layoutCache = new Map(); // graph key → { pos, view, … }
let graphCtx = null;           // data of the drawn graph, for highlighting and selection
const memKey = m => `${m.project.id}/${m.file}`;

function renderGraph() {
  const mems = scoped(), proj = projectById(state.project);
  const G = linkGraph(mems);
  const deg = G.nbrs.map(s => s.size);
  const linked = mems.map((_, i) => i).filter(i => deg[i] > 0);
  const isolated = mems.map((_, i) => i).filter(i => deg[i] === 0);
  const showIso = state.graphIsolated;
  const sizeBy = state.graphSize === 'links' || !usageReady() ? 'links' : 'reads';
  // Topical groups: connected components, with the large ones split by modularity
  const comps = communities(mems.length, G.edges).filter(c => c.length > 1);
  const groupOf = new Map();
  comps.forEach((c, g) => c.forEach(i => groupOf.set(i, g)));

  // Layout (cached: not recomputed when redrawing)
  const key = state.project + '|' + linked.map(i => memKey(mems[i])).join(',') + '|' + G.edges.length + '|' + showIso;
  let cached = layoutCache.get(key);
  const fresh = !cached;
  if (!cached) {
    const pk = packedLayout(mems.length, G.edges, { groupOf });
    const pos = new Map(pk.pos);
    // memories without links, in a grid below
    const maxX = Math.max(pk.width, 400);
    const isoTop = pos.size ? pk.height + 110 : 40, cols = Math.max(1, Math.floor(maxX / 36) + 1);
    if (showIso) isolated.forEach((i, k) => pos.set(i, { x: (k % cols) * 36, y: isoTop + Math.floor(k / cols) * 36 }));
    const pts = [...pos.values()], pad = 70;
    // extra room at the top for the floating toolbar
    const bx = Math.min(...pts.map(p => p.x)) - pad, by = Math.min(...pts.map(p => p.y)) - pad - 50;
    const full = { x: bx, y: by, w: Math.max(...pts.map(p => p.x)) - bx + pad, h: Math.max(...pts.map(p => p.y)) - by + pad };
    cached = { pos, isoTop, base: { ...full }, view: { ...full, full }, aspectFixed: false };
    layoutCache.set(key, cached);
  }
  const { pos, view } = cached;

  const radius = i => {
    if (sizeBy === 'links') return 4.5 + 2 * Math.sqrt(deg[i]);
    const r = usageOf(mems[i]).reads;
    return r ? 5 + 2.3 * Math.sqrt(r) : 5;
  };
  const hubOf = c => [...c].sort((a, b) => deg[b] - deg[a] || usageOf(mems[b]).reads - usageOf(mems[a]).reads)[0];
  const topics = comps.map(c => topicOf(c.map(i => mems[i]), c.map(i => deg[i])) || mems[hubOf(c)].name);

  // Group hulls (≥3 memories), drawn underneath everything
  let hulls = '', hullLabels = '';
  const hullInfo = [];
  comps.forEach((c, g) => {
    if (c.length < 3) return;
    const pts = c.map(i => ({ ...pos.get(i), r: radius(i) }));
    const top = Math.min(...pts.map(p => p.y - p.r)) - 20;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    hulls += `<path class="hull" data-g="${g}" d="${hullPath(pts, 18)}"/>`;
    const t = topics[g], label = `${t.length > 28 ? t.slice(0, 27) + '…' : t} · ${c.length}`;
    hullLabels += `<text class="hlabel" data-g="${g}" x="${cx.toFixed(1)}" y="${top.toFixed(1)}">${esc(label)}</text>`;
    hullInfo.push({ g, x: cx, y: top, len: label.length });
  });

  // Edges: soft curves; highlighted ones take the source memory's type colour
  let edges = '';
  for (const e of G.edges) {
    const a = pos.get(e.s), b = pos.get(e.t);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, qx = mx - (b.y - a.y) * 0.12, qy = my + (b.x - a.x) * 0.12;
    edges += `<path class="edge" data-s="${e.s}" data-t="${e.t}" style="--c:${typeColor(mems[e.s].type)}" d="M${a.x.toFixed(1)},${a.y.toFixed(1)}Q${qx.toFixed(1)},${qy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}"/>`;
  }

  // Nodes (halo for memories that have been read) and labels, in a layer above all nodes
  let nodes = '', labels = '', k = 0;
  for (const [i, p] of pos) {
    const m = mems[i], u = usageOf(m), r = radius(i);
    const hollow = sizeBy === 'reads' && !u.reads;
    const tip = [m.name,
      `${TYPE_LABEL[m.type] || m.type} · ${plural(deg[i], 'link', 'links')}${deg[i] ? ` (${G.out[i].size} out, ${G.inc[i].size} in)` : ''}`,
      usageReady() ? (u.reads ? `${plural(u.reads, 'read', 'reads')} in ${plural(u.sessions, 'session', 'sessions')}` : 'Never read') : null,
      proj ? null : projLabel(m.project)].filter(Boolean).join('\n');
    nodes += `<a href="${memHref(m.project.id, m.file)}" class="node" data-i="${i}" data-tip="${esc(tip)}" style="--c:${typeColor(m.type)};--d:${Math.min(k++ * 7, 700)}ms" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
      ${!hollow && sizeBy === 'reads' ? `<circle class="halo" r="${(r + 4.5).toFixed(1)}"/>` : ''}
      <circle class="dot${hollow ? ' hollow' : ''}" r="${r.toFixed(1)}"/></a>`;
    labels += `<text class="glabel" data-i="${i}" x="${p.x.toFixed(1)}" y="${(p.y + r).toFixed(1)}" dy="1.15em">${esc(m.name.length > 34 ? m.name.slice(0, 33) + '…' : m.name)}</text>`;
  }
  const isoTitle = showIso && isolated.length ? `<text class="gtitle" x="-12" y="${cached.isoTop - 34}">Unlinked (${isolated.length})</text>` : '';

  const types = typeSeries(mems);
  const compRows = comps.map((c, g) => {
    const sorted = [...c].sort((a, b) => deg[b] - deg[a]);
    const hub = mems[sorted[0]];
    const reads = c.reduce((a, i) => a + usageOf(mems[i]).reads, 0);
    return `<div class="comp" data-g="${g}" data-members="${c.join(',')}" title="Click to zoom in">
      <div class="comp-head"><span class="comp-name">${esc(topics[g])}</span><span class="comp-count">${c.length}</span></div>
      <div class="comp-meta">${topics[g] !== hub.name ? `Hub: ${esc(hub.name)} · ` : ''}${usageReady() ? `${plural(reads, 'read', 'reads')} · ` : ''}${plural(c.filter(i => !usageOf(mems[i]).reads).length, 'never read', 'never read')}${proj ? '' : ' · ' + esc(projLabel(hub.project))}</div>
      <div class="comp-members">${sorted.slice(1).map(i => `<a href="${memHref(mems[i].project.id, mems[i].file)}"><i style="background:${typeColor(mems[i].type)}"></i>${esc(mems[i].name)}</a>`).join('')}</div>
    </div>`;
  }).join('');

  $('#detail').innerHTML = `<div class="page page-graph">
    <header class="page-head"><h2>Link graph</h2>
      <p>${esc(proj ? projLabel(proj) : 'all projects')} · ${plural(linked.length, 'linked memory', 'linked memories')} · ${plural(G.edges.length, 'link', 'links')} · ${plural(comps.length, 'group', 'groups')} · ${isolated.length} unlinked</p></header>
    <div class="graph-wrap">
      ${mems.length ? `<svg id="graph" class="${fresh ? 'intro' : ''}" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" role="img" aria-label="Link graph between memories">
        <g class="l-hulls">${hulls}</g><g class="l-edges">${edges}</g><g class="l-nodes">${nodes}</g><g class="l-labels">${hullLabels}${labels}${isoTitle}</g></svg>` : '<div class="chart-empty">No memories</div>'}
      <div class="gtools">
        <label class="gtoggle"><input type="checkbox" id="g-iso" ${showIso ? 'checked' : ''}><span>Unlinked</span></label>
        <div class="seg" role="group" aria-label="Node size">
          <button data-size="reads" class="${sizeBy === 'reads' ? 'on' : ''}" ${usageReady() ? '' : 'disabled'}>Reads</button><button data-size="links" class="${sizeBy === 'links' ? 'on' : ''}">Links</button>
        </div>
        <div class="seg">
          <button data-zoom="0.75" title="Zoom in">${ICONS.plus}</button><button data-zoom="1.33" title="Zoom out">${ICONS.minus}</button><button data-zoom="reset" title="Fit">${ICONS.fit}</button>
        </div>
      </div>
      <div class="glegend">${types.map(t => `<span><i style="background:${t.color}"></i>${esc(t.label)}</span>`).join('')}
        ${sizeBy === 'reads' ? '<span><i class="hollow-swatch"></i>Never read</span><span class="muted">Size = reads</span>' : '<span class="muted">Size = links</span>'}</div>
      <div class="ghint">Scroll to zoom · drag to pan · click a node for details</div>
      <div class="gcard" id="gcard" hidden></div>
    </div>
    ${comps.length ? `<section class="hsec"><h3>Groups <span class="count">${comps.length}</span></h3>
      <p class="muted">Memories linked to each other; large sets (12 or more) are split into tightly connected communities. Each group is headed by its most linked memory. Good candidates to review together or merge. Hover to see them in the graph, click to zoom in.</p>
      <div class="comps">${compRows}</div></section>` : ''}
  </div>`;

  const el = $('#graph');
  if (!el) { graphCtx = null; return; }
  // match the view to the SVG's aspect ratio so pan/zoom maps 1:1
  if (!cached.aspectFixed) {
    const r = el.getBoundingClientRect(), a = r.height / r.width, f = view.full = { ...cached.base };
    if (f.h / f.w < a) { const nh = f.w * a; f.y -= (nh - f.h) / 2; f.h = nh; } else { const nw = f.h / a; f.x -= (nw - f.w) / 2; f.w = nw; }
    Object.assign(view, { x: f.x, y: f.y, w: f.w, h: f.h });
    cached.aspectFixed = true;
    el.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }
  if (fresh) setTimeout(() => el.classList.remove('intro'), 1400);

  // Labels: by importance, only those that fit without overlapping; zooming in fits more
  const cands = [...el.querySelectorAll('.glabel')].map(n => {
    const i = +n.dataset.i, p = pos.get(i);
    return { n, i, x: p.x, y: p.y, r: radius(i), len: n.textContent.length, prio: deg[i] * 100 + usageOf(mems[i]).reads };
  }).sort((a, b) => b.prio - a.prio);
  const hl = [...el.querySelectorAll('.hlabel')].map((n, j) => ({ n, ...hullInfo[j] }));
  let unit = 1;
  const ctx = graphCtx = { G, el, mems, deg, pos, comps, radius, focus: null, cached };
  // no focus: group labels + memories with ≥2 links; with focus: only the focused ones
  const placeLabels = () => {
    const u = unit, placed = [], focus = ctx.focus;
    const fits = box => !placed.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
    for (const h of hl) {
      const w = h.len * 6.6 * u, box = { x0: h.x - w / 2, x1: h.x + w / 2, y0: h.y - 12 * u, y1: h.y + 2 * u };
      const ok = !focus && fits(box);
      h.n.classList.toggle('lab', ok);
      if (ok) placed.push(box);
    }
    for (const c of cands) {
      if (focus ? !focus.has(c.i) : deg[c.i] < 2) { c.n.classList.remove('lab'); continue; }
      const w = c.len * 6.4 * u, box = { x0: c.x - w / 2, x1: c.x + w / 2, y0: c.y + c.r + u, y1: c.y + c.r + 15 * u };
      const ok = fits(box);
      c.n.classList.toggle('lab', ok);
      if (ok) placed.push(box);
    }
  };
  ctx.relabel = placeLabels;
  const setUnit = v => {
    unit = v.w / el.clientWidth;
    el.style.setProperty('--u', unit.toFixed(4)); // text at a constant on-screen size
    placeLabels();
  };
  setUnit(view);
  ctx.pz = installPanZoom(el, view, setUnit);
  applyGraphFocus();
  if (state.graphFit) { state.graphFit = false; const p = pinnedMembers(); if (p) ctx.pz.fit(boxOf(p.members), 90); }
}

// Focus = hovered node/group, or else the pinned selection
let graphHover = null;
function pinnedMembers() {
  const ctx = graphCtx, pin = state.graphPin;
  if (!ctx || !pin) return null;
  if (pin.node) {
    const i = ctx.mems.findIndex(m => memKey(m) === pin.node);
    return i < 0 || !ctx.pos.has(i) ? null : { node: i, members: [i, ...ctx.G.nbrs[i]] };
  }
  const set = new Set(pin.group);
  const members = ctx.mems.map((m, i) => (set.has(memKey(m)) ? i : -1)).filter(i => i >= 0);
  return members.length ? { members } : null;
}
function applyGraphFocus() {
  const ctx = graphCtx;
  if (!ctx) return;
  const pinned = pinnedMembers();
  const members = graphHover || pinned?.members || null;
  const el = ctx.el;
  ctx.focus = members ? new Set(members) : null;
  el.classList.toggle('focus', !!members);
  el.querySelectorAll('.node, .glabel').forEach(n => n.classList.toggle('hl', !!ctx.focus?.has(+n.dataset.i)));
  el.querySelectorAll('.edge').forEach(e => e.classList.toggle('hl', !!ctx.focus?.has(+e.dataset.s) && ctx.focus.has(+e.dataset.t)));
  el.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
  if (pinned?.node !== undefined) el.querySelector(`.node[data-i="${pinned.node}"]`)?.classList.add('selected');
  const pinnedGroup = state.graphPin?.group && pinned ? [...pinned.members].sort((a, b) => a - b).join(',') : null;
  document.querySelectorAll('.comp').forEach(c => c.classList.toggle('on', c.dataset.members.split(',').map(Number).sort((a, b) => a - b).join(',') === pinnedGroup));
  ctx.relabel?.();
  renderGraphCard(pinned?.node);
}
function renderGraphCard(i) {
  const card = $('#gcard'), ctx = graphCtx;
  if (!card) return;
  if (i === undefined || !ctx) { card.hidden = true; return; }
  const m = ctx.mems[i], u = usageOf(m);
  const nb = [...ctx.G.nbrs[i]].sort((a, b) => ctx.deg[b] - ctx.deg[a]);
  card.hidden = false;
  card.innerHTML = `<button class="icon-btn gclose" data-gclose title="Close (Esc)">${ICONS.close}</button>
    ${typeTag(m.type)}
    <h4>${esc(m.name)}</h4>
    <p class="gdesc">${esc(m.description)}</p>
    <div class="gstats">
      <div><b>${usageReady() ? u.reads : '…'}</b><span>reads</span></div>
      <div><b>${usageReady() ? u.sessions : '…'}</b><span>sessions</span></div>
      <div><b>${ctx.deg[i]}</b><span>links</span></div>
    </div>
    ${nb.length ? `<div class="gnb-title">Linked memories</div><div class="gnb">${nb.map(j =>
      `<button data-gsel="${esc(memKey(ctx.mems[j]))}"><i style="background:${typeColor(ctx.mems[j].type)}"></i>${esc(ctx.mems[j].name)}</button>`).join('')}</div>` : ''}
    <a class="gopen" href="${memHref(m.project.id, m.file)}">Open memory →</a>`;
}
function boxOf(indices) {
  const ctx = graphCtx, pts = indices.map(i => ctx.pos.get(i)).filter(Boolean);
  const x0 = Math.min(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y));
  return { x: x0, y: y0, w: Math.max(...pts.map(p => p.x)) - x0, h: Math.max(...pts.map(p => p.y)) - y0 };
}
function pinNode(key, fit) {
  state.graphPin = { node: key };
  graphHover = null;
  applyGraphFocus();
  const p = pinnedMembers();
  if (fit && p) graphCtx.pz.fit(boxOf(p.members), 90);
}

// ---------- Events ----------
$('#chips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  state.types.has(c.dataset.t) ? state.types.delete(c.dataset.t) : state.types.add(c.dataset.t);
  renderChips(); renderList();
});
$('#chips').addEventListener('change', e => {
  if (e.target.id === 'sort') { state.sort = e.target.value; renderList(); }
});
$('#q').addEventListener('input', e => { state.q = e.target.value.trim(); renderList(); });
$('#pfilter').addEventListener('input', e => { state.pfilter = e.target.value.trim(); renderSidebar(); });
$('aside').addEventListener('click', e => { if (e.target.closest('#refresh')) refresh(); });

$('#detail').addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) {
    navigator.clipboard.writeText(c.dataset.copy); c.textContent = 'copied ✓';
    setTimeout(() => c.textContent = 'copy path', 1200);
  }
  const gs = e.target.closest('[data-graph-sel]');
  if (gs) { state.graphPin = { node: gs.dataset.graphSel }; state.graphFit = true; } // the link then navigates to the graph
  const a = e.target.closest('[data-anchor]');
  if (a) { e.preventDefault(); document.querySelector(a.dataset.anchor)?.scrollIntoView({ behavior: 'smooth' }); }
  if (state.view !== 'graph' || !graphCtx) return;

  const z = e.target.closest('[data-zoom]');
  if (z) return z.dataset.zoom === 'reset' ? graphCtx.pz.reset() : graphCtx.pz.zoom(+z.dataset.zoom);
  const sz = e.target.closest('[data-size]');
  if (sz) { state.graphSize = sz.dataset.size; return renderGraph(); }
  if (e.target.closest('[data-gclose]')) { state.graphPin = null; return applyGraphFocus(); }
  const sel = e.target.closest('[data-gsel]');
  if (sel) return pinNode(sel.dataset.gsel, true);
  const node = e.target.closest('#graph .node');
  if (node) { e.preventDefault(); return pinNode(memKey(graphCtx.mems[+node.dataset.i]), false); }
  const comp = e.target.closest('.comp');
  if (comp && !e.target.closest('a')) {
    const members = comp.dataset.members.split(',').map(Number);
    state.graphPin = { group: members.map(i => memKey(graphCtx.mems[i])) };
    graphHover = null;
    applyGraphFocus();
    graphCtx.pz.fit(boxOf(members), 90);
    $('.graph-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  if (e.target.closest('#graph') && !graphCtx.cached.view.moved) { state.graphPin = null; applyGraphFocus(); }
});
$('#detail').addEventListener('dblclick', e => {
  const node = e.target.closest('#graph .node');
  if (node) location.hash = node.getAttribute('href');
});
$('#detail').addEventListener('change', e => {
  if (e.target.id === 'g-iso') { state.graphIsolated = e.target.checked; renderGraph(); }
});
// Hover highlight: a node and its neighbours, or a group from the list
$('#detail').addEventListener('mouseover', e => {
  if (state.view !== 'graph' || !graphCtx) return;
  const node = e.target.closest('#graph .node');
  const comp = e.target.closest('.comp');
  const next = node ? [+node.dataset.i, ...graphCtx.G.nbrs[+node.dataset.i]] : comp ? comp.dataset.members.split(',').map(Number) : null;
  if (String(next) === String(graphHover)) return;
  graphHover = next;
  applyGraphFocus();
});

document.addEventListener('keydown', e => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-4]$/.test(e.key)) {
    location.hash = hrefFor(Object.keys(VIEWS)[+e.key - 1], state.project);
    return;
  }
  if (state.view === 'graph' && e.key === 'Escape' && state.graphPin) { state.graphPin = null; applyGraphFocus(); return; }
  if (state.view !== 'memories') return;
  if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape') { $('#q').value = ''; state.q = ''; $('#q').blur(); renderList(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement?.tagName !== 'SELECT') {
    const items = [...document.querySelectorAll('#list .item')];
    if (!items.length) return;
    e.preventDefault();
    let i = items.findIndex(x => x.classList.contains('sel'));
    i = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    location.hash = items[i].getAttribute('href');
  }
});
// Coming back to the tab reloads memories and usage (the server only re-reads what changed)
window.addEventListener('focus', refresh);
// The graph's view depends on the SVG's aspect ratio: re-fit after resizing
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view !== 'graph' || !graphCtx) return;
    graphCtx.cached.aspectFixed = false; // re-fit from the original bounds
    renderGraph();
  }, 200);
});

installTooltip();
load();
