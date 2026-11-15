// Demo data: a fake ~/.claude with three projects, their memories and ~70 synthetic sessions,
// so the explorer can be tried (and screenshotted) without real data. Dates are relative to
// "now", so the activity calendar always looks alive. Fully deterministic otherwise.
//
//   node server.mjs --demo

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = '/Users/demo';
const enc = p => p.replace(/[/.]/g, '-'); // how Claude Code names project folders

const PROJECTS = {
  'acme-shop': { path: `${HOME}/Code/acme-shop`, worktrees: [`${HOME}/conductor/workspaces/acme-shop/lisbon`, `${HOME}/conductor/workspaces/acme-shop/osaka`, `${HOME}/conductor/workspaces/acme-shop/quito`, `${HOME}/.paseo/worktrees/k3x9/brave-otter`, `${HOME}/.paseo/worktrees/k3x9/calm-heron`], weight: 0.7 },
  fieldnotes: { path: `${HOME}/Code/fieldnotes`, worktrees: [], weight: 0.18 },
  'infra-scripts': { path: `${HOME}/Code/infra-scripts`, worktrees: [], weight: 0.08 },
  'old-prototype': { path: `${HOME}/Code/old-prototype`, worktrees: [], weight: 0.04 }, // sessions, but no memories
};

// [project, file, type, name/title, description, days ago created, days ago modified|null, read weight, body]
const MEMORIES = [
  ['acme-shop', 'test-env-gotchas', 'project', 'Running the test suite locally in a fresh worktree', 210, 12, 18,
    `Two recurring gotchas when running \`bin/rails test\` in a fresh worktree:\n\n1. **Fresh worktrees lack \`db/structure.sql\`** (it's gitignored). Run \`bin/rails db:schema:dump\` and then \`bin/rails db:test:prepare\`.\n2. **Parallel workers crash** on this Ruby build. Always run \`PARALLEL_WORKERS=1 bin/rails test ...\`.\n\n**Why:** without these, test runs silently hang and changes can't be verified.\n**How to apply:** in a new workspace run the two db commands once, then always prefix test runs. See [[feedback-tests-first]].`],
  ['acme-shop', 'staging-environments', 'reference', 'Staging and review apps: URLs and logins', 180, 30, 14,
    `- Staging: \`https://staging.acme-shop.test\` (deploys from \`main\`)\n- Review apps: \`https://pr-<number>.review.acme-shop.test\`\n- Test login: the \`qa@acme-shop.test\` user, password in the shared vault\n\nReview apps are destroyed when the PR closes. Related: [[deploy-pipeline]].`],
  ['acme-shop', 'deploy-pipeline', 'project', 'How deploys work (CI → staging → production)', 170, 20, 10,
    `Deploys run on GitHub Actions with Kamal. \`main\` goes to staging automatically; production needs a manual approval in the \`deploy\` workflow.\n\n**Why:** the user wants a human in the loop for production.\n**How to apply:** never trigger the production job yourself; prepare the release notes and stop. See [[staging-environments]] and [[db-migrations-safety]].`],
  ['acme-shop', 'feedback-tests-first', 'feedback', 'Run the focused test file before the full suite', 200, null, 9,
    `Run only the test file you touched first, then the full suite once at the end.\n\n**Why:** the full suite takes 9 minutes; the user prefers fast feedback loops.\n**How to apply:** \`PARALLEL_WORKERS=1 bin/rails test test/models/order_test.rb\` while iterating. Gotchas in [[test-env-gotchas]].`],
  ['acme-shop', 'checkout-redesign', 'project', 'Checkout v2 redesign: status and decisions', 64, 6, 8,
    `Checkout v2 (one-page checkout) is behind the \`checkout_v2\` flag, at 25% of traffic since last week.\n\n- Address autocomplete: done\n- Saved cards: blocked on [[payments-provider-migration]]\n- Copy follows [[feedback-copy-tone]]\n\nOpen bug: [[cart-race-condition]].`],
  ['acme-shop', 'payments-provider-migration', 'project', 'Moving from LegacyPay to Stripe', 58, 9, 6,
    `Migration plan in \`docs/payments-migration.md\`. Webhooks are dual-written to both providers until the cutover.\n\n**Why:** LegacyPay is being sunset by the vendor.\n**How to apply:** any change to \`PaymentIntent\` must keep both adapters green. Sandbox keys: [[payments-sandbox-keys]]. Unblocks [[checkout-redesign]].`],
  ['acme-shop', 'cart-race-condition', 'project', 'Duplicate cart lines under double-click', 41, 39, 4,
    `Double-clicking "Add to cart" creates two lines. Root cause: no unique index on \`(cart_id, variant_id)\`. Fix in progress: unique index plus \`upsert\` in \`CartItems::Add\`.\n\nRelated to [[checkout-redesign]]; the migration must follow [[db-migrations-safety]].`],
  ['acme-shop', 'payments-sandbox-keys', 'reference', 'Where the payment sandbox keys live', 57, null, 3,
    `Sandbox keys are in the team vault under "Payments / Sandbox". They are **never** in \`.env\` files committed or shared in chat.`],
  ['acme-shop', 'search-relevance-tuning', 'project', 'Search relevance tuning: boosts and results', 120, 45, 7,
    `Title boost 3×, category 1.5×, popularity as a function score. Click-through went from 18% to 24% (see [[metrics-dashboard]]).\n\nNext: [[search-typo-tolerance]]. Reindex procedure in [[search-reindex-job]].`],
  ['acme-shop', 'search-reindex-job', 'reference', 'Reindexing search without downtime', 125, null, 5,
    `Reindex into a new index, then swap the alias: \`bin/rake search:reindex\` creates \`products_v<timestamp>\` and flips \`products\` when done. Takes ~12 minutes on production data.`],
  ['acme-shop', 'search-typo-tolerance', 'project', 'Typo tolerance for product search', 33, 31, 2,
    `Fuzziness \`AUTO\` on titles only; brand names excluded because "Nikon" kept matching "Nike". Tracked against [[search-relevance-tuning]].`],
  ['acme-shop', 'metrics-dashboard', 'reference', 'Where the product metrics live', 150, null, 6,
    `Grafana board "Shop / Funnel" for conversion; "Search / Quality" for CTR and zero-result rate. Weekly numbers go in the Monday update.`],
  ['acme-shop', 'db-migrations-safety', 'feedback', 'Safe migrations: no long locks in production', 140, 70, 4,
    `Use \`strong_migrations\`. Add indexes with \`algorithm: :concurrently\`; backfills in batches, never inside the schema migration.\n\n**Why:** a locking migration took the shop down for 4 minutes in spring.\n**How to apply:** split schema and data changes into separate PRs. See [[deploy-pipeline]].`],
  ['acme-shop', 'image-cdn-cache', 'project', 'Product images: CDN cache and purges', 95, null, 2,
    `Images are served through the CDN with a 30-day TTL. After re-uploading a product image, purge by surrogate key \`product-<id>\`. Part of [[deploy-pipeline]] post-deploy steps.`],
  ['acme-shop', 'feedback-copy-tone', 'feedback', 'UI copy: plain and calm, no exclamation marks', 110, null, 3,
    `Write UI copy in plain words, short sentences, no exclamation marks, no "Oops!".\n\n**Why:** the user finds playful copy grating in a checkout.\n**How to apply:** applies to error messages too. Used in [[checkout-redesign]] and [[accessibility-audit]].`],
  ['acme-shop', 'feedback-small-prs', 'feedback', 'Keep PRs small; split refactors out', 160, null, 2,
    `Aim for PRs under ~400 changed lines. Pure refactors go in their own PR before the feature.\n\n**Why:** reviews are faster and safer.`],
  ['acme-shop', 'newsletter-signup-experiment', 'project', 'Newsletter signup A/B test', 26, 8, 2,
    `Variant B (inline signup after the first product view) is ahead: 3.1% vs 2.4%, not yet significant. Events tracked as in [[analytics-events]]; results on the [[metrics-dashboard]].`],
  ['acme-shop', 'accessibility-audit', 'project', 'Accessibility audit (WCAG 2.2 AA)', 48, 15, 1,
    `Audit found 23 issues; 9 blocking (focus traps in modals, missing labels in the filters). Plan in three waves. Copy follows [[feedback-copy-tone]].`],
  ['acme-shop', 'admin-bulk-actions', 'project', 'Bulk actions in the admin product list', 76, null, 0,
    `Bulk publish/unpublish and price changes for up to 500 products, as a background job. Follows [[db-migrations-safety]] for the new \`bulk_operations\` table.`],
  ['acme-shop', 'legacy-api-sunset', 'project', 'Legacy v1 API sunset (DONE)', 205, null, 0,
    `DONE: v1 endpoints return 410 since spring. Kept for the history of why \`/api/v1\` routes still exist (they only render the 410).`],
  ['acme-shop', 'vendor-sdk-spike', 'project', 'Spike: vendor reviews SDK (discarded)', 190, null, 0,
    `Spike on embedding the vendor's reviews widget. DISCARDED: it injected 400 KB of JS and broke the CSP. Reviews stay server-rendered.`],
  ['fieldnotes', 'user-svelte-runes', 'user', 'The user writes Svelte 5 with runes', 90, null, 4,
    `The user is fluent in Svelte 5 and prefers runes (\`$state\`, \`$derived\`) over stores. Explain trade-offs briefly; no need to introduce basics.`],
  ['fieldnotes', 'offline-sync-design', 'project', 'Offline sync design', 60, 18, 5,
    `Notes are stored in IndexedDB and synced with a last-write-wins merge per field. Conflicts are rare (single user, several devices). Quirks in [[indexeddb-quirks]].`],
  ['fieldnotes', 'indexeddb-quirks', 'reference', 'IndexedDB quirks in Safari', 55, null, 3,
    `Safari evicts IndexedDB after 7 days without a visit unless the app is installed. Request persistent storage on first sync. Used by [[offline-sync-design]].`],
  ['fieldnotes', 'release-checklist', 'reference', 'Release checklist', 85, 40, 2,
    `1. Bump version in \`package.json\`\n2. \`npm run build && npm run preview\`\n3. Tag and push; Cloudflare Pages deploys the tag`],
  ['fieldnotes', 'feedback-no-hard-wrap', 'feedback', 'No hard-wrapping in markdown', 70, null, 1,
    `One paragraph = one long line. Don't wrap at 80 columns.\n\n**Why:** wrapped lines make diffs noisy. Applies to the [[release-checklist]] too.`],
  ['infra-scripts', 'backup-rotation', 'project', 'Nightly backups and rotation', 130, 50, 2,
    `Nightly \`pg_dump\` to object storage, 14 daily + 8 weekly copies. Rotation relies on [[s3-lifecycle-rules]].`],
  ['infra-scripts', 's3-lifecycle-rules', 'reference', 'Object storage lifecycle rules', 128, null, 0,
    `Daily prefix expires after 14 days; weekly after 60. Rules are managed in \`terraform/storage.tf\`.`],
  ['infra-scripts', 'feedback-dry-run-first', 'feedback', 'Always dry-run infra scripts first', 100, null, 1,
    `Run every script with \`--dry-run\` and show the plan before applying.\n\n**Why:** a cleanup script once deleted the wrong prefix. See [[backup-rotation]] and the [[restore-drill]].`],
];

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeDemo(dir = path.join(os.tmpdir(), 'claude-memory-explorer-demo')) {
  const rand = rng(7);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(rand() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); });
  const now = new Date(); now.setMinutes(0, 0, 0);
  const daysAgo = (d, hour = 10 + Math.floor(rand() * 8), min = Math.floor(rand() * 60)) => { const t = new Date(now); t.setDate(t.getDate() - d); t.setHours(hour, min, 0, 0); return t; };

  fs.rmSync(dir, { recursive: true, force: true });
  const projectsDir = path.join(dir, 'projects');
  const memDir = p => path.join(projectsDir, enc(PROJECTS[p].path), 'memory');
  for (const p of Object.keys(PROJECTS)) fs.mkdirSync(memDir(p), { recursive: true });
  // real paths for the demo projects (they do not exist on this disk)
  fs.writeFileSync(path.join(dir, 'paths.json'), JSON.stringify(Object.fromEntries(Object.values(PROJECTS).map(p => [enc(p.path), p.path.replace(HOME, '~')])), null, 2));

  // sessions: ~70 over the last 10 weeks, mostly on weekdays
  const sessions = [];
  const projectNames = Object.keys(PROJECTS);
  const choose = () => { let r = rand(), acc = 0; for (const p of projectNames) { acc += PROJECTS[p].weight; if (r < acc) return p; } return projectNames[0]; };
  for (let d = 70; d >= 0; d--) {
    const day = daysAgo(d, 12);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const n = weekend ? (rand() < 0.25 ? 1 : 0) : Math.floor(rand() * 2.2);
    for (let k = 0; k < n; k++) sessions.push({ project: choose(), start: daysAgo(d), events: [] });
  }

  // memories: files, created/modified dates, and the session that wrote them (when within the window)
  const memories = MEMORIES.map(([project, file, type, name, created, modified, weight, body]) => ({ project, file: file + '.md', type, name: file, title: name, description: name, created: daysAgo(created), modified: modified == null ? null : daysAgo(modified), weight, body }));
  for (const m of memories) {
    m.session = uuid();
    for (const [when, kind] of [[m.created, 'create'], [m.modified, 'edit']]) {
      if (!when || (now - when) / 86400000 > 70) continue;
      const s = { project: m.project, start: new Date(when.getTime() - 20 * 60000), events: [] };
      s.events.push({ ts: when, tool: 'Write', file: m.file });
      if (kind === 'create') m.session = s.sid = uuid();
      sessions.push(s);
    }
  }

  // reads, weighted by popularity, only of memories that already existed
  for (const s of sessions) {
    const pool = memories.filter(m => m.project === s.project && m.created < s.start && m.weight > 0);
    const reads = rand() < 0.45 ? 0 : 1 + Math.floor(rand() * 3);
    for (let i = 0; i < reads && pool.length; i++) {
      const total = pool.reduce((a, m) => a + m.weight, 0);
      let r = rand() * total, m = pool[0];
      for (const c of pool) { r -= c.weight; if (r <= 0) { m = c; break; } }
      s.events.push({ ts: new Date(s.start.getTime() + (5 + Math.floor(rand() * 90)) * 60000), tool: rand() < 0.75 ? 'Bash' : 'Read', file: m.file });
    }
  }

  // write memory files and MEMORY.md indexes
  for (const p of projectNames) {
    const mine = memories.filter(m => m.project === p);
    if (!mine.length) continue;
    fs.writeFileSync(path.join(memDir(p), 'MEMORY.md'), mine.map(m => `- [${m.title}](${m.file}) — ${m.body.split('\n')[0].replace(/[*`[\]]/g, '').slice(0, 110)}`).join('\n') + '\n');
    for (const m of mine) {
      const mod = (m.modified || m.created).toISOString();
      const text = `---\nname: ${m.name}\ndescription: ${m.description}\nmetadata:\n  node_type: memory\n  type: ${m.type}\n  originSessionId: ${m.session}\n  modified: ${mod}\n---\n\n${m.body}\n`;
      const f = path.join(memDir(p), m.file);
      fs.writeFileSync(f, text);
      fs.utimesSync(f, m.created, m.created); // on macOS this also moves the birth time back
      if (m.modified) fs.utimesSync(f, m.modified, m.modified);
    }
  }

  // transcripts: one .jsonl per session, in the folder of the directory it ran in
  for (const s of sessions) {
    const P = PROJECTS[s.project];
    const cwd = P.worktrees.length && rand() < 0.65 ? pick(P.worktrees) : P.path;
    const sid = s.sid || uuid();
    const mdir = `${HOME}/.claude/projects/${enc(P.path)}/memory`;
    const index = path.join(memDir(s.project), 'MEMORY.md');
    const end = new Date(Math.max(s.start.getTime() + 40 * 60000, ...s.events.map(e => e.ts.getTime() + 5 * 60000)));
    const lines = [
      { type: 'user', timestamp: s.start.toISOString(), cwd, sessionId: sid, message: { role: 'user', content: 'Demo session' } },
      { type: 'attachment', timestamp: s.start.toISOString(), attachment: { type: 'prompt_snapshot', systemPrompt: [`You have a persistent file-based memory at \`${mdir}/\`.`] } },
    ];
    if (fs.existsSync(index)) lines.push({ type: 'attachment', timestamp: s.start.toISOString(), attachment: { type: 'instructions', files: [{ path: `${mdir}/MEMORY.md`, type: 'AutoMem', content: fs.readFileSync(index, 'utf8') }] } });
    for (const e of s.events.sort((a, b) => a.ts - b.ts)) {
      const fp = `${mdir}/${e.file}`;
      const input = e.tool === 'Bash' ? { command: `cat ${fp}` } : { file_path: fp };
      lines.push({ type: 'assistant', timestamp: e.ts.toISOString(), message: { content: [{ type: 'tool_use', name: e.tool, input }] } });
    }
    lines.push({ type: 'assistant', timestamp: end.toISOString(), message: { content: [{ type: 'text', text: 'Done.' }] } });
    const tdir = path.join(projectsDir, enc(cwd));
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, `${sid}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  }
  return dir;
}
