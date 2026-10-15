const WIDTHS = Array.from({ length: 21 }, (_, i) => `.w-${i * 5} { width: ${i * 5}%; }`).join("\n");

export const BASE_CSS = String.raw`
*, *::before, *::after { box-sizing: border-box; }
:root {
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px;
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-lg: calc(var(--radius) * 1.6);
  --focus: 0 0 0 3px color-mix(in srgb, var(--primary) 45%, transparent);
  --shadow: 0 1px 2px rgb(0 0 0 / 0.25), 0 8px 24px rgb(0 0 0 / 0.18);
  --tint-primary: color-mix(in srgb, var(--primary) 14%, transparent);
  --tint-accent: color-mix(in srgb, var(--accent) 14%, transparent);
  --tint-success: color-mix(in srgb, var(--success) 14%, transparent);
  --tint-warning: color-mix(in srgb, var(--warning) 14%, transparent);
  --tint-danger: color-mix(in srgb, var(--danger) 14%, transparent);
  --tint-info: color-mix(in srgb, var(--info) 14%, transparent);
  --tint-highlight: color-mix(in srgb, var(--highlight) 14%, transparent);
  --hover: color-mix(in srgb, var(--text) 6%, transparent);
}
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); font-family: var(--font); font-size: 15px; line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { font-family: var(--font-heading); line-height: 1.25; margin: 0 0 var(--space-3); font-weight: 650; letter-spacing: -0.01em; }
h1 { font-size: 1.75rem; } h2 { font-size: 1.3rem; } h3 { font-size: 1.08rem; } h4 { font-size: 0.95rem; }
p { margin: 0 0 var(--space-3); }
a { color: var(--primary); text-decoration: none; text-underline-offset: 3px; }
a:hover { text-decoration: underline; }
small, .muted { color: var(--text-muted); }
code, kbd, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
code { background: var(--surface-raised); padding: 1px 6px; border-radius: var(--radius-sm); }
hr { border: 0; border-top: 1px solid var(--border); margin: var(--space-5) 0; }
:focus-visible { outline: none; box-shadow: var(--focus); border-radius: var(--radius-sm); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: -9999px; top: 8px; z-index: 10; background: var(--primary); color: var(--primary-text); padding: 8px 12px; border-radius: var(--radius); }
.skip:focus { left: 8px; }

.topbar { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.topbar-inner { max-width: 1160px; margin: 0 auto; padding: 0 var(--space-5); height: 60px; display: flex; align-items: center; gap: var(--space-5); }
.brand { display: flex; align-items: center; gap: var(--space-3); color: var(--text); font-weight: 650; white-space: nowrap; }
.brand:hover { text-decoration: none; }
.brand img { height: 30px; width: auto; display: block; }
.nav { display: flex; gap: var(--space-1); flex: 1; overflow-x: auto; scrollbar-width: none; }
.nav a { color: var(--text-muted); padding: 6px 12px; border-radius: var(--radius); font-weight: 500; white-space: nowrap; }
.nav a:hover { color: var(--text); background: var(--hover); text-decoration: none; }
.nav a[aria-current="page"] { color: var(--text); background: var(--surface-raised); }
.menu { position: relative; }
.menu > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--space-2); padding: 4px 8px 4px 4px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-raised); }
.menu > summary::-webkit-details-marker { display: none; }
.menu[open] > summary { box-shadow: var(--focus); }
.menu-panel { position: absolute; right: 0; top: calc(100% + 8px); min-width: 220px; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: var(--space-2); display: grid; gap: 2px; }
.menu-panel a, .menu-panel button { display: block; width: 100%; text-align: left; color: var(--text); padding: 8px 10px; border-radius: var(--radius-sm); background: none; border: 0; font: inherit; cursor: pointer; }
.menu-panel a:hover, .menu-panel button:hover { background: var(--hover); text-decoration: none; }
.menu-panel .menu-head { padding: 8px 10px; color: var(--text-muted); font-size: 0.85rem; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.avatar { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 0.85rem; color: var(--primary-text); background: linear-gradient(135deg, var(--primary), var(--accent)); }
main { flex: 1; width: 100%; max-width: 1160px; margin: 0 auto; padding: var(--space-6) var(--space-5) var(--space-7); }
.footer { border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.85rem; }
.footer-inner { max-width: 1160px; margin: 0 auto; padding: var(--space-5); display: flex; flex-wrap: wrap; gap: var(--space-4); justify-content: space-between; }
.footer a { color: var(--text-muted); }
.footer nav { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.banner { background: var(--tint-warning); border-bottom: 1px solid color-mix(in srgb, var(--warning) 40%, transparent); color: var(--text); }
.banner-inner { max-width: 1160px; margin: 0 auto; padding: 10px var(--space-5); display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }

.auth-wrap { flex: 1; display: grid; place-items: center; padding: var(--space-7) var(--space-4); position: relative; overflow: hidden; }
.auth-wrap::before, .auth-wrap::after { content: ""; position: absolute; width: 520px; height: 520px; border-radius: 50%; filter: blur(90px); opacity: 0.22; pointer-events: none; }
.auth-wrap::before { background: var(--accent); top: -180px; left: -160px; }
.auth-wrap::after { background: var(--primary); bottom: -200px; right: -160px; }
.auth-card { position: relative; z-index: 1; width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-6); box-shadow: var(--shadow); }
.auth-card.wide { max-width: 560px; }
.auth-logo { display: flex; justify-content: center; margin-bottom: var(--space-5); }
.auth-logo img { height: 44px; }
.auth-card h1 { text-align: center; font-size: 1.45rem; }
.auth-card .lede { text-align: center; color: var(--text-muted); margin-bottom: var(--space-5); }
.divider { display: flex; align-items: center; gap: var(--space-3); color: var(--text-muted); font-size: 0.85rem; margin: var(--space-4) 0; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
.auth-foot { text-align: center; margin-top: var(--space-5); color: var(--text-muted); font-size: 0.9rem; }

.stack { display: grid; gap: var(--space-4); }
.stack-sm { display: grid; gap: var(--space-2); }
.stack-lg { display: grid; gap: var(--space-6); }
.row { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.row.end { justify-content: flex-end; }
.row.between { justify-content: space-between; }
.grow { flex: 1; }
.grid-2 { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
.grid-3 { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); align-items: start; }
.row:has(> .field), .row:has(> .grow > .field) { align-items: flex-end; }
.row > .field { flex: 1; min-width: 150px; }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-5); }
.page-head h1 { margin: 0; }
.page-head p { margin: 4px 0 0; color: var(--text-muted); }
.crumbs { font-size: 0.85rem; color: var(--text-muted); margin-bottom: var(--space-2); }
.crumbs a { color: var(--text-muted); }
.with-sidebar { display: grid; gap: var(--space-6); grid-template-columns: 220px minmax(0, 1fr); align-items: start; }
.sidebar { position: sticky; top: 84px; display: grid; gap: 2px; }
.sidebar a { color: var(--text-muted); padding: 8px 12px; border-radius: var(--radius); font-weight: 500; }
.sidebar a:hover { background: var(--hover); color: var(--text); text-decoration: none; }
.sidebar a[aria-current="page"] { background: var(--surface-raised); color: var(--text); box-shadow: inset 3px 0 0 var(--primary); }
.sidebar .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); padding: 12px 12px 4px; }
@media (max-width: 820px) {
  .with-sidebar { grid-template-columns: 1fr; }
  .sidebar { position: static; display: flex; overflow-x: auto; }
  .sidebar .label { display: none; }
  .topbar-inner { gap: var(--space-3); padding: 0 var(--space-3); }
  .brand span { display: none; }
  main { padding: var(--space-5) var(--space-3) var(--space-6); }
}

.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-5); }
.card > h2:first-child, .card > h3:first-child { margin-top: 0; }
.card > * + * { margin-top: var(--space-4); }
.card > .card-head + * { margin-top: 0; }
.card:not(.flush) .list > * { padding-left: 0; padding-right: 0; }
.card:not(.flush) .list > *:first-child { padding-top: 0; }
.card:not(.flush) .list > *:last-child { padding-bottom: 0; }
.card-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); }
.card-head h2, .card-head h3 { margin: 0; }
.card.flush { padding: 0; overflow: hidden; }
.card.danger { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4) var(--space-5); }
.tile .value { font-size: 1.7rem; font-weight: 700; font-family: var(--font-heading); }
.tile .label { color: var(--text-muted); font-size: 0.85rem; }
.tile.accent { background: linear-gradient(140deg, var(--tint-primary), var(--tint-accent)); }
.link-card { display: block; color: var(--text); transition: border-color 0.15s, transform 0.15s; }
.link-card:hover { text-decoration: none; border-color: var(--primary); transform: translateY(-1px); }
.list { display: grid; }
.list > * { padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.list > *:first-child { border-top: 0; }
.item { display: flex; gap: var(--space-4); align-items: center; justify-content: space-between; flex-wrap: wrap; }
.item .meta { color: var(--text-muted); font-size: 0.88rem; }

form { margin: 0; }
.field { display: grid; gap: 6px; }
.field > label, .label-text { font-weight: 550; font-size: 0.92rem; }
.hint { color: var(--text-muted); font-size: 0.85rem; }
.field-error { color: var(--danger); font-size: 0.85rem; }
input[type=text], input[type=email], input[type=password], input[type=date], input[type=number], input[type=search], input[type=url], input[type=datetime-local], select, textarea {
  width: 100%; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px 12px; min-height: 42px; transition: border-color 0.15s, box-shadow 0.15s;
}
textarea { min-height: 120px; resize: vertical; line-height: 1.5; }
input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--text-muted) 60%, var(--border)); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary); box-shadow: var(--focus); }
input[aria-invalid=true], select[aria-invalid=true], textarea[aria-invalid=true] { border-color: var(--danger); }
input::placeholder, textarea::placeholder { color: color-mix(in srgb, var(--text-muted) 75%, transparent); }
.code-input { font-family: ui-monospace, monospace; font-size: 1.4rem; letter-spacing: 0.35em; text-align: center; }
.check { display: flex; gap: var(--space-3); align-items: flex-start; cursor: pointer; }
.check input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--primary); flex: none; }
.check .hint { display: block; }
fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); margin: 0; }
legend { padding: 0 6px; font-weight: 600; }
.toggle-row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-4); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); font: inherit; font-weight: 600; cursor: pointer;
  min-height: 42px; padding: 0 18px; border-radius: var(--radius); border: 1px solid transparent; background: var(--primary); color: var(--primary-text);
  transition: filter 0.15s, background 0.15s, border-color 0.15s; text-decoration: none; white-space: nowrap; }
.btn:hover { filter: brightness(1.08); text-decoration: none; }
.btn:active { filter: brightness(0.95); }
.btn[disabled], .btn[aria-disabled=true] { opacity: 0.55; cursor: not-allowed; filter: none; }
.btn.block { width: 100%; }
.btn.secondary { background: var(--surface-raised); color: var(--text); border-color: var(--border); }
.btn.secondary:hover { border-color: color-mix(in srgb, var(--text-muted) 60%, var(--border)); filter: none; }
.btn.ghost { background: transparent; color: var(--text); }
.btn.ghost:hover { background: var(--hover); filter: none; }
.btn.danger { background: var(--danger); color: var(--bg); }
.btn.danger-ghost { background: transparent; color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.btn.danger-ghost:hover { background: var(--tint-danger); filter: none; }
.btn.sm { min-height: 32px; padding: 0 12px; font-size: 0.88rem; }
.btn-provider { justify-content: flex-start; gap: var(--space-3); }
.btn-provider .dot { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; font-size: 0.7rem; font-weight: 800; color: var(--bg); background: var(--text-muted); }
.inline-form { display: inline; }
.link-button { background: none; border: 0; padding: 0; font: inherit; color: var(--primary); cursor: pointer; }
.link-button:hover { text-decoration: underline; }

.alert { border-radius: var(--radius); padding: var(--space-3) var(--space-4); border: 1px solid; display: grid; gap: 4px; }
.alert strong { font-weight: 650; }
.alert.info { background: var(--tint-info); border-color: color-mix(in srgb, var(--info) 40%, transparent); }
.alert.success { background: var(--tint-success); border-color: color-mix(in srgb, var(--success) 40%, transparent); }
.alert.warning { background: var(--tint-warning); border-color: color-mix(in srgb, var(--warning) 40%, transparent); }
.alert.danger { background: var(--tint-danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.alert ul { margin: 4px 0 0; padding-left: 18px; }
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; white-space: nowrap; border: 1px solid transparent; }
.badge.neutral { background: var(--surface-raised); color: var(--text-muted); border-color: var(--border); }
.badge.blue { background: var(--tint-info); color: var(--blue); }
.badge.green { background: var(--tint-success); color: var(--green); }
.badge.yellow { background: var(--tint-warning); color: var(--yellow); }
.badge.red { background: var(--tint-danger); color: var(--red); }
.badge.purple { background: var(--tint-accent); color: var(--purple); }
.badge.orange { background: var(--tint-highlight); color: var(--orange); }

.table-wrap { overflow-x: auto; }
table.table { width: 100%; border-collapse: collapse; font-size: 0.93rem; }
.table th { text-align: left; font-weight: 600; color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.table td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
.table tbody tr:hover { background: var(--hover); }
.table tbody tr:last-child td { border-bottom: 0; }
.table .num { text-align: right; font-variant-numeric: tabular-nums; }
.table a.row-link { color: var(--text); font-weight: 550; }

.empty { text-align: center; padding: var(--space-7) var(--space-5); color: var(--text-muted); }
.empty h3 { color: var(--text); }
.progress { height: 8px; background: var(--surface-raised); border-radius: 999px; overflow: hidden; }
.progress > span { display: block; height: 100%; background: linear-gradient(90deg, var(--primary), var(--accent)); border-radius: 999px; }
.codes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); background: var(--bg); border: 1px dashed var(--border); border-radius: var(--radius); padding: var(--space-4); }
.codes code { background: none; text-align: center; font-size: 1rem; letter-spacing: 0.08em; }
.qr { background: #fff; padding: 12px; border-radius: var(--radius); width: fit-content; }
.qr svg { display: block; width: 180px; height: 180px; }
.secret { word-break: break-all; }
.tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--border); margin-bottom: var(--space-5); overflow-x: auto; }
.tabs a { padding: 10px 14px; color: var(--text-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; font-weight: 500; }
.tabs a:hover { color: var(--text); text-decoration: none; }
.tabs a[aria-current="page"] { color: var(--text); border-bottom-color: var(--primary); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 8px 20px; margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; word-break: break-word; }
.kv.stacked { grid-template-columns: 1fr; gap: 4px; }
.kv.stacked dd { margin-bottom: 12px; }
pre.wrap { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 0.875em; }
.prose { line-height: 1.7; max-width: 72ch; }
.prose h1, .prose h2, .prose h3 { margin-top: var(--space-5); }
.prose img { max-width: 100%; border-radius: var(--radius); }
.prose pre { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-4); overflow-x: auto; }
.prose blockquote { margin: 0; padding-left: var(--space-4); border-left: 3px solid var(--accent); color: var(--text-muted); }
.prose table { border-collapse: collapse; } .prose td, .prose th { border: 1px solid var(--border); padding: 6px 10px; }
.thread { display: grid; gap: var(--space-4); }
.msg { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4) var(--space-5); background: var(--surface); }
.msg.staff { border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); background: linear-gradient(0deg, var(--surface), var(--surface)), var(--tint-primary); }
.msg.internal { border-style: dashed; border-color: color-mix(in srgb, var(--warning) 50%, var(--border)); background: var(--tint-warning); }
.msg.system { border: 0; background: none; padding: 0; color: var(--text-muted); font-size: 0.9rem; text-align: center; }
.msg-head { display: flex; justify-content: space-between; gap: var(--space-3); font-size: 0.85rem; color: var(--text-muted); margin-bottom: var(--space-2); }
.msg-body { white-space: pre-wrap; word-break: break-word; }
.diff { font-family: ui-monospace, monospace; font-size: 0.85rem; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; }
.diff div { padding: 1px 12px; white-space: pre-wrap; }
.diff .add { background: var(--tint-success); }
.diff .del { background: var(--tint-danger); }
.json { padding: 12px; white-space: pre-wrap; }
.game-hero { border-radius: var(--radius-lg); padding: var(--space-6); background: linear-gradient(135deg, var(--tint-accent), var(--tint-primary)); border: 1px solid var(--border); display: flex; gap: var(--space-5); align-items: center; }
.game-icon { width: 72px; height: 72px; border-radius: var(--radius); object-fit: cover; background: var(--surface-raised); display: grid; place-items: center; font-weight: 800; font-size: 1.5rem; color: var(--primary); flex: none; }
.ach { display: flex; gap: var(--space-4); align-items: center; }
.ach .icon { width: 48px; height: 48px; border-radius: var(--radius); background: var(--surface-raised); display: grid; place-items: center; flex: none; font-size: 1.2rem; }
.ach.locked { opacity: 0.6; }
.ach.locked .icon { filter: grayscale(1); }
.rank { font-variant-numeric: tabular-nums; font-weight: 700; width: 2.5em; color: var(--text-muted); }
.rank.top { color: var(--yellow); }
.me-row { background: var(--tint-primary); }
.search-box { display: flex; gap: var(--space-2); }
.search-box input { flex: 1; }
.hero { text-align: center; padding: var(--space-7) var(--space-4) var(--space-6); border-radius: var(--radius-lg); background: radial-gradient(ellipse at top, var(--tint-accent), transparent 70%), radial-gradient(ellipse at bottom right, var(--tint-primary), transparent 60%); margin-bottom: var(--space-6); }
.hero h1 { font-size: 2rem; }
.hero .search-box { max-width: 560px; margin: var(--space-5) auto 0; }
.status-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--text-muted); }
.status-dot.ok { background: var(--success); } .status-dot.warn { background: var(--warning); } .status-dot.bad { background: var(--danger); }
.captcha { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3) var(--space-4); display: flex; align-items: center; gap: var(--space-3); background: var(--bg); }
.captcha .spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--primary); animation: spin 0.8s linear infinite; }
.captcha[data-state=done] .spinner { animation: none; border-color: var(--success); background: var(--success); }
@keyframes spin { to { transform: rotate(360deg); } }
.js-only { display: none; }
html.js .js-only { display: revert; }
html.js .no-js { display: none; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
${WIDTHS}
`;
