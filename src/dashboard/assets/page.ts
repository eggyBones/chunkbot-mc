// Static viewer assets, embedded as strings so the compiled build is
// self-contained (tsc copies no other files). The script is a thin renderer of
// the server-built view model: it uses textContent only (no HTML injection),
// opens one EventSource, and has no control that writes anything.

export const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Chunkbot</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root" aria-live="polite"><div class="boot">Connecting to the local dashboard…</div></div>
<script src="/app.js" defer></script>
</body>
</html>
`;

export const APP_CSS = String.raw`
:root {
  --bg: #0f1112; --panel: #171a1c; --panel2: #1d2124; --line: #2a2f33; --text: #dfe3e6; --muted: #8b949b; --faint: #5d656b;
  --ok: #57b98a; --warn: #e3a33b; --bad: #e5534b; --active: #4fb0d6;
  --heart: #e5484d; --heart-off: #3a2426; --food: #d39a45; --food-off: #3a3022; --xp: #80cc4f; --xp-off: #26331d;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }
.boot { padding: 48px; color: var(--muted); }
.app { display: grid; gap: 12px; padding: 12px; grid-template-columns: minmax(330px, 1fr) minmax(360px, 1.35fr) minmax(330px, 1fr); grid-template-areas: "bar bar bar" "world dir usage"; max-width: 1900px; margin: 0 auto; }
.bar { grid-area: bar; } .world { grid-area: world; } .dir { grid-area: dir; } .usage { grid-area: usage; }
@media (max-width: 1180px) { .app { grid-template-columns: 1fr 1fr; grid-template-areas: "bar bar" "dir dir" "world usage"; } }
@media (max-width: 760px) { .app { grid-template-columns: 1fr; grid-template-areas: "bar" "dir" "world" "usage"; padding: 8px; } }
.col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; min-width: 0; }
.panel h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.panel h2 .aside { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--faint); }
.historical { opacity: .62; }
.historical-tag { color: var(--warn); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; }
.state { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--faint); flex: none; }
.s-live .dot { background: var(--ok); box-shadow: 0 0 0 3px rgba(87,185,138,.18); }
.s-disconnected .dot, .s-stale .dot { background: var(--warn); }
.s-crashed .dot, .s-error .dot { background: var(--bad); }
.s-stopped .dot, .s-no_session .dot { background: var(--faint); }
.bar .detail { color: var(--muted); flex: 1 1 260px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 12.5px; }
.chips b { color: var(--text); font-weight: 600; }
.t-ok { color: var(--ok); } .t-warn { color: var(--warn); } .t-bad { color: var(--bad); } .t-muted { color: var(--muted); } .t-active { color: var(--active); }
.pips { display: flex; flex-wrap: wrap; gap: 2px; margin: 6px 0 2px; }
.pips svg { width: 18px; height: 16px; image-rendering: pixelated; }
.vital { margin-bottom: 12px; }
.vital .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.vital .big { font-size: 22px; font-weight: 700; }
.vital .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
.critical .big { color: var(--bad); }
.xp { display: flex; align-items: center; gap: 10px; }
.xp .lvl { font-size: 26px; font-weight: 800; color: var(--xp); min-width: 40px; text-align: center; }
.xpbar { flex: 1; height: 10px; background: var(--xp-off); border-radius: 2px; overflow: hidden; border: 1px solid #1b2414; }
.xpbar > .fill { height: 100%; width: 0; background: var(--xp); }
.inv { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 3px; }
.inv.hotbar { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); }
.slot { position: relative; aspect-ratio: 1; background: hsl(var(--hue, 210), 32%, 27%); border: 1px solid #262a2e; border-radius: 3px; display: flex; align-items: center; justify-content: center; font: 700 12px/1 var(--mono); color: #f2f2f2; min-width: 0; overflow: hidden; }
.slot.empty { color: transparent; background: var(--panel2); }
.slot .n { position: absolute; right: 3px; bottom: 2px; font-size: 11px; font-weight: 700; text-shadow: 0 1px 0 #000; }
.slot.sel { outline: 2px solid #f0f0f0; outline-offset: -1px; }
.slot .k { position: absolute; left: 3px; top: 2px; font-size: 9px; color: rgba(255,255,255,.4); font-weight: 400; }
.equip { display: grid; grid-template-columns: repeat(5, 44px) 1fr; gap: 3px; margin-bottom: 8px; align-items: center; }
.equip .cap { color: var(--faint); font-size: 11px; padding-left: 8px; }
.note { color: var(--muted); font-size: 12px; margin-top: 6px; }
.mono { font-family: var(--mono); overflow-wrap: anywhere; }
.callout { border: 1px solid var(--line); border-left: 3px solid var(--warn); background: #1f1b14; padding: 8px 10px; border-radius: 4px; margin-top: 10px; }
.phase { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 99px; border: 1px solid currentColor; font-size: 12px; font-weight: 700; }
.headline { font-size: 26px; line-height: 1.25; font-weight: 700; margin: 10px 0 6px; word-wrap: break-word; }
.headline.none { color: var(--faint); font-weight: 500; }
.task { margin-top: 12px; background: var(--panel2); border: 1px solid var(--line); border-radius: 5px; padding: 10px 12px; }
.task .obj { font-size: 17px; font-weight: 600; }
.pending { margin-top: 12px; border: 1px dashed #5b6268; border-radius: 5px; padding: 10px 12px; }
.lab { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
.kv dt { color: var(--muted); font-size: 12.5px; }
.kv dd { margin: 0; text-align: right; font-family: var(--mono); font-size: 12.5px; word-break: break-word; }
.kv.wide dd { text-align: left; font-family: inherit; }
.memlist { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.memrow { border-top: 1px solid #202427; padding-top: 6px; min-width: 0; }
.memlabel { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.memmeta { color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: break-word; word-break: normal; }
.money { font-size: 22px; font-weight: 700; font-family: var(--mono); }
.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 8px; margin-bottom: 10px; }
.split > div { min-width: 0; background: var(--panel2); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; }
.split .lab { color: var(--muted); font-size: 11px; }
.split .val { font: 700 15px var(--mono); overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); padding: 3px 4px; }
td { padding: 3px 4px; border-bottom: 1px solid #202427; font-family: var(--mono); white-space: nowrap; }
.scroll { overflow-x: auto; }
.quota { margin: 6px 0; }
.qbar { height: 8px; background: #23282c; border-radius: 2px; overflow: hidden; margin: 3px 0; }
.qbar > .fill { height: 100%; width: 0; background: var(--active); }
.qrow { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.mt { margin-top: 12px; }
.ready { display: grid; grid-template-columns: max-content 1fr; gap: 3px 10px; font-size: 12px; }
.ready .r { white-space: nowrap; }
.ready .d { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.lost { position: fixed; bottom: 10px; right: 10px; background: #2a1414; border: 1px solid var(--bad); color: #ffd7d4; padding: 6px 10px; border-radius: 4px; font-size: 12px; }
`;

export const APP_JS = String.raw`
(function () {
  'use strict';
  var root = document.getElementById('root');
  var last = null;
  var lostEl = null;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k) || attrs[k] == null) continue;
      if (k === 'text') n.textContent = String(attrs[k]);
      else if (k === 'cls') n.className = attrs[k];
      else if (k === 'css') { for (var p in attrs.css) if (Object.prototype.hasOwnProperty.call(attrs.css, p)) n.style.setProperty(p, attrs.css[p]); }
      else n.setAttribute(k, attrs[k]);
    }
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
    return n;
  }
  function txt(s) { return document.createTextNode(String(s)); }
  function ago(ms) {
    if (ms == null) return 'never';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 2) return 'just now';
    if (s < 90) return s + ' s ago';
    var m = Math.round(s / 60);
    if (m < 90) return m + ' min ago';
    return new Date(ms).toLocaleString();
  }

  function agoSpan(prefix, ms, suffix) {
    var n = el('span', { 'data-ago': ms, 'data-prefix': prefix, 'data-suffix': suffix || '' });
    n.textContent = prefix + ago(ms) + (suffix || '');
    return n;
  }
  function tickAges() {
    var list = root.querySelectorAll('[data-ago]');
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      n.textContent = n.getAttribute('data-prefix') + ago(Number(n.getAttribute('data-ago'))) + n.getAttribute('data-suffix');
    }
  }

  var SVGNS = 'http://www.w3.org/2000/svg';
  var HEART = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
  var SHANK = ['....XX.', '...XXXX', '..XXXXX', '.XXXXX.', 'XX.X...', 'X......'];
  function pixelIcon(pattern, state, on, off) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 7 6');
    svg.setAttribute('aria-hidden', 'true');
    for (var y = 0; y < pattern.length; y++) for (var x = 0; x < pattern[y].length; x++) {
      if (pattern[y][x] !== 'X') continue;
      var lit = state === 'full' || (state === 'half' && x < 3);
      var r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
      r.setAttribute('fill', lit ? on : off);
      svg.appendChild(r);
    }
    return svg;
  }
  function pipRow(pips, pattern, on, off, label) {
    if (!pips) return null;
    var row = el('div', { cls: 'pips', role: 'img', 'aria-label': label });
    for (var i = 0; i < pips.length; i++) row.appendChild(pixelIcon(pattern, pips[i], on, off));
    return row;
  }

  function kv(rows, wide) {
    var dl = el('dl', { cls: 'kv' + (wide ? ' wide' : '') });
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      dl.appendChild(el('dt', { text: r.label, title: r.title || null }));
      dl.appendChild(el('dd', { text: r.value, cls: r.tone ? 't-' + r.tone : null, title: r.title || null }));
    }
    return dl;
  }

  // Memory rows: the (possibly long, natural-language) label on its own line and its
  // metadata (place, coordinates, source, time, stale) underneath at full width.
  function memList(rows) {
    var ul = el('ul', { cls: 'memlist' });
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      ul.appendChild(el('li', { cls: 'memrow', title: r.title || null }, [
        el('div', { cls: 'memlabel', text: r.label }),
        el('div', { cls: 'memmeta' + (r.tone ? ' t-' + r.tone : ''), text: r.value })
      ]));
    }
    return ul;
  }

  function slot(s, selected, caption) {
    if (!s.key) return el('div', { cls: 'slot empty' + (selected ? ' sel' : ''), title: (caption ? caption + ': ' : '') + 'empty' }, [caption ? el('span', { cls: 'k', text: caption }) : null]);
    var d = el('div', { cls: 'slot' + (selected ? ' sel' : ''), title: (caption ? caption + ': ' : '') + s.name + ' x' + s.count, css: { '--hue': String(s.hue) } }, [
      caption ? el('span', { cls: 'k', text: caption }) : null,
      txt(s.abbr),
      s.count > 1 ? el('span', { cls: 'n', text: s.count }) : null
    ]);
    return d;
  }

  function panel(title, aside, kids, cls, asideCls) {
    var h = el('h2', null, [txt(title), aside ? el('span', { cls: 'aside' + (asideCls ? ' ' + asideCls : ''), text: aside }) : null]);
    return el('section', { cls: 'panel' + (cls ? ' ' + cls : '') }, [h].concat(kids));
  }

  function renderBar(vm) {
    var b = vm.banner;
    var chips = el('div', { cls: 'chips' });
    for (var i = 0; i < vm.identity.length; i++) {
      var r = vm.identity[i];
      chips.appendChild(el('span', { title: r.title || null }, [txt(r.label + ' '), el('b', { text: r.value, cls: r.tone ? 't-' + r.tone : null })]));
    }
    return el('header', { cls: 'bar s-' + b.state }, [
      el('span', { cls: 'state' }, [el('span', { cls: 'dot' }), txt(b.title)]),
      el('span', { cls: 'detail' }, [txt(b.detail + (b.detail ? ' ' : '')), b.updatedAtMs ? agoSpan('Last update ', b.updatedAtMs, '.') : null]),
      chips
    ]);
  }

  function renderWorld(vm) {
    var w = vm.world;
    var hist = w.historical;
    var aside = hist ? (w.asOfMs ? 'last known · ' + new Date(w.asOfMs).toLocaleTimeString() : 'no readings') : 'live';
    var health = el('div', { cls: 'vital' + (w.health.critical ? ' critical' : ''), title: w.health.title }, [
      el('div', { cls: 'row' }, [el('span', { cls: 'label', text: 'Health' }), el('span', { cls: 'big', text: w.health.text })]),
      pipRow(w.health.pips, HEART, '#e5484d', '#3a2426', 'health ' + w.health.text)
    ]);
    var food = el('div', { cls: 'vital', title: w.food.title }, [
      el('div', { cls: 'row' }, [el('span', { cls: 'label', text: 'Hunger' }), el('span', { cls: 'big', text: w.food.text })]),
      pipRow(w.food.pips, SHANK, '#d39a45', '#3a3022', 'hunger ' + w.food.text),
      el('div', { cls: 'note', text: 'Saturation ' + w.saturation })
    ]);
    var xp = el('div', { cls: 'vital', title: w.xp.title }, [
      el('div', { cls: 'row' }, [el('span', { cls: 'label', text: 'Experience' }), el('span', { cls: 'note', text: w.xp.text })]),
      el('div', { cls: 'xp' }, [el('span', { cls: 'lvl', text: w.xp.level }), el('div', { cls: 'xpbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': w.xp.progress == null ? null : String(Math.round(w.xp.progress * 100)) }, [w.xp.progress == null ? null : el('div', { cls: 'fill', css: { width: Math.round(w.xp.progress * 1000) / 10 + '%' } })])])
    ]);
    var vit = panel('Vitals', aside, [health, food, xp], hist ? 'historical' : '', hist ? 'historical-tag' : '');

    var inv = w.inventory;
    var eq = el('div', { cls: 'equip' });
    var caps = ['H', 'C', 'L', 'F'];
    for (var i = 0; i < inv.armor.length; i++) eq.appendChild(slot(inv.armor[i], false, caps[i]));
    eq.appendChild(slot(inv.offhand, false, 'OH'));
    eq.appendChild(el('span', { cls: 'cap', text: 'armor · off hand' }));
    var main = el('div', { cls: 'inv' });
    for (i = 0; i < inv.main.length; i++) main.appendChild(slot(inv.main[i], false));
    var hot = el('div', { cls: 'inv hotbar', title: 'selected slot: ' + inv.selectedTitle });
    for (i = 0; i < inv.hotbar.length; i++) hot.appendChild(slot(inv.hotbar[i], inv.selected === i, String(i + 1)));
    var kids = [eq, main, hot, el('div', { cls: 'note', text: inv.status + (inv.totalItems != null ? ' · ' + inv.totalItems + ' items' : '') })];
    if (inv.container) kids.push(el('div', { cls: 'callout', text: inv.container }));
    var invPanel = panel('Inventory', inv.selected != null ? 'hotbar ' + (inv.selected + 1) + ' selected' : '', kids, hist ? 'historical' : '');
    return el('div', { cls: 'col world' }, [vit, invPanel]);
  }

  function renderDirective(vm) {
    var d = vm.directive;
    var kids = [
      el('div', null, [el('span', { cls: 'phase t-' + d.phaseTone, text: d.phase }), txt('  '), el('span', { cls: 't-muted', text: d.mode })]),
      el('div', { cls: 'headline' + (d.instruction ? '' : ' none'), text: d.headline })
    ];
    if (d.pause) kids.push(d.pause.tone === 'warn' ? el('div', { cls: 'callout', text: d.pause.text }) : el('div', { cls: 'note', text: d.pause.text }));
    if (d.clarification) kids.push(el('div', { cls: 'callout', text: 'Question for you — ' + d.clarification }));
    if (d.survival) kids.push(el('div', { cls: 'callout', text: 'Survival routine — ' + d.survival + ' (your directive stays queued)' }));
    if (d.task) kids.push(el('div', { cls: 'task' }, [el('div', { cls: 'lab t-muted', text: 'Current task' }), el('div', { cls: 'obj', text: d.task.objective }), el('div', { cls: 'note', text: d.task.detail })]));
    if (d.pending) kids.push(el('div', { cls: 'pending' }, [el('div', { cls: 'lab', text: 'Next — prepared, not started (' + d.pending.state + ')' }), el('div', { cls: 'obj', text: d.pending.instruction }), el('div', { cls: 'note', text: d.pending.detail })]));
    if (d.details.length) kids.push(el('div', { cls: 'mt' }, [kv(d.details, true)]));
    if (d.outcomeTechnical) kids.push(el('details', { cls: 'mt' }, [el('summary', { text: 'Technical outcome contract' }), el('div', { cls: 'note mono', text: d.outcomeTechnical })]));
    if (d.lastTask) kids.push(el('div', { cls: 'note', text: 'Last task: ' + d.lastTask }));
    var p = panel('Directive', d.historical ? 'last known — not live' : (d.pendingInstalled ? '' : 'handoff preview not installed'), kids, d.historical ? 'historical' : '');
    var ready = el('div', { cls: 'ready' });
    for (var i = 0; i < vm.readiness.length; i++) {
      var r = vm.readiness[i];
      ready.appendChild(el('span', { cls: 'r ' + (r.ready ? 't-ok' : 't-warn'), text: (r.ready ? '● ' : '○ ') + r.name }));
      ready.appendChild(el('span', { cls: 'd', text: r.detail, title: r.detail }));
    }
    var mem = vm.memory;
    var memKids = [el('div', { cls: 'note', text: mem.text })];
    if (mem.items.length) memKids.push(memList(mem.items));
    return el('div', { cls: 'col dir' }, [p, panel('Adapters', '', [ready]), panel('Memory', mem.installed ? '' : 'not installed', memKids)]);
  }

  function renderUsage(vm) {
    var u = vm.usage;
    var split = null;
    if (u.jevSplit.length) {
      split = el('div', { cls: 'split' });
      for (var j = 0; j < u.jevSplit.length; j++) {
        var sr = u.jevSplit[j];
        split.appendChild(el('div', { title: sr.title || null }, [el('div', { cls: 'lab', text: sr.label }), el('div', { cls: 'val t-' + (sr.tone || 'muted'), text: sr.value })]));
      }
    }
    var jevPanel = panel('OpenRouter · Jev decisions', 'this run', [split, kv(u.jev), el('div', { cls: 'note', text: u.note })], u.historical ? 'historical' : '');
    var planPanel = panel('Codex planner', 'this run', [kv(u.planner)], u.historical ? 'historical' : '');
    var h = vm.history;
    var hk = [el('div', { cls: 'note', text: h.coverage })];
    if (h.days.length) {
      var t = el('table');
      t.appendChild(el('tr', null, [el('th', { text: 'Day' }), el('th', { text: 'Jev $' }), el('th', { text: 'Retained' }), el('th', { text: 'Calls' }), el('th', { text: 'Jev tok in/out' }), el('th', { text: 'Plan turns' }), el('th', { text: 'Plan tok in/out' })]));
      for (var i = 0; i < h.days.length; i++) {
        var d = h.days[i];
        t.appendChild(el('tr', null, [el('td', { text: d.day }), el('td', { text: d.jevUsd }), el('td', { text: d.retainedUsd }), el('td', { text: d.jevAttempts }), el('td', { text: d.jevTokens }), el('td', { text: d.plannerTurns }), el('td', { text: d.plannerTokens })]));
      }
      hk.push(el('div', { cls: 'scroll' }, [t]));
    }
    if (h.gaps.length) {
      var det = el('details', null, [el('summary', { text: 'Coverage gaps (' + h.gaps.length + ')' })]);
      for (i = 0; i < h.gaps.length; i++) det.appendChild(el('div', { cls: 'note', text: h.gaps[i] }));
      hk.push(det);
    }
    var histPanel = panel('Usage history', h.timeZone, hk);
    var r = vm.remote;
    var q = r.codex;
    var qk = [el('div', { cls: 'note', text: q.status })];
    for (i = 0; i < q.windows.length; i++) {
      var w = q.windows[i];
      qk.push(el('div', { cls: 'quota' }, [
        el('div', { cls: 'qrow' }, [el('span', { text: w.bucket + ' · ' + w.duration }), el('b', { text: w.remaining })]),
        el('div', { cls: 'qbar', title: w.used + '% used', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.max(0, 100 - w.used)) }, [el('div', { cls: 'fill', css: { width: Math.max(0, 100 - w.used) + '%' } })]),
        el('div', { cls: 'note', text: 'resets ' + (w.resets.indexOf('unknown') >= 0 ? w.resets : new Date(w.resets).toLocaleString()) })
      ]));
    }
    qk.push(el('div', { cls: 'note', text: q.detail }));
    var acct = panel('Accounts', r.cadence, [
      el('div', { cls: 'note', text: 'OpenRouter key: ' + r.openRouterStatus }),
      r.openRouterKey.length ? kv(r.openRouterKey) : null,
      el('div', { cls: 'note', text: r.wallet }),
      el('div', { cls: 'mt' }, [el('div', { cls: 'lab t-muted', text: 'Codex subscription' })].concat(qk))
    ]);
    return el('div', { cls: 'col usage' }, [jevPanel, planPanel, histPanel, acct]);
  }

  function render(vm) {
    last = vm;
    var app = el('main', { cls: 'app' }, [renderBar(vm), renderWorld(vm), renderDirective(vm), renderUsage(vm)]);
    root.replaceChildren(app);
    document.title = (vm.banner.state === 'live' ? '● ' : '○ ') + 'Chunkbot — ' + vm.banner.title;
  }

  function lost(on) {
    if (on && !lostEl) { lostEl = el('div', { cls: 'lost', text: 'Dashboard service unreachable — retrying. Values shown are frozen.' }); document.body.appendChild(lostEl); }
    if (!on && lostEl) { lostEl.remove(); lostEl = null; }
  }

  fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(render).catch(function () { lost(true); });
  var es = new EventSource('/events');
  es.addEventListener('state', function (e) { lost(false); try { render(JSON.parse(e.data)); } catch (err) { /* ignore malformed frame */ } });
  es.onerror = function () { lost(true); };
  setInterval(tickAges, 1000);
})();
`;
