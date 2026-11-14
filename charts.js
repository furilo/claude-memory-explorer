// Minimal SVG charts, no dependencies.
// Each chart returns HTML: title, legend (when there are ≥2 series), the SVG and a "Show data" table.
// Thin marks, 4px rounded data ends anchored to the baseline, 2px gaps between segments,
// a quiet grid and a per-mark tooltip (data-tip attribute).

const W = 640;
const escT = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });

function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function scaleMax(max, n = 4) {
  const step = Math.max(niceStep(max / n), Number.isInteger(max) ? 1 : 0);
  return { max: Math.max(step, Math.ceil(max / step) * step), step };
}

// Bar with both corners of the data end rounded
function barPath(x, y, w, h, r, dir) {
  if (w <= 0 || h <= 0) return '';
  if (dir === 'up') {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function legend(series, kind = 'fill') {
  if (series.length < 2) return '';
  const swatch = s => kind === 'line'
    ? `<i class="line" style="border-top:2px ${s.dash === 'dot' ? 'dotted' : s.dash ? 'dashed' : 'solid'} ${s.color}"></i>`
    : `<i style="background:${s.color}"></i>`;
  return `<div class="legend">${series.map(s => `<span>${swatch(s)}${escT(s.label)}</span>`).join('')}</div>`;
}

function table(head, rows) {
  return `<details class="datatable"><summary>Show data</summary><table>
    <tr>${head.map(h => `<th>${escT(h)}</th>`).join('')}</tr>
    ${rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${escT(c)}</td>`).join('')}</tr>`).join('')}
  </table></details>`;
}

function figure(title, note, body) {
  return `<figure class="chart"><figcaption><h3>${escT(title)}</h3>${note ? `<p>${note}</p>` : ''}</figcaption>${body}</figure>`;
}

// Stacked columns.  rows: [{ x, v: { key: n } }]   series: [{ key, label, color }]
export function columns({ title, note, rows, series, height = 190, xLabel = r => r.x, empty = 'No data' }) {
  if (!rows.length) return figure(title, note, `<div class="chart-empty">${empty}</div>`);
  const m = { l: 34, r: 8, t: 10, b: 26 }, pw = W - m.l - m.r, ph = height - m.t - m.b;
  const totals = rows.map(r => series.reduce((a, s) => a + (r.v[s.key] || 0), 0));
  const { max, step } = scaleMax(Math.max(1, ...totals));
  const y = v => m.t + ph - (v / max) * ph;
  const bw = pw / rows.length, barW = Math.max(3, Math.min(26, bw * 0.68));
  const every = Math.ceil(rows.length / 9);
  let svg = '';
  for (let t = 0; t <= max + 1e-9; t += step) {
    svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtN(t)}</text>`;
  }
  rows.forEach((r, i) => {
    const x = m.l + i * bw + (bw - barW) / 2;
    let base = m.t + ph;
    const segs = series.filter(s => r.v[s.key] > 0);
    segs.forEach((s, j) => {
      const h = (r.v[s.key] / max) * ph, top = j === segs.length - 1;
      const hh = top ? h : Math.max(0.5, h - 2);
      svg += top ? `<path d="${barPath(x, base - h, barW, hh, 4, 'up')}" fill="${s.color}"/>`
                 : `<rect x="${x}" y="${base - h + 2}" width="${barW}" height="${hh}" fill="${s.color}"/>`;
      base -= h;
    });
    const tip = [xLabel(r), ...series.map(s => `${series.length > 1 ? s.label + ': ' : ''}${fmtN(r.v[s.key] || 0)}`), series.length > 1 ? `Total: ${fmtN(totals[i])}` : null].filter(Boolean).join('\n');
    svg += `<rect class="hit" x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${ph}" data-tip="${escT(tip)}"/>`;
    if (i % every === 0) svg += `<text class="axis" x="${x + barW / 2}" y="${height - 8}" text-anchor="middle">${escT(xLabel(r, true))}</text>`;
  });
  svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;
  return figure(title, note, legend(series) +
    `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${escT(title)}">${svg}</svg>` +
    table(['', ...series.map(s => s.label), ...(series.length > 1 ? ['Total'] : [])],
      rows.map((r, i) => [xLabel(r), ...series.map(s => fmtN(r.v[s.key] || 0)), ...(series.length > 1 ? [fmtN(totals[i])] : [])])));
}

// Stacked horizontal bars.  rows: [{ label, v: { key: n }, href?, value? }]
export function bars({ title, note, rows, series, labelW = 190, rowH = 24, valueText, empty = 'No data', max: fixedMax, showLegend = true }) {
  if (!rows.length) return figure(title, note, `<div class="chart-empty">${empty}</div>`);
  const m = { r: 64 }, pw = W - labelW - m.r, height = rows.length * rowH + 4;
  const totals = rows.map(r => series.reduce((a, s) => a + (r.v[s.key] || 0), 0));
  const max = fixedMax || Math.max(1, ...totals);
  const maxChars = Math.floor(labelW / 6.6);
  let svg = '';
  rows.forEach((r, i) => {
    const yy = i * rowH + 4, bh = Math.min(14, rowH - 8), by = yy + (rowH - bh) / 2 - 2;
    const label = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + '…' : r.label;
    const text = `<text class="label" x="${labelW - 10}" y="${by + bh - 3}" text-anchor="end">${escT(label)}</text>`;
    svg += r.href ? `<a href="${escT(r.href)}">${text}</a>` : text;
    let x = labelW;
    const segs = series.filter(s => r.v[s.key] > 0);
    segs.forEach((s, j) => {
      const w = (r.v[s.key] / max) * pw, last = j === segs.length - 1;
      const ww = last ? w : Math.max(0.5, w - 2);
      svg += last ? `<path d="${barPath(x, by, ww, bh, 4, 'right')}" fill="${s.color}"/>`
                  : `<rect x="${x}" y="${by}" width="${ww}" height="${bh}" fill="${s.color}"/>`;
      x += w;
    });
    svg += `<text class="value" x="${x + 6}" y="${by + bh - 3}">${escT(valueText ? valueText(r, totals[i]) : fmtN(totals[i]))}</text>`;
    const tip = [r.label, ...series.filter(s => r.v[s.key]).map(s => `${series.length > 1 ? s.label + ': ' : ''}${fmtN(r.v[s.key])}`), r.tip].filter(Boolean).join('\n');
    const hit = `<rect class="hit" x="0" y="${yy - 2}" width="${W}" height="${rowH}" data-tip="${escT(tip)}"/>`;
    svg += r.href ? `<a href="${escT(r.href)}">${hit}</a>` : hit;
  });
  svg += `<line class="baseline" x1="${labelW}" x2="${labelW}" y1="0" y2="${height}"/>`;
  return figure(title, note, (showLegend ? legend(series) : '') +
    `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${escT(title)}">${svg}</svg>` +
    table(['', ...series.map(s => s.label), ...(series.length > 1 ? ['Total'] : [])],
      rows.map((r, i) => [r.label, ...series.map(s => fmtN(r.v[s.key] || 0)), ...(series.length > 1 ? [fmtN(totals[i])] : [])])));
}

// Lines over time.  series: [{ label, color, dash?, points: [[ 'YYYY-MM-DD', value ]] }]
export function lines({ title, note, series, height = 200, fmtY = fmtN, ref, empty = 'No data' }) {
  series = series.filter(s => s.points.length);
  if (!series.length) return figure(title, note, `<div class="chart-empty">${empty}</div>`);
  const m = { l: 44, r: 140, t: 12, b: 26 }, pw = W - m.l - m.r, ph = height - m.t - m.b;
  const t = d => new Date(d + 'T00:00:00Z').getTime();
  const all = series.flatMap(s => s.points);
  const t0 = Math.min(...all.map(p => t(p[0]))), t1 = Math.max(...all.map(p => t(p[0])), t0 + 86400000);
  const { max, step } = scaleMax(Math.max(ref?.value || 0, ...all.map(p => p[1])) * 1.05);
  const x = d => m.l + ((t(d) - t0) / (t1 - t0)) * pw, y = v => m.t + ph - (v / max) * ph;
  let svg = '';
  for (let v = 0; v <= max + 1e-9; v += step) {
    svg += `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${escT(fmtY(v))}</text>`;
  }
  // month ticks on the X axis
  const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    svg += `<line class="tick" x1="${x(iso)}" x2="${x(iso)}" y1="${m.t + ph}" y2="${m.t + ph + 4}"/><text class="axis" x="${x(iso)}" y="${height - 8}" text-anchor="middle">${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</text>`;
  }
  if (ref) {
    svg += `<line class="ref" x1="${m.l}" x2="${m.l + pw}" y1="${y(ref.value)}" y2="${y(ref.value)}"/><text class="axis" x="${m.l + pw + 6}" y="${y(ref.value) + 4}">${escT(ref.label)}</text>`;
  }
  const dashes = { dash: '6 4', dot: '1.5 4' };
  for (const s of series) {
    const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    svg += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? `stroke-dasharray="${dashes[s.dash]}"` : ''}/>`;
    const lp = s.points[s.points.length - 1];
    svg += `<circle cx="${x(lp[0])}" cy="${y(lp[1])}" r="4" fill="${s.color}" class="ringed"/>`;
    if (series.length <= 4) svg += `<text class="label" x="${x(lp[0]) + 8}" y="${y(lp[1]) + 4}">${escT(s.label.length > 20 ? s.label.slice(0, 19) + '…' : s.label)}</text>`;
    for (const p of s.points) {
      svg += `<circle class="hit" cx="${x(p[0])}" cy="${y(p[1])}" r="9" data-tip="${escT(`${s.label}\n${new Date(t(p[0])).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}: ${fmtY(p[1])}`)}"/>`;
    }
  }
  svg += `<line class="baseline" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;
  const rows = series.flatMap(s => s.points.map(p => [s.label, p[0], fmtY(p[1])]));
  return figure(title, note, legend(series, 'line') +
    `<svg viewBox="0 0 ${W} ${height}" role="img" aria-label="${escT(title)}">${svg}</svg>` +
    table(['Series', 'Date', 'Value'], rows));
}

// Shared tooltip: any element with data-tip
export function installTooltip() {
  const tip = document.createElement('div');
  tip.id = 'tip';
  document.body.appendChild(tip);
  let current = null;
  document.addEventListener('mouseover', e => {
    const el = e.target.closest?.('[data-tip]');
    if (current) current.classList.remove('hover');
    current = el;
    if (!el) { tip.style.display = 'none'; return; }
    el.classList.add('hover');
    const [head, ...rest] = el.dataset.tip.split('\n');
    tip.innerHTML = `<strong>${escT(head)}</strong>${rest.map(l => `<div>${escT(l)}</div>`).join('')}`;
    tip.style.display = 'block';
  });
  document.addEventListener('mousemove', e => {
    if (tip.style.display !== 'block') return;
    const r = tip.getBoundingClientRect();
    const left = e.clientX + 14 + r.width > innerWidth ? e.clientX - r.width - 14 : e.clientX + 14;
    const top = e.clientY + 14 + r.height > innerHeight ? e.clientY - r.height - 14 : e.clientY + 14;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  });
}
