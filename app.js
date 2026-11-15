import { columns, bars, lines, installTooltip } from './charts.js';
import { packedLayout, communities, hullPath, installPanZoom } from './graph.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOCALE = 'en-US';
const TYPES = ['project', 'feedback', 'reference', 'user'];
const TYPE_LABEL = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };
const typeColor = t => TYPES.includes(t) ? `var(--t-${t})` : 'var(--t-other)';
const VIEWS = { memories: 'Memories', timeline: 'Timeline', graph: 'Graph', stats: 'Stats', health: 'Health' };
const SORTS = { recent: 'Recent', reads: 'Most read', lastRead: 'Last read', name: 'Name' };
const DOC_MODES = { doc: 'Document', raw: 'Raw' };

const icon = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  memories: icon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  graph: icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.4 7l7.2 1.4M7 8.4l1.3 7.2M16.3 11l-5.6 5.4"/>'),
  stats: icon('<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>'),
  timeline: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  terminal: icon('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 10l2.5 2-2.5 2M12.5 15h4"/>'),
  health: icon('<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>'),
  all: icon('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  refresh: icon('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7"/>'),
};

let data = { projects: [], emptyDirs: [] };
let all = [];                    // flattened memories, each with .project
let usage = { status: 'loading', data: null, progress: null };
let tl = { at: null, events: [], sessions: {} }; // /api/timeline, fetched once per finished scan
// view = tab; project = scope ('*' = all); selProject/file = open memory
const state = {
  view: 'memories', project: '*', selProject: null, file: null, q: '', types: new Set(), sort: 'recent',
  pfilter: '', tlKinds: new Set(['created', 'edited', 'read']), graphIsolated: true, graphSize: 'reads', graphPin: null,
  docMode: localStorage.getItem('memx.docMode') === 'raw' ? 'raw' : 'doc',
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
  for (const p of data.projects) for (const m of p.memories) m.body = m.raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  all = data.projects.flatMap(p => p.memories.map(m => ({ ...m, project: p })));
}
let usageTimer = null;
async function loadUsage() {
  clearTimeout(usageTimer);
  const prevAt = usage.data?.scan?.at;
  try { usage = await (await fetch('/api/usage')).json(); } catch { usage = { status: 'error', data: null }; }
  const at = usage.data?.scan?.at;
  if (at && at !== tl.at) {
    try { tl = await (await fetch('/api/timeline')).json(); } catch {}
  }
  // poll every second while the transcripts are being scanned
  if (usage.status === 'scanning' || usage.status === 'refreshing') usageTimer = setTimeout(loadUsage, 1000);
  // while a refresh runs the data is unchanged: only the sidebar status needs updating
  if (at && at === prevAt) renderSidebar(); else render();
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

// ---------- File view: the .md exactly as on disk, line by line, lightly styled ----------
// Markdown markers stay visible (dimmed), so what you see is the whole file, nothing hidden.
const mk = t => `<span class="mk">${t}</span>`;
function srcInline(s, project) {
  const stash = [];
  const keep = html => `\u0001${stash.push(html) - 1}\u0001`; // protect generated HTML from later rules
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${mk('`')}${esc(c)}${mk('`')}</code>`));
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, ref) => {
    const m = project && findMemory(project, esc(ref));
    return keep(mk('[[') + (m ? `<a href="${memHref(project.id, m.file)}">${esc(ref)}</a>` : `<span class="broken" title="This memory does not exist">${esc(ref)}</span>`) + mk(']]'));
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    let href = null;
    if (project && /^[\w.-]+\.md$/.test(u)) { const m = findMemory(project, esc(u)); if (m) href = memHref(project.id, m.file); }
    else if (/^(https?:|mailto:)/.test(u)) href = u;
    const label = href ? `<a href="${esc(href)}"${href.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}>${esc(t)}</a>` : `<span class="broken">${esc(t)}</span>`;
    return keep(mk('[') + label + mk(`](${esc(u)})`));
  });
  s = s.replace(/(^|\s)(https?:\/\/[^\s<>)]+)/g, (_, p, u) => p + keep(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`));
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${mk('**')}${t}${mk('**')}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, (_, p, t) => `${p}<em>${mk('*')}${t}${mk('*')}</em>`);
  s = s.replace(/(^|[^\w\u0001])_([^_\s][^_]*)_(?=\W|$)/g, (_, p, t) => `${p}<em>${mk('_')}${t}${mk('_')}</em>`);
  // a stashed fragment can contain earlier placeholders (code inside a link label), so restore recursively
  const restore = t => t.replace(/\u0001(\d+)\u0001/g, (_, i) => restore(stash[i]));
  return restore(s);
}
const unquote = v => v.replace(/^(["'])(.*)\1$/, '$2');
function relTime(iso) {
  const d = daysAgo(iso);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
}
// Frontmatter values are shown verbatim; some get a small visual hint next to them
function fmValue(key, val) {
  const v = esc(val), u = unquote(val.trim());
  if (key === 'type') return `<span class="fm-type" style="--c:${typeColor(u)}"><i></i>${v}</span>`;
  if (key === 'name') return `<b>${v}</b>`;
  if (/^(modified|created|updated|date)$/i.test(key) && !isNaN(Date.parse(u))) return `${v}<span class="fm-note" aria-hidden="true">${fmtDate(u)} · ${relTime(u)}</span>`;
  return v;
}
function docLines(raw, project) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  let fm = lines[0] === '---' ? 1 : 0, code = false;
  // width of the key column (indent + key + colon), so every value starts on the same column
  let kw = 0;
  if (fm) for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const m = lines[i].match(/^(\s*)([\w-]+):/);
    if (m) kw = Math.max(kw, m[1].length + m[2].length + 1);
  }
  return lines.map((l, i) => {
    let cls = '', html, m;
    if (fm === 1 && i === 0) { cls = 'fm fm-start'; html = mk('---'); }
    else if (fm === 1 && l === '---') { cls = 'fm fm-end'; html = mk('---'); fm = 2; }
    else if (fm === 1) {
      cls = 'fm';
      m = l.match(/^(\s*)([\w-]+)(:)(\s*)(.*)$/);
      html = m ? `<span class="fm-key" style="width:${kw + 2}ch">${m[1]}<span class="fm-k">${esc(m[2])}</span>${mk(':')}${m[4]}</span><span class="fm-val">${m[5] ? fmValue(m[2], m[5]) : ''}</span>`
               : `<span class="fm-val">${esc(l)}</span>`;
    }
    else if (/^\s*```/.test(l)) { code = !code; cls = 'code code-edge'; html = mk(esc(l)); }
    else if (code) { cls = 'code'; html = esc(l); }
    else if (!l.trim()) { cls = 'blank'; html = ''; }
    else if ((m = l.match(/^(#{1,6})(\s+)(.*)$/))) { cls = `h h${m[1].length}`; html = mk(m[1]) + m[2] + srcInline(m[3], project); }
    else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { cls = 'hr'; html = mk(esc(l)); }
    else if ((m = l.match(/^(>\s?)(.*)$/))) { cls = 'quote'; html = mk(esc(m[1])) + srcInline(m[2], project); }
    else if ((m = l.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/))) { cls = 'li'; html = `${m[1]}<span class="li-mk">${esc(m[2])}</span>${m[3]}${srcInline(m[4], project)}`; }
    else if (/^\s*\|.*\|\s*$/.test(l)) { cls = 'table'; html = esc(l).replace(/\|/g, mk('|')); }
    else html = srcInline(l, project);
    return `<div class="ln ${cls}"><span class="no">${i + 1}</span><span class="tx">${html}</span></div>`;
  }).join('');
}
function rawLines(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l, i) => `<div class="ln"><span class="no">${i + 1}</span><span class="tx">${esc(l)}</span></div>`).join('');
}
const fmtBytes = b => b < 1024 ? `${b} B` : fmtKB(b);
function fileCard(file, raw, path, project) {
  const lines = raw.replace(/\n$/, '').split('\n').length, bytes = new Blob([raw]).size;
  const mode = state.docMode;
  return `<article class="file">
    <div class="file-bar">
      <span class="file-name" title="${esc(path)}">${esc(file)}</span>
      <span class="file-meta">${fmtBytes(bytes)} · ${plural(lines, 'line', 'lines')}</span>
      <button class="copy" data-copy="${esc(path)}">copy path</button>
      <button class="icon-btn" data-copy="${esc(raw)}" title="Copy file contents">${ICONS.copy}</button>
      <div class="seg" role="group" aria-label="View mode">${Object.entries(DOC_MODES).map(([k, l]) =>
        `<button data-docmode="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="${mode === 'raw' ? 'raw' : 'doc'}">${mode === 'raw' ? rawLines(raw) : docLines(raw, project)}</div>
  </article>`;
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
  else if (state.view === 'timeline') renderTimeline();
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

function usageInline(m) {
  if (!usageReady()) return `<span class="muted">${usage.status === 'error' ? 'usage not available' : 'analysing usage…'}</span>`;
  const u = usageOf(m);
  const tip = [u.reads ? `${plural(u.reads, 'read', 'reads')} in ${plural(u.sessions, 'session', 'sessions')}` : 'Never read',
    u.reads && m.session ? `${u.otherSessions} besides the session that created it` : null,
    u.reads ? `Last read ${fmtDate(u.lastRead)}` : null,
    u.writes ? `${plural(u.writes, 'write', 'writes')}, last on ${fmtDate(u.lastWrite)}` : null,
    `Measured over ${windowText()}`].filter(Boolean).join('\n');
  const text = u.reads ? `${plural(u.reads, 'read', 'reads')} · ${plural(u.sessions, 'session', 'sessions')} · last ${fmtShort(u.lastRead)}` : 'never read';
  return `<span class="usage-inline${u.reads ? '' : ' unread'}" data-tip="${esc(tip)}">${text}</span>`;
}

let lastShown = null;
function renderDetail() {
  const proj = projectById(state.selProject);
  if (!proj || !state.file) { $('#detail').innerHTML = '<div class="placeholder">Pick a memory<br><br><kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>1</kbd>–<kbd>5</kbd> views</div>'; return; }
  const sep = '<span class="dot-sep">·</span>';
  let html;
  if (state.file === 'MEMORY.md' && proj.index) {
    const st = indexStatus(proj), L = data.indexLimits;
    html = `<div class="doc-page">
      <h2 class="doc-title">MEMORY.md</h2>
      <div class="meta-line"><span class="tag index">Index</span>${sep}<span>${esc(projLabel(proj))}</span>${sep}
        <span data-tip="${esc(`Loaded at the start of every session in this project\nOnly the first ${L.lines} lines or ${fmtKB(L.bytes)} are loaded`)}">${fmtKB(proj.index.bytes)} of ${fmtKB(L.bytes)} · ${proj.index.lines} of ${L.lines} lines</span>${sep}${statusPill(st.level, st.label)}</div>
      ${fileCard('MEMORY.md', proj.index.body, proj.memDir + '/MEMORY.md', proj)}</div>`;
  } else {
    const m = proj.memories.find(x => x.file === state.file);
    if (!m) { $('#detail').innerHTML = '<div class="placeholder">Memory not found</div>'; return; }
    const mm = all.find(x => x.project === proj && x.file === m.file);
    const backlinks = proj.memories.filter(o => o !== m && (o.body.includes(`[[${m.name}]]`) || o.body.includes(`(${m.file})`)));
    html = `<div class="doc-page">
      <h2 class="doc-title">${esc(m.name)}</h2>
      <div class="meta-line">${typeTag(m.type)}${sep}<span title="${esc(proj.path)}">${esc(projLabel(proj))}</span>${sep}${usageInline(mm)}${sep}
        <a class="facts-link" href="${hrefFor('graph', state.project)}" data-graph-sel="${esc(proj.id + '/' + m.file)}">View in graph →</a></div>
      ${fileCard(m.file, m.raw, m.path, proj)}
      ${backlinks.length ? `<div class="backlinks"><h4>Linked from</h4>${backlinks.map(b =>
        `<a href="${memHref(proj.id, b.file)}">${esc(b.name)}</a>`).join('')}</div>` : ''}
    </div>`;
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
      <p class="muted">Projects with a <code>memory/</code> folder but no memories. Claude Code creates the folder when a session starts; it stays empty until Claude decides something is worth remembering. Sessions counts every session (including worktrees of the same repo) that was given this folder.</p>
      ${h.empty.length ? `<table class="htable"><tr><th>Project</th><th>Sessions</th><th>Folder</th></tr>
        ${[...h.empty].sort((a, b) => emptySessions(b) - emptySessions(a)).map(e => `<tr><td>${esc(e.path)}${e.exists ? '' : ' <span class="muted">· no longer exists</span>'}</td>
          <td class="nowrap">${!usageReady() ? '…' : emptySessions(e) ? `${plural(emptySessions(e), 'session', 'sessions')}, nothing saved` : '<span class="muted">none analysed</span>'}</td>
          <td><code>${esc(e.memDir)}</code></td></tr>`).join('')}
      </table>` : '<p>None.</p>'}</section>`;
  }
  html += '</div>';
  $('#detail').innerHTML = html;
}
const emptySessions = e => usage.data?.projects[e.id]?.sessions || 0;
function meter(ratio, label) {
  const level = ratio >= 1 ? 'critical' : ratio >= LIMIT_WARN ? 'warning' : 'good';
  return `<div class="meter ${level}" title="${Math.round(ratio * 100)}%"><span style="width:${Math.min(100, ratio * 100)}%"></span></div><div class="small">${label}</div>`;
}

// ----- Timeline view -----
// Every known event, newest first, grouped by day: reads and writes found in transcripts (grouped
// by session), plus creations/edits taken from file dates when no transcript recorded them.
const TL_KINDS = { created: 'Created', edited: 'Edited', read: 'Read' };
const pad2 = n => String(n).padStart(2, '0');
const dayKey = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const shortCwd = cwd => {
  if (!cwd) return 'unknown folder';
  const parts = cwd.replace(/^\/(Users|home)\/[^/]+/, '~').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : parts.join('/');
};

function timelineItems(mems) {
  const byKey = new Map(mems.map(m => [`${m.project.id}/${m.file}`, m]));
  const projectIds = new Set(mems.map(m => m.project.id));
  const events = tl.events.filter(e => projectIds.has(e[2])); // sorted by time, oldest first
  const firstTs = new Map(), writesOf = new Map();
  for (const [ts, kind, mp, file] of events) {
    const key = `${mp}/${file}`;
    if (!firstTs.has(key)) firstTs.set(key, Date.parse(ts));
    if (kind === 'write') (writesOf.get(key) || writesOf.set(key, []).get(key)).push(Date.parse(ts));
  }
  const near = (key, ts, ms = 5 * 60000) => (writesOf.get(key) || []).some(t => Math.abs(t - ts) < ms);

  // transcript events → per (day, session) groups
  // A write is a creation when it is the first event seen for that file and it wrote the whole file
  // (Write, > redirect…), unless the file was clearly born earlier. Events cached by older versions
  // have no op: fall back to comparing with the file's birth time.
  const createdBy = new Set(); // memories whose creation a transcript recorded
  const groups = new Map();
  for (const [ts, kind, mp, file, sid, op] of events) {
    const key = `${mp}/${file}`, m = byKey.get(key), t = Date.parse(ts);
    const born = m?.createdExact ? Date.parse(m.created) : NaN;
    let k = 'read';
    if (kind === 'write') {
      const first = firstTs.get(key) === t && !createdBy.has(key);
      const isNew = op ? op === 'W' && !(born < t - 3600000) : Math.abs(t - born) < 5 * 60000;
      k = first && isNew ? 'created' : 'edited';
      if (k === 'created') createdBy.add(key);
    }
    const gk = dayKey(ts) + '|' + sid;
    const g = groups.get(gk) || { type: 'session', day: dayKey(ts), sid, first: ts, last: ts, rows: new Map() };
    if (ts < g.first) g.first = ts;
    if (ts > g.last) g.last = ts;
    const rk = k + '|' + key; // collapse repeated reads/edits of the same memory in a session
    const row = g.rows.get(rk) || { kind: k, key, m, file, mp, ts, n: 0 };
    row.n++; if (ts > row.ts) row.ts = ts;
    g.rows.set(rk, row);
    groups.set(gk, g);
  }
  const items = [...groups.values()].map(g => ({ ...g, ts: g.last, rows: [...g.rows.values()].sort((a, b) => b.ts.localeCompare(a.ts)) }));

  // file dates, when no transcript explains them. The birth time only counts when the filesystem
  // has a real one and no transcript saw the file before it (an atomic rewrite resets it).
  for (const m of mems) {
    const key = `${m.project.id}/${m.file}`, c = Date.parse(m.created), mo = Date.parse(m.modified);
    const bornOk = m.createdExact && !isNaN(c) && !createdBy.has(key) && !(firstTs.get(key) < c - 5 * 60000) && !near(key, c);
    if (bornOk) items.push({ type: 'file', kind: 'created', ts: m.created, day: dayKey(m.created), m, key });
    if (!isNaN(mo) && (!m.createdExact || mo - c > 3600000) && !near(key, mo)) items.push({ type: 'file', kind: 'edited', ts: new Date(mo).toISOString(), day: dayKey(mo), m, key });
  }
  return items.sort((a, b) => b.ts.localeCompare(a.ts));
}

// Keep only the rows of the enabled kinds
const filterKinds = (items, on) => items.map(it => it.type === 'file' ? (on.has(it.kind) ? it : null)
  : (() => { const rows = it.rows.filter(r => on.has(r.kind)); return rows.length ? { ...it, rows } : null; })()).filter(Boolean);
// One pass: events per day and kind (a session group counts each of its rows), plus sessions
function dayCounts(items) {
  const perDay = new Map();
  for (const it of items) {
    const c = perDay.get(it.day) || perDay.set(it.day, { created: 0, edited: 0, read: 0, sessions: 0 }).get(it.day);
    if (it.type === 'file') c[it.kind]++;
    else { c.sessions++; for (const r of it.rows) c[r.kind] += r.n; }
  }
  return perDay;
}

const HEATMAP_WEEKS = 53;
function heatmap(perDay) {
  if (!perDay.size) return '';
  const total = c => c.created + c.edited + c.read;
  const max = Math.max(...[...perDay.values()].map(total));
  const today = new Date(); today.setHours(12, 0, 0, 0);
  // from the oldest activity, but at most a year back (one old file date would stretch it for years)
  const oldest = new Date([...perDay.keys()].sort()[0] + 'T12:00:00');
  const limit = new Date(today); limit.setDate(limit.getDate() - 7 * (HEATMAP_WEEKS - 1));
  const first = oldest < limit ? limit : oldest;
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // back to Monday
  let cols = '', months = '', week = 0, lastMonth = -1;
  for (const d = new Date(first); d <= today; d.setDate(d.getDate() + 7), week++) {
    if (d.getMonth() !== lastMonth) { months += `<span style="grid-column:${week + 1}">${d.toLocaleDateString(LOCALE, { month: 'short' })}</span>`; lastMonth = d.getMonth(); }
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const day = new Date(d); day.setDate(d.getDate() + i);
      const k = dayKey(day), c = perDay.get(k), n = c ? total(c) : 0;
      const lvl = !n ? 0 : Math.min(4, Math.ceil(Math.sqrt(n / max) * 4));
      cells += day > today ? '<i class="hm-out"></i>' : `<i class="hm-${lvl}"${n ? ` data-day="${k}"` : ''} data-tip="${esc(fmtDate(day) + (c ? `\n${c.created} created · ${c.edited} edited · ${c.read} reads` : '\nNo activity'))}"></i>`;
    }
    cols += `<div class="hm-col">${cells}</div>`;
  }
  return `<div class="heatmap">
    <div class="hm-months" style="grid-template-columns:repeat(${week},14px)">${months}</div>
    <div class="hm-body"><div class="hm-days"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span></span></div><div class="hm-grid">${cols}</div></div>
    <div class="hm-legend">Less <i class="hm-0"></i><i class="hm-1"></i><i class="hm-2"></i><i class="hm-3"></i><i class="hm-4"></i> More</div>
  </div>`;
}

function renderTimeline() {
  const mems = scoped(), proj = projectById(state.project), U = usage.data;
  const allItems = timelineItems(mems);
  const on = state.tlKinds;
  const items = filterKinds(allItems, on);
  // chips count every kind (so a disabled one still shows its total); the heatmap and the day
  // headers follow the filter, so every heatmap day links to a day in the list
  const totals = { created: 0, edited: 0, read: 0 };
  for (const c of dayCounts(allItems).values()) for (const k in totals) totals[k] += c[k];
  const perDay = dayCounts(items);
  const memLink = (m, key) => m ? `<a class="tl-mem" href="${memHref(m.project.id, m.file)}"><i style="background:${typeColor(m.type)}"></i>${esc(m.name)}</a>`
    : `<span class="tl-mem gone"><i></i>${esc(key.split('/').pop())}<small>deleted</small></span>`;
  const kindBadge = k => `<span class="tl-kind ${k}">${TL_KINDS[k]}</span>`;
  const time = ts => new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  let html = '', lastDay = null;
  for (const it of items) {
    if (it.day !== lastDay) {
      const c = perDay.get(it.day);
      const sum = [c.created && `${c.created} created`, c.edited && `${c.edited} edited`, c.read && plural(c.read, 'read', 'reads'), c.sessions && plural(c.sessions, 'session', 'sessions')].filter(Boolean).join(' · ');
      html += `${lastDay ? '</div>' : ''}<div class="tl-day" id="day-${it.day}"><div class="tl-date"><b>${new Date(it.day + 'T12:00:00').toLocaleDateString(LOCALE, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}</b><span>${sum}</span></div>`;
      lastDay = it.day;
    }
    if (it.type === 'file') {
      html += `<div class="tl-item tl-file"><span class="tl-time">${time(it.ts)}</span><span class="tl-dot ${it.kind}"></span>
        <div class="tl-body">${kindBadge(it.kind)} ${memLink(it.m, it.key)}${proj ? '' : `<span class="tl-proj">${esc(projLabel(it.m.project))}</span>`}
        <span class="tl-src" data-tip="${esc('From the file dates: no analysed transcript recorded this change')}">file date</span></div></div>`;
    } else {
      const info = tl.sessions?.[it.sid] || {};
      html += `<div class="tl-item tl-session"><span class="tl-time">${time(it.last)}</span><span class="tl-dot session"></span>
        <div class="tl-body"><div class="tl-shead">${ICONS.terminal}<span data-tip="${esc(`Session ${it.sid}\n${info.cwd || ''}`)}">${esc(shortCwd(info.cwd))}</span>
          <code>${esc(it.sid.slice(0, 8))}</code><span class="muted">${time(it.first) === time(it.last) ? '' : `${time(it.first)}–${time(it.last)}`}</span></div>
          <div class="tl-rows">${it.rows.map(r => `<div class="tl-row">${kindBadge(r.kind)} ${memLink(r.m, r.key)}${r.n > 1 ? `<span class="tl-n">×${r.n}</span>` : ''}${proj || !r.m ? '' : `<span class="tl-proj">${esc(projLabel(r.m.project))}</span>`}</div>`).join('')}</div>
        </div></div>`;
    }
  }
  if (lastDay) html += '</div>';

  $('#detail').innerHTML = `<div class="page page-timeline">
    <header class="page-head"><h2>Timeline</h2><p>${esc(proj ? projLabel(proj) : 'all projects')} · every memory event, newest first</p></header>
    ${heatmap(perDay)}
    <div class="tl-bar">
      ${Object.entries(TL_KINDS).map(([k, l]) => `<button class="chip tl-chip ${on.has(k) ? 'on' : ''}" data-tlkind="${k}"><span class="tl-dot ${k}"></span>${l} ${totals[k]}</button>`).join('')}
      <span class="muted small">${U ? `Reads and session details come from ${windowText()}; older creations and edits come from file dates.` : 'Scanning transcripts… reads will appear when it finishes.'}</span>
    </div>
    <div class="timeline">${html || '<div class="empty">Nothing to show</div>'}</div>
  </div>`;
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
    navigator.clipboard.writeText(c.dataset.copy);
    const icon = c.classList.contains('icon-btn');
    if (icon) c.innerHTML = ICONS.check; else c.textContent = 'copied ✓';
    clearTimeout(c._reset); // repeated clicks: restore the original label, never the checkmark
    c._reset = setTimeout(() => { if (icon) c.innerHTML = ICONS.copy; else c.textContent = 'copy path'; }, 1200);
  }
  const tk = e.target.closest('[data-tlkind]');
  if (tk) { const k = tk.dataset.tlkind; state.tlKinds.has(k) ? state.tlKinds.delete(k) : state.tlKinds.add(k); return renderTimeline(); }
  const hd = e.target.closest('[data-day]');
  if (hd) { const el = document.getElementById('day-' + hd.dataset.day); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); } return; }
  const dm = e.target.closest('[data-docmode]');
  if (dm) { state.docMode = dm.dataset.docmode; localStorage.setItem('memx.docMode', state.docMode); return renderDetail(); }
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
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-5]$/.test(e.key)) {
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
