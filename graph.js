// Link graph between memories: force layout, groups (communities), hulls and pan/zoom.
// No dependencies. Layout is deterministic (fixed seed) so it does not change between reloads.

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fruchterman–Reingold. nodes: [{}], edges: [{ s, t }] (indices).
// groups (optional): group id per node; nodes are pulled towards their group's centroid and
// edges between different groups are weaker, so communities end up spatially together.
export function forceLayout(nodes, edges, { aspect = 0.62, iterations = 500, groups = null } = {}) {
  const n = nodes.length;
  if (!n) return [];
  const W = 1000, H = W * aspect, cx = W / 2, cy = H / 2;
  const rand = mulberry32(42);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * H * 0.45;
    x[i] = cx + r * Math.cos(a); y[i] = cy + r * Math.sin(a);
  }
  const k = Math.sqrt((W * H) / n) * 0.55; // ideal distance between nodes
  const gravity = 0.06;
  let temp = W / 8;
  const dx = new Float64Array(n), dy = new Float64Array(n);
  const gids = groups ? [...new Set(groups)] : [];
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = x[i] - x[j], ddy = y[i] - y[j];
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 < 0.01) { ddx = rand() - 0.5; ddy = rand() - 0.5; d2 = 0.01; }
        const f = (k * k) / d2; // repulsion k²/d, already divided by d to normalise
        dx[i] += ddx * f; dy[i] += ddy * f; dx[j] -= ddx * f; dy[j] -= ddy * f;
      }
    }
    for (const { s, t } of edges) {
      const ddx = x[s] - x[t], ddy = y[s] - y[t];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const w = groups && groups[s] !== groups[t] ? 0.35 : 1;
      const f = (d / k) * w; // attraction d²/k, divided by d
      dx[s] -= ddx * f; dy[s] -= ddy * f; dx[t] += ddx * f; dy[t] += ddy * f;
    }
    if (groups) {
      for (const g of gids) {
        let sx = 0, sy = 0, c = 0;
        for (let i = 0; i < n; i++) if (groups[i] === g) { sx += x[i]; sy += y[i]; c++; }
        if (c < 2) continue;
        sx /= c; sy /= c;
        for (let i = 0; i < n; i++) if (groups[i] === g) { dx[i] -= (x[i] - sx) * 0.12; dy[i] -= (y[i] - sy) * 0.12; }
      }
    }
    for (let i = 0; i < n; i++) {
      dx[i] -= (x[i] - cx) * gravity; dy[i] -= (y[i] - cy) * gravity / aspect;
      const disp = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const step = Math.min(disp, temp);
      x[i] += (dx[i] / disp) * step; y[i] += (dy[i] / disp) * step;
    }
    temp = Math.max(0.5, temp * 0.985);
  }
  return nodes.map((_, i) => ({ x: x[i], y: y[i] }));
}

// Connected components (node indices), largest first
export function components(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const { s, t } of edges) parent[find(s)] = find(t);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

// Layout per component: each one is laid out on its own (size ∝ √nodes) and then packed in
// rows, largest first. Keeps small components from flying off and shrinking the big one.
export function packedLayout(n, edges, { gap = 70, groupOf = null } = {}) {
  const comps = components(n, edges).filter(c => c.length > 1);
  const pos = new Map();
  const boxes = comps.map(c => {
    const local = new Map(c.map((g, k) => [g, k]));
    const ce = edges.filter(e => local.has(e.s)).map(e => ({ s: local.get(e.s), t: local.get(e.t) }));
    const groups = groupOf ? c.map(g => groupOf.get(g) ?? -1) : null;
    const lp = c.length === 2 ? [{ x: 0, y: 0 }, { x: 1, y: 0 }] : forceLayout(c.map(() => ({})), ce, { aspect: 0.75, groups });
    const xs = lp.map(p => p.x), ys = lp.map(p => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
    const size = c.length === 2 ? 70 : 92 * Math.sqrt(c.length); // target diameter
    const s = size / span;
    const pts = lp.map(p => ({ x: (p.x - minX) * s, y: (p.y - minY) * s }));
    return { c, pts, w: Math.max(...pts.map(p => p.x)), h: Math.max(...pts.map(p => p.y)) };
  });
  const maxW = Math.max(0, ...boxes.map(b => b.w));
  const limit = Math.max(maxW * 1.9, 700);
  let x = 0, y = 0, rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > limit) { x = 0; y += rowH + gap; rowH = 0; }
    b.c.forEach((g, k) => pos.set(g, { x: x + b.pts[k].x, y: y + b.pts[k].y }));
    x += b.w + gap; rowH = Math.max(rowH, b.h);
  }
  return { pos, width: limit, height: y + rowH };
}

// Groups: every connected component, with large ones (≥12 memories) split into communities by
// modularity. Computed per component so the result does not depend on which projects are shown.
export function communities(n, edges) {
  const out = [];
  for (const comp of components(n, edges)) {
    if (comp.length < 12) { out.push(comp); continue; } // small components are already topical
    const local = new Map(comp.map((g, k) => [g, k]));
    const ce = edges.filter(e => local.has(e.s)).map(e => ({ s: local.get(e.s), t: local.get(e.t) }));
    for (const c of louvain(comp.length, ce)) out.push(c.map(k => comp[k]));
  }
  return out.sort((a, b) => b.length - a.length);
}

// Louvain (local moving + aggregation), deterministic. Splits large groups held together by
// only one or two links.
function louvain(n, edges) {
  let adj = Array.from({ length: n }, () => new Map());
  for (const { s, t } of edges) {
    adj[s].set(t, (adj[s].get(t) || 0) + 1);
    adj[t].set(s, (adj[t].get(s) || 0) + 1);
  }
  let members = Array.from({ length: n }, (_, i) => [i]); // aggregated node → original nodes
  const m2 = edges.length * 2;
  if (!m2) return members;
  for (let level = 0; level < 10; level++) {
    const N = adj.length;
    // weighted degree; after aggregation the self-loop already counts each internal edge twice
    const k = adj.map(a => [...a.values()].reduce((x, y) => x + y, 0));
    const comm = Array.from({ length: N }, (_, i) => i);
    const tot = k.slice();
    let moved = true, any = false;
    for (let pass = 0; moved && pass < 50; pass++) {
      moved = false;
      for (let i = 0; i < N; i++) {
        const ci = comm[i];
        const links = new Map();
        for (const [j, w] of adj[i]) if (j !== i) links.set(comm[j], (links.get(comm[j]) || 0) + w);
        tot[ci] -= k[i];
        let best = ci, bestGain = (links.get(ci) || 0) - (tot[ci] * k[i]) / m2;
        for (const [c, w] of links) {
          const gain = w - (tot[c] * k[i]) / m2;
          if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) < 1e-12 && c < best && gain > 0)) { best = c; bestGain = gain; }
        }
        tot[best] += k[i];
        if (best !== ci) { comm[i] = best; moved = true; any = true; }
      }
    }
    if (!any) break;
    // aggregate: every community becomes a node
    const ids = [...new Set(comm)], idx = new Map(ids.map((c, i) => [c, i]));
    const nadj = ids.map(() => new Map()), nmem = ids.map(() => []);
    for (let i = 0; i < N; i++) {
      const a = idx.get(comm[i]);
      nmem[a].push(...members[i]);
      for (const [j, w] of adj[i]) { const b = idx.get(comm[j]); nadj[a].set(b, (nadj[a].get(b) || 0) + w); }
    }
    adj = nadj; members = nmem;
  }
  return members.sort((a, b) => b.length - a.length);
}

// Soft hull around a set of circles: convex hull of points sampled densely around each node.
// The sampling already rounds the corners, so straight segments are enough (and never overshoot).
export function hullPath(points, pad = 22) {
  const pts = [];
  for (const p of points) {
    const r = pad + (p.r || 0);
    for (let a = 0; a < 32; a++) pts.push([p.x + r * Math.cos((a / 32) * Math.PI * 2), p.y + r * Math.sin((a / 32) * Math.PI * 2)]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (h.length < 3) return '';
  return 'M' + h.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') + 'Z';
}

// Wheel zoom and background drag, by changing the SVG viewBox
export function installPanZoom(svg, view, onChange) {
  const apply = () => { svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); onChange?.(view); };
  const toSvg = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    return { x: view.x + ((cx - r.left) / r.width) * view.w, y: view.y + ((cy - r.top) / r.height) * view.h };
  };
  const zoomAt = (factor, cx, cy) => {
    const p = toSvg(cx, cy);
    const w = Math.min(view.full.w * 3, Math.max(view.full.w / 12, view.w * factor));
    const f = w / view.w;
    view.x = p.x - (p.x - view.x) * f; view.y = p.y - (p.y - view.y) * f;
    view.w *= f; view.h *= f;
    apply();
  };
  let anim = null;
  const animateTo = target => {
    cancelAnimationFrame(anim);
    const from = { x: view.x, y: view.y, w: view.w, h: view.h }, t0 = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = now => {
      const t = reduce ? 1 : Math.min(1, (now - t0) / 380), e = 1 - Math.pow(1 - t, 3);
      for (const k of ['x', 'y', 'w', 'h']) view[k] = from[k] + (target[k] - from[k]) * e;
      apply();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };
  svg.addEventListener('wheel', e => { e.preventDefault(); cancelAnimationFrame(anim); zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    view.moved = false;
    if (e.target.closest('.node')) return;
    cancelAnimationFrame(anim);
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) { view.moved = true; svg.classList.add('panning'); }
    const r = svg.getBoundingClientRect();
    view.x = drag.vx - ((e.clientX - drag.x) / r.width) * view.w;
    view.y = drag.vy - ((e.clientY - drag.y) / r.height) * view.h;
    apply();
  });
  const end = () => { drag = null; svg.classList.remove('panning'); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  return {
    zoom: factor => {
      const r = svg.getBoundingClientRect(), p = toSvg(r.left + r.width / 2, r.top + r.height / 2);
      const w = Math.min(view.full.w * 3, Math.max(view.full.w / 12, view.w * factor)), h = view.h * (w / view.w);
      animateTo({ x: p.x - w / 2, y: p.y - h / 2, w, h });
    },
    reset: () => animateTo(view.full),
    // fit a box (in layout units), keeping the SVG's aspect ratio
    fit: (box, pad = 60) => {
      const r = svg.getBoundingClientRect(), aspect = r.height / r.width;
      let w = Math.max(box.w + pad * 2, view.full.w / 6), h = w * aspect;
      if (box.h + pad * 2 > h) { h = box.h + pad * 2; w = h / aspect; }
      animateTo({ x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h });
    },
  };
}
