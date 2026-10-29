// Outsourcerer dashboard: a renderer over the CLI's --json commands (served by server.py at /api/*).
// No logic of its own beyond formatting: every number, row and action comes from the CLI. Data is put
// into the page with textContent only, never parsed as HTML.
"use strict";

// ---- tiny DOM helper -------------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;   // CSSOM, not an attribute: the CSP blocks inline style attributes
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
// replaceChildren, skipping null/false the way h() does (a bare null would render as the text "null")
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const nz = (v, d = "—") => (v === null || v === undefined || v === "" ? d : v);
const pct = (v) => (v === null || v === undefined ? "—" : `${v}%`);
function ago(s) {
  if (s === null || s === undefined || isNaN(s)) return "—";
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}
const repoOf = (p) => (p ? String(p).split("/").filter(Boolean).pop() : null);
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}
function shellQuote(a) { return /^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`; }
const cmdline = (argv) => argv.map(shellQuote).join(" ");
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied: " + text); }
  catch (e) { toast("Copy failed; the command is: " + text); }
}

// Run one allow-listed action through the server (POST /api/run). Destructive ones ask for a second
// click on the same button instead of a browser dialog.
const DESTRUCTIVE = (argv) => argv[1] === "cancel" || (argv[1] === "consent" && argv[2] === "revoke") || (argv[1] === "posture" && argv[2] === "reset")
  || ((argv[1] === "bg" || argv[1] === "loop") && argv.includes("yolo"));   // yolo = all tools, no sandbox
// Actions that only read: their output is the point, so it opens in the drawer instead of a toast.
const READS = (argv) => ["explain", "result", "watch", "bg", "loop"].includes(argv[1]) || (argv[1] === "fleet" && argv[2] === "show");
async function runAction(argv, btn) {
  if (btn && DESTRUCTIVE(argv) && btn.dataset.armed !== "1") {
    btn.dataset.armed = "1"; btn.dataset.label = btn.textContent; btn.textContent = "Click again to confirm";
    setTimeout(() => { if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = btn.dataset.label; } }, 4000);
    return null;
  }
  if (btn) { btn.dataset.armed = ""; btn.disabled = true; }
  try {
    const r = await fetch("/api/run", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Osrc-Dash": "1" }, body: JSON.stringify({ argv }) });
    const res = await r.json();
    if (!r.ok) { toast(res.error || `HTTP ${r.status}`); return res; }
    const first = (res.ok ? res.stdout : res.stderr || res.stdout || "").trim().split("\n").filter(Boolean).slice(-1)[0] || "";
    toast((res.ok ? "Done: " : `Failed (exit ${res.exit}): `) + cmdline(argv) + (first ? " · " + first.slice(0, 160) : ""));
    lastRun = res;
    if (READS(argv)) showOutput(cmdline(argv), res); else refresh();
    return res;
  } catch (e) { toast("Could not run: " + e.message); return null; }
  finally { if (btn) { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; } }
}
let lastRun = null;
function showOutput(title, res) {
  drawerFor = null;
  drawerShell(title, res.ok ? "exit 0" : `exit ${res.exit}`,
    h("div", { class: "log" }, (res.stdout || "").trim() || "(no output)"),
    (res.stderr || "").trim() ? h("details", {}, h("summary", { class: "muted" }, "stderr"), h("div", { class: "log" }, res.stderr.trim())) : null);
}
const runBtn = (label, argv, cls = "btn small") => h("button", { class: cls, type: "button", title: cmdline(argv),
  onclick: (e) => runAction(argv, e.currentTarget) }, label);
const copyBtn = (argv) => h("button", { class: "ghost small", type: "button", "aria-label": "Copy command", title: "Copy: " + cmdline(argv),
  onclick: () => copy(cmdline(argv)) }, "⧉");

// ---- data ------------------------------------------------------------------------------------------
const cache = {};
const ages = {};   // seconds old, per endpoint, as the server reported it (X-Osrc-Age)
async function api(path) {
  const r = await fetch("/api/" + path, { credentials: "same-origin", cache: "no-store" });
  const ctype = r.headers.get("content-type") || "";
  const body = ctype.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error((body && body.error) || `HTTP ${r.status}`), { body, status: r.status });
  cache[path] = body;
  ages[path] = Number(r.headers.get("X-Osrc-Age") || 0);
  return body;
}
async function many(paths) {
  const out = {};
  await Promise.all(paths.map(async (p) => {
    try { out[p] = await api(p); } catch (e) { out[p] = { __error: e.message, __body: e.body }; }
  }));
  return out;
}
const failed = (d) => d && d.__error;
function errBox(what, d) {
  return h("div", { class: "err" }, `${what}: ${d.__error}`,
    d.__body && d.__body.command ? h("div", { class: "cmd" }, cmdline(d.__body.command)) : null);
}

// ---- chrome (top bar, nav badges) ----------------------------------------------------------------------
async function chrome() {
  const d = await many(["mode", "heartbeat", "inbox", "status", "brief"]);
  if (!failed(d.mode)) {
    const label = { auto: "Auto-pilot", hybrid: "Hybrid", manual: "You-drive" }[d.mode.mode] || d.mode.mode || "Mode not set";
    $("mode-pill").textContent = label; $("mode-pill").title = d.mode.meaning || "";
  }
  if (!failed(d.heartbeat)) {
    $("hb").replaceChildren(h("span", { class: "dot " + (d.heartbeat.armed ? "green" : "gray") }),
      d.heartbeat.armed ? "Heartbeat armed" : "Heartbeat not armed");
  }
  if (!failed(d.inbox)) {
    const n = d.inbox.counts.items;
    $("b-needs").textContent = String(n); $("b-needs").classList.toggle("zero", n === 0);
    const p = $("needs-pill"); p.hidden = n === 0; p.textContent = `${n} need you`;
  }
  if (!failed(d.status)) $("b-live").textContent = String(d.status.jobs.filter(isLive).length);
  if (!failed(d.brief)) {
    const c = d.brief.limits && d.brief.limits.claude_5h_pct;
    $("b-fuel").textContent = c === null || c === undefined ? "" : `${c}%`;
  }
  $("refreshed").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  // Honest freshness: the page may show a cached answer while a fresher one is computed in the background.
  const ia = ages.inbox || 0;
  $("refreshed").title = `Inbox data ${ia}s old` + (ia > 30 ? " (a fresh read is on its way)" : "");
  $("refreshed").classList.toggle("amber", ia > 60);
}

// ---- routing ----------------------------------------------------------------------------------------------
const SCREENS = {};
let current = null, timer = null;
function route() {
  const name = (location.hash.slice(1).split("/")[0]) || "needs";
  const scr = SCREENS[name] ? name : "needs";
  document.querySelectorAll(".nav").forEach((a) => {
    if (a.dataset.route === scr) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (current !== scr) { closeDrawer(); current = scr; $("view").replaceChildren(h("p", { class: "muted" }, "Loading…")); }
  refresh();
}
async function refresh() {
  clearTimeout(timer);
  const name = current, scr = SCREENS[name], off = h("div");
  // Render off-page and swap in only if this is still the current screen: a slow render of the screen
  // you just left must not land on top of the one you switched to.
  try {
    await Promise.all([chrome(), scr.render(off)]);
    if (current === name) { put($("view"), [...off.childNodes]); labelTables($("view")); }
  } catch (e) { if (current === name) put($("view"), h("div", { class: "err" }, "Could not load: " + e.message)); }
  if (current === name) timer = setTimeout(refresh, (scr.every || 10) * 1000);
}
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

// Give each data cell its column name, so on a phone a table row can stack into a labelled card.
// Tables whose rows are single-purpose lists (no header row) are left as they are.
function labelTables(root) {
  root.querySelectorAll(".tbl table").forEach((t) => {
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    if (heads.length < 3) return;
    t.classList.add("stackable");
    t.querySelectorAll("tbody tr").forEach((tr) => [...tr.children].forEach((td, i) => { td.dataset.label = i === 0 ? "" : (heads[i] || ""); }));
  });
}

// ---- shared bits -------------------------------------------------------------------------------------------
const PERM = { run: "read-only", explore: "read-only", research: "sandboxed", edit: "edits", yolo: "yolo" };
function permChip(verb) { return verb ? h("span", { class: "chip perm-" + (verb === "explore" ? "run" : verb) }, PERM[verb] || verb) : "—"; }
function isLive(j) { return ["running", "launching", "no-progress-writes", "stalled?", "exploring?"].includes(j.status); }
function modelCell(req, obs) {
  if (!obs || obs === req) return h("span", { class: "mono" }, nz(req));
  const a = String(req || "").toLowerCase(), b = String(obs).toLowerCase();
  const drift = a && !b.includes(a) && !a.includes(b);
  return h("span", { class: "mono" }, nz(req), " → ", h("span", { class: drift ? "red" : "" , style: drift ? "font-weight:600" : null }, obs));
}
function actionButtons(item) {
  const out = [];
  const one = (a, primary) => {
    if (!a) return;
    const needsInput = a.input === "answer";
    const btn = h("button", { class: primary ? "pbtn small" : "btn small", type: "button",
      title: "Runs: " + cmdline(a.argv),
      onclick: () => {
        let argv = a.argv;
        if (needsInput) {
          const field = btn.parentElement.querySelector("input");
          const v = field && field.value.trim();
          if (!v) { field && field.focus(); toast("Type your answer first"); return; }
          argv = argv.map((x) => (x === "{answer}" ? v : x));
        }
        runAction(argv, btn);
      } }, a.label);
    if (needsInput) out.push(h("input", { type: "text", placeholder: "your answer", "aria-label": "Answer for " + item.title, size: 18 }));
    out.push(btn);
  };
  one(item.primary_action, true);
  one(item.secondary_action, false);
  out.push(copyBtn(item.primary_action.argv));
  return out;
}
function kindLabel(k) {
  return { permission: "Permission", blocked: "Blocked", model_drift: "Model drift", decision: "Decision",
    waiting_on_you: "Waiting on you", not_delivered: "Not delivered", maybe_stuck: "Maybe stuck", unwatched: "Unwatched" }[k] || k;
}

// ---- 1 · Needs you ---------------------------------------------------------------------------------------------
SCREENS.needs = { every: 6, async render(v) {
  const d = await many(["inbox", "status"]);
  if (failed(d.inbox)) return put(v, errBox("inbox", d.inbox));
  const ib = d.inbox, live = failed(d.status) ? 0 : d.status.jobs.filter(isLive).length;
  const head = h("div", { class: "head" }, h("div", {}, h("h1", {}, "Needs you"),
    h("p", { class: "sub" }, ib.counts.items ? `${ib.counts.items} item${ib.counts.items === 1 ? "" : "s"} · ${ib.counts.red} blocking work` : "All clear")));
  let body;
  if (!ib.items.length) {
    body = h("div", { class: "card empty" }, h("div", { class: "big" }, "🧙"), h("h2", {}, "Nothing needs you."),
      h("p", { class: "muted" }, `${live} job${live === 1 ? "" : "s"} running. `, h("a", { href: "#live" }, "See Live →")));
  } else {
    body = h("section", { class: "card rows", "aria-label": "Items blocked on you" }, ib.items.map((it) =>
      h("div", { class: "row" },
        h("div", { class: "sev " + it.severity }),
        h("div", { class: "body" },
          h("div", { class: "line1" }, h("span", { class: "kind " + it.severity }, kindLabel(it.kind)), h("span", { class: "title" }, it.title)),
          h("div", { class: "reason" }, it.reason),
          h("div", { class: "meta" }, it.repo ? h("span", {}, it.repo) : null, it.lane ? h("span", { class: "mono" }, it.lane) : null,
            h("span", {}, "waiting " + ago(it.waiting_s)),
            it.deadline_s !== null && it.deadline_s !== undefined ? h("span", { class: "amber" }, `default ${it.default ? "(" + it.default + ") " : ""}in ${ago(it.deadline_s)}`) : null),
          h("div", { class: "cmd" }, cmdline(it.primary_action.argv))),
        h("div", { class: "acts" }, actionButtons(it)))));
  }
  const unk = ib.unknown.length ? h("details", { class: "card pad", style: "margin-top:16px" },
    h("summary", { class: "muted" }, `Can't tell (${ib.unknown.length}): sessions whose state is unknown. Not alerts.`),
    h("div", { class: "rows" }, ib.unknown.map((u) => h("div", { class: "row" }, h("div", { class: "sev", style: "background:var(--gy)" }),
      h("div", { class: "body" }, h("span", {}, u.title), h("span", { class: "meta" }, h("span", { class: "mono" }, u.session_id), u.repo || "", u.lane || "",
        "last seen " + ago(u.last_seen_s))))))) : null;
  put(v, head, body, unk);
} };

// ---- 2 · Live ---------------------------------------------------------------------------------------------------
let liveTab = "live";
SCREENS.live = { every: 5, async render(v) {
  const d = await many(["status", "inbox", "loops", "fleet", "fanouts"]);
  if (failed(d.status)) return put(v, errBox("status", d.status));
  const needIds = new Set(failed(d.inbox) ? [] : d.inbox.items.map((i) => i.refs && i.refs.job_id).filter(Boolean));
  const jobs = d.status.jobs;
  const filters = {
    live: (j) => isLive(j) || needIds.has(j.job_id),
    needs: (j) => needIds.has(j.job_id),
    running: isLive,
    done: (j) => !isLive(j) && !needIds.has(j.job_id),
  };
  const labels = { live: "Live or needs me", needs: "Needs me", running: "Running", done: "Stopped" };
  const tabs = h("div", { class: "tabs", role: "tablist" }, Object.keys(filters).map((k) =>
    h("button", { class: "tab", role: "tab", "aria-selected": String(k === liveTab), type: "button",
      onclick: () => { liveTab = k; refresh(); } }, `${labels[k]} `, h("span", { class: "mono faint" }, jobs.filter(filters[k]).length))));
  const shown = jobs.filter(filters[liveTab]);
  const now = Date.now() / 1000;
  const table = h("div", { class: "card tbl" }, h("table", {},
    h("thead", {}, h("tr", {}, ["Task", "Type", "Lane", "Model (requested → observed)", "Access", "Elapsed / limit", "Latest progress", "Repo"].map((c) => h("th", {}, c)))),
    h("tbody", {}, shown.length ? shown.map((j) => {
      const el = j.started ? now - j.started : null, lim = j.watchdog && j.watchdog.hard_s;
      const p = el !== null && lim ? Math.min(100, Math.round((100 * el) / lim)) : null;
      return h("tr", { class: "click" + (drawerFor === j.job_id ? " sel" : ""), tabindex: 0,
        onclick: () => openJob(j.job_id), onkeydown: (e) => { if (e.key === "Enter") openJob(j.job_id); } },
        h("td", {}, h("div", { class: "trunc" }, nz(j.label, j.verb)), h("div", { class: "mono faint" }, j.job_id),
          needIds.has(j.job_id) ? h("span", { class: "kind" }, "needs you") : null),
        h("td", {}, nz(j.shape, "job")),
        h("td", {}, h("span", { class: "chip" }, nz(j.provider))),
        h("td", {}, modelCell(j.model, j.observed_model)),
        h("td", {}, permChip(j.verb)),
        h("td", {}, isLive(j) ? [h("div", { class: "mono small" }, `${ago(el)} / ${lim ? ago(lim) : "?"}`),
          p !== null ? h("div", { class: "bar" }, h("i", { class: p >= 80 ? "amber" : "", style: `width:${p}%` })) : null] : h("span", { class: "muted" }, j.status)),
        h("td", {}, h("div", { class: "trunc mono small", title: j.progress.line || "" }, nz(j.progress.line, j.progress.last_marker || "—"))),
        h("td", {}, nz(repoOf(j.cwd)), j.worktree ? h("div", { class: "mono faint" }, nz(j.worktree.branch, "")) : null));
    }) : h("tr", {}, h("td", { colspan: 8, class: "muted" }, "Nothing here.")))));
  const loops = failed(d.loops) ? [] : d.loops.loops.filter((l) => liveTab === "done" ? l.state !== "running" : l.state === "running");
  const loopCard = loops.length ? h("section", { class: "card", style: "margin-top:16px" }, h("div", { class: "pad" }, h("h2", {}, "Loops")),
    h("div", { class: "tbl" }, h("table", {}, h("thead", {}, h("tr", {}, ["Loop", "State", "Attempt", "Elapsed", "Last failure"].map((c) => h("th", {}, c)))),
      h("tbody", {}, loops.map((l) => h("tr", { class: "click", tabindex: 0, onclick: () => openLoop(l) },
        h("td", {}, h("div", { class: "trunc" }, nz(l.task)), h("div", { class: "mono faint" }, l.loop_id)),
        h("td", {}, nz(l.state)), h("td", { class: "mono" }, `${nz(l.attempt)}/${nz(l.stop_rules.max_attempts, "∞")}`),
        h("td", { class: "mono" }, ago(l.elapsed_s)), h("td", {}, h("div", { class: "trunc mono small" }, nz(l.last_failure))))))))) : null;
  // Sessions: everything the fleet sees except this session and the managed mirrors of jobs above.
  const needSess = new Set(failed(d.inbox) ? [] : d.inbox.items.map((i) => i.refs && i.refs.session_id).filter(Boolean));
  const liveState = (x) => !["ended", "dead", "completed", "idle", "unknown"].includes(x.state);
  const sessAll = failed(d.fleet) ? [] : (d.fleet.items || []).filter((x) => x.owner !== "managed" && (x.self || 0) === 0);
  const sessFilter = { live: (x) => liveState(x) || needSess.has(x.session_id), needs: (x) => needSess.has(x.session_id),
    running: liveState, done: (x) => !liveState(x) && !needSess.has(x.session_id) };
  const sess = sessAll.filter(sessFilter[liveTab]);
  const sessCard = failed(d.fleet) ? errBox("fleet", d.fleet) : sess.length ? h("section", { class: "card", style: "margin-top:16px" },
    h("div", { class: "pad" }, h("h2", {}, `Sessions (${sess.length})`), h("p", { class: "faint small" }, "Claude Code peers and steerable sessions the fleet sees. Click one to read its tail.")),
    h("div", { class: "tbl" }, h("table", {}, h("thead", {}, h("tr", {}, ["Session", "Harness", "Model (requested → observed)", "State", "Last activity", "Repo"].map((c) => h("th", {}, c)))),
      h("tbody", {}, sess.map((x) => h("tr", { class: "click", tabindex: 0,
        onclick: () => runAction(["outsourcerer", "fleet", "show", x.session_id]), onkeydown: (e) => { if (e.key === "Enter") runAction(["outsourcerer", "fleet", "show", x.session_id]); } },
        h("td", {}, h("div", { class: "trunc" }, nz(x.display_name || x.task_summary, x.session_id)), h("div", { class: "mono faint" }, nz(x.session_id)),
          needSess.has(x.session_id) ? h("span", { class: "kind" }, "needs you") : null),
        h("td", {}, h("span", { class: "chip" }, nz(x.lane || x.harness))),
        h("td", {}, modelCell(x.requested_model, x.observed_model)),
        h("td", { class: x.state === "blocked" ? "red" : (x.state === "blocked?" || x.state === "unresponsive?") ? "amber" : "" }, nz(x.state_label || x.state)),
        h("td", { class: "mono" }, x.status_age !== null && x.status_age !== undefined ? ago(x.status_age) + " ago" : "—"),
        h("td", {}, nz(repoOf(x.cwd))))))))) : null;
  // Groups: fanout / crew runs, one row each with their summary counts.
  const groups = failed(d.fanouts) ? [] : d.fanouts.groups.filter((g) => {
    const run = g.summary && g.summary.running > 0;
    return liveTab === "done" ? !run : liveTab === "needs" ? (g.summary && g.summary.blocked > 0) : (liveTab === "running" ? run : run || (g.summary && g.summary.blocked > 0));
  });
  const groupCard = groups.length ? h("section", { class: "card", style: "margin-top:16px" }, h("div", { class: "pad" }, h("h2", {}, "Groups (fanout / crew)")),
    h("div", { class: "tbl" }, h("table", {}, h("thead", {}, h("tr", {}, ["Group", "Members", "Running", "Done", "Blocked", "Failed"].map((c) => h("th", {}, c)))),
      h("tbody", {}, groups.map((g) => h("tr", { class: "click", tabindex: 0, onclick: () => openGroup(g.fanout_id) },
        h("td", {}, h("div", { class: "trunc mono small" }, nz(g.manifest, "")), h("div", { class: "mono faint" }, g.fanout_id)),
        ...["total", "running", "done", "blocked", "failed"].map((k) => h("td", { class: "mono" + (k === "blocked" && g.summary[k] ? " amber" : k === "failed" && g.summary[k] ? " red" : "") }, nz(g.summary[k], 0))))))))) : null;
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Live runs"),
    h("p", { class: "sub" }, `${jobs.filter(isLive).length} jobs running · ${sessAll.filter(liveState).length} sessions active · ${needIds.size + needSess.size} need you · ${d.status.omitted || 0} older jobs not shown`))),
    tabs, table, sessCard, groupCard, loopCard);
  if (drawerFor) openJob(drawerFor, true);
} };

let drawerFor = null;
function closeDrawer() { drawerFor = null; $("drawer").hidden = true; $("drawer").replaceChildren(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden && $("palette").hidden) closeDrawer(); });
function drawerShell(title, sub, ...parts) {
  put($("drawer"),
    h("div", { style: "display:flex;gap:12px;align-items:flex-start" }, h("div", { class: "grow" }, h("h2", {}, title), sub ? h("div", { class: "mono faint" }, sub) : null),
      h("button", { class: "ghost small", type: "button", "aria-label": "Close", onclick: closeDrawer }, "✕")), ...parts);
  $("drawer").hidden = false;
}
async function openJob(id, quiet) {
  drawerFor = id;
  const d = await many([`job/${id}`, `logs/${id}`]);
  if (drawerFor !== id) return;
  const j = d[`job/${id}`];
  if (failed(j)) return drawerShell("Run " + id, null, errBox("status", j));
  const terminal = !isLive(j);
  let ex = null;
  if (terminal) { const e = await many([`explain/${id}`]); ex = e[`explain/${id}`]; }
  const now = Date.now() / 1000;
  drawerShell(nz(j.label, j.verb), j.job_id,
    h("dl", { class: "facts" },
      h("dt", {}, "State"), h("dd", {}, j.status, j.exit !== null ? ` (exit ${j.exit})` : ""),
      h("dt", {}, "Lane"), h("dd", {}, nz(j.provider)),
      h("dt", {}, "Model"), h("dd", {}, modelCell(j.model, j.observed_model)),
      h("dt", {}, "Access"), h("dd", {}, permChip(j.verb)),
      h("dt", {}, "Started"), h("dd", {}, j.started ? `${ago(now - j.started)} ago` : "—"),
      h("dt", {}, "Watchdog"), h("dd", {}, j.watchdog ? `stall ${ago(j.watchdog.stall_s)} · hard ${ago(j.watchdog.hard_s)}` : "not recorded"),
      h("dt", {}, "Where"), h("dd", { class: "mono" }, nz(j.cwd), j.worktree ? ` · ${nz(j.worktree.branch, "")}` : ""),
      h("dt", {}, "Verification"), h("dd", { class: j.verify ? "" : "amber" }, j.verify ? j.verify.check : "None recorded: finishes as done (unverified)"),
      h("dt", {}, "Tools"), h("dd", { class: "mono" }, `${j.progress.reads} reads · ${j.progress.writes} writes · ${j.progress.bash} shell`)),
    ex && !failed(ex) ? h("section", { class: "card pad" }, h("h2", {}, "Why it ended"),
      h("p", {}, nz(ex.verdict && ex.verdict.label), " · ", nz(ex.verdict && ex.verdict.reason)), ex.reason ? h("p", { class: "muted" }, ex.reason) : null,
      (ex.evidence || []).length ? h("div", { class: "log" }, ex.evidence.join("\n")) : null) : null,
    h("section", {}, h("h2", {}, "Progress"), j.progress.history.length
      ? h("div", { class: "timeline" }, j.progress.history.map((l, i) => h("div", { class: "att" + (i === j.progress.history.length - 1 ? "" : " muted") }, "• ", l)))
      : h("p", { class: "muted" }, "No progress markers yet.")),
    h("section", {}, h("h2", {}, "Log tail (secrets masked)"),
      failed(d[`logs/${id}`]) ? errBox("logs", d[`logs/${id}`]) : h("div", { class: "log" }, d[`logs/${id}`] || "(empty)")),
    h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      !terminal ? runBtn("Watch", ["outsourcerer", "watch", id]) : null,
      !terminal ? runBtn("Cancel", ["outsourcerer", "cancel", id]) : null,
      runBtn("Show result", ["outsourcerer", "result", id]),
      copyBtn(["outsourcerer", "result", id])));
}
async function openGroup(gid) {
  drawerFor = null;
  const d = await many([`fanout/${gid}`]);
  const g = d[`fanout/${gid}`];
  if (failed(g)) return drawerShell("Group " + gid, null, errBox("fanout status", g));
  const sm = g.summary;
  drawerShell("Group " + gid, `${sm.total} members · ${sm.running} running · ${sm.done} done · ${sm.blocked} blocked · ${sm.failed} failed`,
    h("div", { class: "rows" }, (g.jobs || []).map((j) => h("button", { type: "button", class: "row", style: "border:0;border-bottom:1px solid var(--bd);background:transparent;text-align:left;cursor:pointer;padding-left:0",
      onclick: () => openJob(j.job_id) },
      h("div", { class: "body" }, h("span", { class: "title" }, nz(j.label, j.job_id)), h("span", { class: "muted small" }, `${j.status} · `, modelCell(j.model, j.observed_model)),
        h("span", { class: "mono faint small" }, nz(j.progress && j.progress.line, "")))))));
}
async function openLoop(l) {
  drawerFor = null;
  const d = await many([`loop/${l.loop_id}`]);
  const x = failed(d[`loop/${l.loop_id}`]) ? l : (d[`loop/${l.loop_id}`].loops[0] || l);
  const sr = x.stop_rules;
  const task = nz(x.task);
  drawerShell(task.length > 110 ? task.slice(0, 110) + "…" : task, x.loop_id,
    task.length > 110 ? h("details", {}, h("summary", { class: "muted" }, "Full task"), h("div", { class: "log" }, task)) : null,
    h("dl", { class: "facts" }, h("dt", {}, "State"), h("dd", {}, nz(x.state)), h("dt", {}, "Check"), h("dd", { class: "mono" }, nz(x.check)),
      h("dt", {}, "Model"), h("dd", { class: "mono" }, nz(x.model, "default")), h("dt", {}, "Elapsed"), h("dd", {}, ago(x.elapsed_s))),
    h("section", {}, h("h2", {}, "Attempts"), h("div", { class: "timeline" }, x.attempts.map((a) =>
      h("div", { class: "att" }, h("span", { class: a.passed ? "green" : "red" }, a.passed ? "✓" : "✗"), `Attempt ${a.n}`, h("span", { class: "muted mono small" }, nz(a.first_failure, a.passed ? "check passed" : ""))))),
      x.state === "running" ? h("div", { class: "att" }, h("span", { class: "dot purple" }), `Attempt ${(x.attempt || 0)} running`) : null),
    h("p", { class: "muted" }, `Stops after ${nz(sr.max_attempts, "∞")} attempts`, sr.max_minutes ? ` or ${sr.max_minutes} min` : "",
      sr.same_failure_guard ? ", or when the same failures repeat twice." : "."));
}

// ---- 3 · Fuel ----------------------------------------------------------------------------------------------------
SCREENS.fuel = { every: 30, async render(v) {
  const d = await many(["brief", "tap", "tab", "doctor"]);
  if (failed(d.brief)) return put(v, errBox("brief", d.brief));
  const L = d.brief.limits || {}, cons = d.brief.conserve || {};
  const tapAge = failed(d.tap) ? null : d.tap.reading_age_s;
  const meter = (label, p, conserve) => {
    const hot = p === null || p === undefined ? "" : p >= 90 ? "red" : (p >= 70 || (conserve && p >= conserve)) ? "amber" : "";
    return h("div", { class: "meter" }, h("div", { class: "nums" }, h("span", { class: "muted" }, label), h("span", { class: "big " + hot }, pct(p))),
      h("div", { class: "bar" }, p === null || p === undefined ? null : h("i", { class: hot, style: `width:${Math.min(100, p)}%` }),
        conserve ? h("b", { style: `left:${conserve}%`, title: `conserve line ${conserve}%` }) : null),
      conserve ? h("span", { class: "faint small" }, `dashed = conserve line (${conserve}%)`) : null);
  };
  const ageTag = (s, staleAfter) => h("span", { class: "age" + (s === null || s === undefined || s > staleAfter ? " stale" : "") },
    s === null || s === undefined ? "no reading" : `read ${ago(s)} ago`);
  const card = (name, plan, age, ...kids) => h("section", { class: "card pad stack", style: "gap:8px" },
    h("div", { style: "display:flex;gap:8px;align-items:baseline" }, h("h2", { class: "grow" }, name), age), h("div", { class: "faint small" }, plan), ...kids);
  const lanes = failed(d.doctor) ? [] : d.doctor.lanes;
  const ready = (code) => { const l = lanes.find((x) => x.lane === code); return l ? (l.ready ? "ready" : l.installed === false ? "not installed" : "not ready") : "unknown"; };
  const cards = h("div", { class: "grid-cards" },
    card("Claude", "Your Claude plan · the lead session + Claude lanes", ageTag(tapAge, 900),
      meter("5-hour window", L.claude_5h_pct, cons.threshold_pct), meter("Weekly", L.claude_7d_pct),
      L.claude_5h_pct === null ? h("p", { class: "amber small" }, "No live reading. Install the limits tap in Settings so this is not a guess.") : null,
      cons.active ? h("p", { class: "amber small" }, "Above the conserve line: new delegations route away from Claude.") : null),
    card("ChatGPT / Codex", "Your ChatGPT plan · the Codex lane", ageTag(L.codex_reading_age_s, 3600),
      meter("5-hour window", L.codex_5h_pct), meter("Weekly", L.codex_weekly_pct),
      L.codex_reading_age_s > 3600 ? h("p", { class: "amber small" }, "Stale reading: real usage is likely higher. Re-read before trusting this headroom.") : null),
    ...[["Devin", "dv"], ["Gemini", "gm"], ["OpenRouter", "or"]].map(([n, c]) =>
      card(n, `Lane ${ready(c)}`, h("span", { class: "age stale" }, "no usage probe"), h("p", { class: "muted" }, "Usage unknown: the CLI has no meter for this lane yet, so none is shown."))),
    card("Local", "This machine", h("span", { class: "age" }, ready("local")), h("div", { class: "meter" }, h("span", { class: "big" }, "$0"), h("span", { class: "muted" }, "unlimited · private"))));
  const tab = failed(d.tab) ? errBox("tab", d.tab) : h("section", { class: "card pad" },
    h("h2", {}, "The Tab"),
    h("p", {}, `Cash spent: $${(d.tab.cash_measured_usd || 0).toFixed(2)} measured`, d.tab.cash_estimated_usd ? ` + $${d.tab.cash_estimated_usd.toFixed(2)} estimated` : "",
      ` · Plan-limit runs: ${d.tab.plan_runs} · Local runs: ${d.tab.local_runs} · All runs: ${d.tab.runs}`),
    h("p", { class: "amber small" }, "$0 cash does not mean free: plan-limit runs spend your subscription windows."),
    h("div", { class: "tbl" }, h("table", { style: "min-width:0" }, h("thead", {}, h("tr", {}, h("th", {}, "Plan"), h("th", {}, "Runs"))),
      h("tbody", {}, (d.tab.plans || []).map((p) => h("tr", {}, h("td", {}, p.plan), h("td", { class: "mono" }, p.runs)))))));
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Fuel"), h("p", { class: "sub" }, cons.recommendation || ""))), cards,
    h("div", { style: "height:16px" }), tab);
} };

// ---- 4 · Outcomes ------------------------------------------------------------------------------------------------
let outSel = null;
SCREENS.outcomes = { every: 60, async render(v) {
  const d = await many(["outcomes"]);
  const o = d.outcomes;
  if (failed(o)) return put(v, errBox("outcomes", o));
  const t = o.totals;
  const hero = h("section", { class: "card pad hero" },
    h("div", {}, h("div", { class: "muted" }, `Verified rate · last ${o.days} days`), h("div", { class: "num " + (o.verified_rate_pct ? "green" : "amber") }, pct(o.verified_rate_pct))),
    h("div", { class: "stack", style: "gap:4px" },
      h("div", {}, `${t.passed} verified · ${t.completed_unverified} done (unverified) · ${t.blocked} blocked · ${t.abandoned} abandoned · ${t.failed + t.reverted} failed a check`),
      t.n && o.checked_runs === 0 ? h("div", { class: "amber" }, "None of your delegations had a check, so nothing is verified. Add one: ",
        h("span", { class: "mono" }, "loop verify --check"), " or ", h("span", { class: "mono" }, "crew --check"), ".") : null),
    h("div", { class: "grow" }), sparkline(o.trend));
  const classes = [...new Set(o.matrix.map((m) => m.task_class || "?"))].sort();
  const rowsKey = [...new Set(o.matrix.map((m) => `${m.lane || "?"}\u001f${m.model || "?"}`))];
  const cellOf = (rk, c) => o.matrix.find((m) => `${m.lane || "?"}\u001f${m.model || "?"}` === rk && (m.task_class || "?") === c);
  const grid = h("div", { class: "heat", style: `grid-template-columns: minmax(88px, 220px) repeat(${classes.length}, minmax(78px, 1fr))` },
    h("span", {}), classes.map((c) => h("span", { class: "hl" }, c)),
    rowsKey.map((rk) => [h("span", { class: "hl mono", title: rk.replace("\u001f", " · ") }, rk.replace("\u001f", " · ")),
      classes.map((c) => {
        const m = cellOf(rk, c);
        if (!m) return h("div", { class: "cell none", "aria-label": "no runs" }, h("span", { class: "faint" }, "—"));
        const key = rk + "\u001f" + c, b = m.blocked_pct || 0;
        return h("button", { class: "cell" + (m.n < 5 ? " low" : ""), type: "button", "aria-pressed": String(outSel === key),
          style: `background: rgba(244,112,103,${(0.04 + (0.4 * b) / 100).toFixed(2)})`,
          title: `${rk.replace("\u001f", " · ")} on ${c}: done ${pct(m.done_pct)} (verified ${pct(m.verified_pct)}), blocked ${pct(m.blocked_pct)}, n=${m.n}${m.n < 5 ? " (too few to judge)" : ""}`,
          onclick: () => { outSel = key; refresh(); } },
          h("span", { class: "d" }, pct(m.done_pct)), h("span", { class: "small muted" }, `blocked ${pct(m.blocked_pct)}`), h("span", { class: "small faint" }, `n=${m.n}`));
      })]));
  let side = h("p", { class: "muted" }, "Pick a cell to see why runs got blocked.");
  if (outSel) {
    const [lane, model, c] = outSel.split("\u001f"), m = cellOf(`${lane}\u001f${model}`, c);
    if (m) side = h("div", { class: "stack", style: "gap:8px" }, h("h2", {}, `${lane} · ${model} · ${c}`),
      h("p", { class: "muted" }, `Done ${pct(m.done_pct)} (verified ${pct(m.verified_pct)}) · blocked ${pct(m.blocked_pct)} · n=${m.n}`),
      m.blocked_reasons.length ? h("ul", {}, m.blocked_reasons.map((r) => h("li", {}, `${r.reason} `, h("span", { class: "faint" }, `×${r.n}`)))) : h("p", { class: "faint" }, "No blocked runs."),
      model !== "?" ? h("div", { style: "display:flex;gap:6px" }, runBtn("Exclude this model", ["outsourcerer", "exclude", "add", model]), copyBtn(["outsourcerer", "exclude", "add", model])) : null);
  }
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Outcomes"), h("p", { class: "sub" }, "Did finished work get verified, or did the model just say done?"))),
    hero, h("div", { style: "height:16px" }),
    h("div", { class: "cols" }, h("section", { class: "card pad wide" }, h("h2", { style: "margin-bottom:10px" }, "Lane × model × task class"),
      o.matrix.length ? h("div", { class: "tbl" }, grid) : h("p", { class: "muted" }, "No outcome rows yet.")),
      h("aside", { class: "card pad side" }, side)));
} };
function sparkline(trend) {
  if (!trend || trend.length < 2) return h("span", { class: "faint small" }, "Trend appears after two weeks of runs.");
  const W = 220, H = 48, pts = trend.map((t, i) => [(i / (trend.length - 1)) * W, H - ((t.verified_rate_pct || 0) / 100) * H]);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H + 2); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Verified rate per week: " + trend.map((t) => pct(t.verified_rate_pct)).join(", "));
  const path = document.createElementNS(ns, "polyline");
  path.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
  path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5");
  svg.append(path);
  return h("div", { class: "muted" }, svg);
}

// ---- 5 · Plans -----------------------------------------------------------------------------------------------------
let planSel = null;
SCREENS.plans = { every: 10, async render(v) {
  const d = await many(["plans", "land-queue", "flows"]);
  if (failed(d.plans)) return put(v, errBox("plans", d.plans));
  const plans = d.plans.plans;
  $("b-plans").textContent = String(plans.length);
  if (!planSel || !plans.find((p) => p.name === planSel)) planSel = d.plans.current || (plans[0] && plans[0].name) || null;
  const list = h("section", { class: "card" }, h("div", { class: "pad" }, h("h2", {}, "Plans")),
    plans.length ? h("div", { class: "rows" }, plans.map((p) => h("button", { type: "button", class: "row", style: `border:0;border-bottom:1px solid var(--bd);background:${p.name === planSel ? "var(--s2)" : "transparent"};text-align:left;cursor:pointer;padding-left:16px`,
      onclick: () => { planSel = p.name; refresh(); } },
      h("div", { class: "body" }, h("span", { class: "title" }, p.name, p.current ? h("span", { class: "faint" }, "  · current") : null), h("span", { class: "muted small" }, nz(p.goal, "")),
        h("span", { class: "faint small" }, Object.entries(p.counts).map(([k, n]) => `${n} ${k}`).join(" · ") || "no tasks"))))) : h("p", { class: "pad muted" }, "No plans yet. Make one with outsourcerer plan new <name> --goal \"…\""));
  let graph = h("p", { class: "muted" }, "Pick a plan.");
  if (planSel) {
    const pd = await many([`plan/${planSel}`]);
    const ps = pd[`plan/${planSel}`];
    graph = failed(ps) ? errBox("plan", ps) : dag(ps);
  }
  const lq = failed(d["land-queue"]) ? errBox("land queue", d["land-queue"]) : h("section", { class: "card pad stack", style: "gap:8px" }, h("h2", {}, "Land queue"),
    d["land-queue"].merging.map((m) => h("div", {}, h("span", { class: "dot purple" }), " merging: ", nz(m.holder))),
    d["land-queue"].waiting.length ? d["land-queue"].waiting.map((w, i) => h("div", { class: "row", style: "padding-left:0" }, h("div", { class: "body" },
      h("span", {}, `${i + 1}. `, nz(w.title, w.task), h("span", { class: "faint" }, `  ${w.plan}/${w.task}`)),
      h("span", { class: "mono faint small" }, `${nz(w.branch)} → ${nz(w.into)}`),
      h("span", { class: "small " + (w.land_error ? "red" : !w.check ? "amber" : w.check.rc === 0 ? "" : "red") },
        w.land_error ? "Last land failed: " + w.land_error : !w.check ? "No check recorded: lands as unverified" : w.check.rc === 0 ? "Check passed (" + w.check.cmd + ")" : `Check failed (rc ${w.check.rc}): will not land`)))) : h("p", { class: "muted" }, "Nothing waiting to land."));
  const flows = failed(d.flows) ? null : h("section", { class: "card pad stack", style: "gap:6px" }, h("h2", {}, "Flows"),
    d.flows.flows.map((f) => h("div", {}, h("span", { class: "mono" }, f.name), h("span", { class: "faint small" }, ` · ${f.source} · ${nz(f.stages, "?")} stages`), h("div", { class: "muted small" }, nz(f.description, "")))));
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Plans"), h("p", { class: "sub" }, "Multi-step builds: advisors, build, review, land."))),
    h("div", { class: "cols" }, h("div", { class: "wide stack" }, h("section", { class: "card pad" }, graph)), h("div", { class: "side stack" }, list, lq, flows)));
} };
function dag(ps) {
  const tasks = ps.tasks || [];
  if (!tasks.length) return h("p", { class: "muted" }, "This plan has no tasks yet.");
  const cols = {};
  tasks.forEach((t) => { (cols[t.depth || 0] = cols[t.depth || 0] || []).push(t); });
  const now = Date.now() / 1000;
  return h("div", { class: "stack" }, h("h2", {}, ps.plan.name, h("span", { class: "faint" }, "  " + nz(ps.plan.goal, ""))),
    h("div", { class: "dag" }, Object.keys(cols).sort((a, b) => a - b).map((k) => h("div", { class: "col" }, cols[k].map((t) => {
      const held = t.state === "held", hold = t.hold || {};
      const cls = held ? "held" : t.state === "failed" ? "failed" : (t.state === "running" || t.state === "verifying") ? "running" : "";
      return h("div", { class: "node " + cls },
        h("div", { style: "display:flex;gap:6px;align-items:baseline" }, h("span", { class: "mono faint" }, t.id), h("span", { class: "grow", style: "font-weight:500" }, nz(t.title, t.id)),
          h("span", { class: "badge2" }, nz(t.shape, "scout"))),
        h("div", { class: "small muted" }, nz(t.derived, t.state), t.model ? h("span", { class: "mono" }, " · " + t.model) : null,
          t.attempts ? ` · ${t.attempts} attempts` : "", t.landed ? h("span", { class: "amber" }, " · landed") : null),
        (t.deps || []).length ? h("div", { class: "small faint" }, "after " + t.deps.join(", ")) : null,
        held ? [h("div", { class: "small" }, nz(hold.reason, "Needs a decision")),
          hold.default ? h("div", { class: "small amber" }, `Default: ${hold.default}` + (hold.until_epoch ? ` in ${ago(hold.until_epoch - now)}` : "")) : null,
          h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, actionButtons({ title: t.title, primary_action: { label: "Answer", input: "answer",
            argv: ["outsourcerer", "task", "release", t.id, "--plan", ps.plan.name, "--answer", "{answer}"] },
            secondary_action: hold.default ? { label: "Use default", argv: ["outsourcerer", "task", "release", t.id, "--plan", ps.plan.name, "--answer", hold.default] } : null }))] : null);
    })))));
}

// ---- 6 · New delegation --------------------------------------------------------------------------------------------
// One-shot and Loop launch from here (allow-listed `bg` / `loop verify` shapes); fanout, crew and second opinion stay
// copy-a-command for now. advise + estimate recommend a lane before you launch.
let delTask = "", delShape = "bg", delVerb = "edit", delModel = "", delWt = true, delCheck = "", delMax = "4", delMin = "20", delOut = null;
function delArgv() {
  const t = delTask.trim(), m = delModel.trim();
  if (delShape === "loop") {
    const v = delVerb === "yolo" ? "yolo" : "edit";
    return ["outsourcerer", "loop", "verify", ...(m ? ["-m", m] : []), "--check", delCheck.trim() || "<check command>", "--verb", v,
      "--max", delMax || "4", "--max-minutes", delMin || "20", ...(delWt ? ["--worktree"] : []), "--", t || "<task>"];
  }
  if (delShape === "fanout") return ["outsourcerer", "fanout", "--verb", delVerb, "--", t || "<task>"];
  if (delShape === "crew") return ["outsourcerer", "crew", "--check", delCheck.trim() || "<check command>", "--", t || "<task>", t || "<task>", t || "<task>"];
  if (delShape === "second") return ["outsourcerer", "second-opinion", t || "<task>"];
  return ["outsourcerer", "bg", ...(delWt ? ["--worktree"] : []), delVerb, ...(m ? ["-m", m] : []), t || "<task>"];
}
SCREENS.delegate = { every: 3600, async render(v) {
  const shapes = { bg: "One-shot", loop: "Loop (until a check passes)", fanout: "Fanout", crew: "Crew (N writers, keep best)", second: "Second opinion" };
  const verbs = { run: "Read-only", research: "Sandboxed", edit: "Edits", yolo: "Yolo" };
  const launchable = delShape === "bg" || delShape === "loop";
  const pre = h("div", { class: "log" });
  const goBtn = h("button", { class: "pbtn", type: "button" }, delVerb === "yolo" ? "Launch (yolo: all tools, no sandbox)" : "Launch");
  function sync() {
    const argv = delArgv(); pre.textContent = cmdline(argv); pre.dataset.cmd = cmdline(argv);
    const missing = !delTask.trim() ? "Describe the task first" : delTask.trim().startsWith("-") ? "The task cannot start with -"
      : (delShape === "loop" && !delCheck.trim()) ? "A loop needs a check command" : "";
    goBtn.disabled = !launchable || !!missing; goBtn.title = !launchable ? "This shape is copy-only for now" : missing || "Runs: " + cmdline(argv);
  }
  const field = (label, el) => h("label", { class: "stack", style: "gap:4px" }, h("span", { class: "muted small" }, label), el);
  const ta = h("textarea", { "aria-label": "Task", placeholder: "Describe the task…", oninput: (e) => { delTask = e.target.value; sync(); } }); ta.value = delTask;
  const model = h("input", { type: "text", placeholder: "default (let routing pick)", "aria-label": "Model", oninput: (e) => { delModel = e.target.value; sync(); } }); model.value = delModel;
  const wt = h("input", { type: "checkbox", "aria-label": "Run in its own git worktree", onchange: (e) => { delWt = e.target.checked; sync(); } }); wt.checked = delWt;
  const check = h("input", { type: "text", placeholder: "e.g. npm test", "aria-label": "Check command", style: "width:100%", oninput: (e) => { delCheck = e.target.value; sync(); } }); check.value = delCheck;
  const mx = h("input", { type: "text", size: 3, "aria-label": "Max attempts", oninput: (e) => { delMax = e.target.value.replace(/\D/g, ""); sync(); } }); mx.value = delMax;
  const mm = h("input", { type: "text", size: 3, "aria-label": "Max minutes", oninput: (e) => { delMin = e.target.value.replace(/\D/g, ""); sync(); } }); mm.value = delMin;
  const rerender = () => SCREENS.delegate.render($("view"));
  const seg = (obj, cur, set) => h("div", { class: "tabs" }, Object.entries(obj).map(([k, l]) => h("button", { class: "tab", type: "button", "aria-selected": String(k === cur),
    onclick: () => { set(k); rerender(); } }, l)));
  goBtn.addEventListener("click", () => { const argv = delArgv(); runAction(argv, goBtn); });
  const ask = h("button", { class: "btn", type: "button", onclick: async () => {
    if (!delTask.trim()) return toast("Describe the task first");
    ask.disabled = true; ask.textContent = "Asking advise and estimate…";
    const q = encodeURIComponent(delTask.trim());
    delOut = await many([`advise?task=${q}`, `estimate?task=${q}`]); delOut.q = q;
    ask.disabled = false; if (current === "delegate") rerender();
  } }, "Recommend a lane");
  let res = null;
  if (delOut) {
    const a = delOut[`advise?task=${delOut.q}`], e = delOut[`estimate?task=${delOut.q}`];
    res = h("div", { class: "stack" },
      failed(a) ? errBox("advise", a) : h("section", { class: "card pad stack", style: "gap:6px" }, h("h2", {}, "Recommendation"),
        h("p", {}, h("span", { class: "mono" }, `${nz(a.recommendation.lane)} · ${nz(a.recommendation.model)}`), h("span", { class: "muted" }, `  ${a.category} · ${a.difficulty} · effort ${a.effort}`)),
        h("p", { class: "muted small" }, nz(a.recommendation.reason, "")), a.conservation ? h("p", { class: "amber small" }, a.conservation) : null,
        a.recommendation.model ? h("button", { class: "btn small", type: "button", onclick: () => { delModel = a.recommendation.model; rerender(); } }, `Use ${a.recommendation.model}`) : null,
        h("div", { class: "tbl" }, h("table", { style: "min-width:0" }, h("thead", {}, h("tr", {}, ["Lane", "Model", "Score", "Meets bar", ""].map((c) => h("th", {}, c)))),
          h("tbody", {}, (a.shortlist || []).slice(0, 8).map((s) => h("tr", {}, h("td", {}, s.lane), h("td", { class: "mono" }, s.model), h("td", { class: "mono" }, nz(s.score)), h("td", {}, s.meets ? "yes" : "no"),
            h("td", {}, h("button", { class: "ghost small", type: "button", onclick: () => { delModel = s.model; rerender(); } }, "Use")))))))),
      failed(e) ? errBox("estimate", e) : h("section", { class: "card pad stack", style: "gap:6px" }, h("h2", {}, "Cost"),
        h("p", { class: "muted" }, `${e.prompt_tokens} prompt tokens · opus would cost ≈ $${Number(e.counterfactual_opus_usd).toFixed(2)}`),
        (e.plan_lanes || []).map((p) => h("div", { class: "small" }, h("span", { class: "mono" }, p.lane), `  ${p.label}: ${p.cost}`)),
        (e.cash_chain || []).map((c) => h("div", { class: "small" }, h("span", { class: "mono" }, c.model), `  ≈ $${c.usd === null ? "?" : c.usd.toFixed(3)} cash`))));
  }
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "New delegation"),
      h("p", { class: "sub" }, "Describe the work, pick how it runs, and launch it. It shows up in Live."))),
    h("div", { class: "cols" }, h("div", { class: "wide stack" }, ta,
      field("Shape", seg(shapes, delShape, (k) => { delShape = k; })),
      field("Access", seg(verbs, delVerb, (k) => { delVerb = k; })),
      h("div", { style: "display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end" },
        field("Model", model),
        h("label", { style: "display:flex;gap:6px;align-items:center" }, wt, h("span", {}, "Own git worktree"))),
      delShape === "loop" || delShape === "crew" ? field("Check (must pass for the work to count)", check) : null,
      delShape === "loop" ? h("div", { style: "display:flex;gap:16px;flex-wrap:wrap" }, field("Max attempts", mx), field("Max minutes", mm)) : null,
      delShape === "loop" && delVerb !== "edit" && delVerb !== "yolo" ? h("p", { class: "faint small" }, "A loop writes files, so it runs with Edits access.") : null,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, goBtn, ask, h("button", { class: "btn", type: "button", onclick: () => copy(pre.dataset.cmd) }, "Copy command")),
      !launchable ? h("p", { class: "faint small" }, "This shape is copy-only for now: run the command in your lead session.") : null,
      h("p", { class: "faint small" }, "Cloud lanes need cloud consent (Settings). Yolo asks for a second click."),
      pre),
      h("div", { class: "side" }, res || h("p", { class: "muted" }, "Ask for a recommendation to see the best lane, its score and the cost."))));
  sync();
} };

// ---- 7 · Lanes ------------------------------------------------------------------------------------------------------
SCREENS.lanes = { every: 120, async render(v) {
  const d = await many(["doctor", "exclude", "limits", "posture"]);
  if (failed(d.doctor)) return put(v, errBox("doctor", d.doctor));
  const doc = d.doctor;
  $("b-lanes").textContent = `${doc.summary.ready}/${doc.summary.lanes}`;
  $("ver").textContent = `v${doc.version}`;
  const st = (l) => l.down ? ["red", "down" + (l.down_reason ? " · " + l.down_reason : "")] : l.ready ? ["green", "ready" + (l.detail ? " · " + l.detail : "")]
    : l.installed === false ? ["gray", "not installed"] : ["amber", "not ready"];
  const table = h("section", { class: "card tbl" }, h("table", {}, h("thead", {}, h("tr", {}, ["Lane", "Runs via", "Cost", "State", "Postures"].map((c) => h("th", {}, c)))),
    h("tbody", {}, doc.lanes.map((l) => { const [c, txt] = st(l); return h("tr", { style: l.installed === false ? "opacity:.7" : null },
      h("td", { class: "mono" }, l.lane), h("td", { class: "mono small muted" }, l.cli.join(" / ") || "(another lane's transport)"),
      h("td", { class: "small" + (l.cost_class === "credits" ? " amber" : "") }, nz(l.cost_disclosure)),
      h("td", {}, h("span", { class: "dot-label" }, h("span", { class: "dot " + c }), txt)),
      h("td", { class: "mono small" }, l.postures.map((p) => `${p.key}=${p.value}`).join(", ") || "—")); }))));
  const ex = failed(d.exclude) ? errBox("exclude", d.exclude) : h("section", { class: "card pad stack", style: "gap:8px" }, h("h2", {}, "Never use"),
    h("p", { class: "faint small" }, "Refused with -m and never auto-picked."),
    d.exclude.entries.length ? d.exclude.entries.map((e) => h("div", { style: "display:flex;gap:8px;align-items:center" }, h("span", { class: "mono grow" }, e.entry), h("span", { class: "faint small" }, e.source),
      e.source === "saved" ? runBtn("Remove", ["outsourcerer", "exclude", "rm", e.entry], "ghost small") : h("span", { class: "faint small" }, "set by env"))) : h("p", { class: "muted" }, "Nothing excluded."));
  const caps = failed(d.limits) ? errBox("limits", d.limits) : h("section", { class: "card pad stack", style: "gap:8px" }, h("h2", {}, "Daily caps"),
    d.limits.caps.length ? d.limits.caps.map((c) => { const p = c.per_day ? Math.min(100, Math.round((100 * (c.used_today || 0)) / c.per_day)) : 0;
      return h("div", { class: "stack", style: "gap:4px" }, h("div", { style: "display:flex;justify-content:space-between" }, h("span", { class: "mono" }, `${c.lane} ${c.model}`), h("span", { class: "mono" }, `${c.used_today || 0} / ${c.per_day}`)),
        h("div", { class: "bar" }, h("i", { class: p >= 90 ? "red" : p >= 70 ? "amber" : "", style: `width:${p}%` }))); }) : h("p", { class: "muted" }, "No caps set."));
  const post = failed(d.posture) ? errBox("posture", d.posture) : h("section", { class: "card pad stack", style: "gap:8px" }, h("h2", {}, "Remembered postures"),
    h("p", { class: "faint small" }, "What a lane refused before (org policy, a lane-down mark). The next restricted attempt is re-probed after a reset."),
    d.posture.postures.length ? [d.posture.postures.map((p) => h("div", { class: "mono small" }, `${p.lane}.${p.key} = ${p.value}`)),
      h("div", {}, runBtn("Reset postures", ["outsourcerer", "posture", "reset"]))] : h("p", { class: "muted" }, "Nothing remembered."));
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Lanes"), h("p", { class: "sub" }, `${doc.summary.ready} of ${doc.summary.lanes} ready · ${doc.summary.down} down`))),
    h("div", { class: "cols" }, h("div", { class: "wide" }, table), h("div", { class: "side stack" }, ex, caps, post)));
} };

// ---- 8 · Settings ---------------------------------------------------------------------------------------------------
SCREENS.settings = { every: 30, async render(v) {
  const d = await many(["mode", "consent", "tap", "heartbeat", "doctor"]);
  const sec = (title, sub, ...kids) => h("section", { class: "cols", style: "padding:20px 0;border-top:1px solid var(--bd)" },
    h("div", { class: "side" }, h("h2", {}, title), h("p", { class: "faint small" }, sub)), h("div", { class: "wide stack", style: "gap:8px" }, ...kids));
  const modes = [["auto", "Auto-pilot"], ["hybrid", "Hybrid"], ["manual", "You-drive"]];
  put(v, h("h1", { style: "margin-bottom:16px" }, "Settings"),
    sec("Driving mode", "How much Outsourcerer delegates without asking.", failed(d.mode) ? errBox("mode", d.mode) : [h("p", {}, d.mode.meaning),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, modes.map(([k, l]) => k === d.mode.mode
        ? h("button", { class: "pbtn small", type: "button", "aria-pressed": "true", disabled: true }, l + " (current)")
        : runBtn(l, ["outsourcerer", "mode", k])))]),
    sec("Cloud consent", "Sending code to a cloud lane. The secret scan still runs on every delegation.", failed(d.consent) ? errBox("consent", d.consent)
      : h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, h("span", { class: "dot-label" }, h("span", { class: "dot " + (d.consent.granted ? "green" : "gray") }), d.consent.granted ? `Granted ${nz(d.consent.granted_at, "")}` : "Not granted"),
        d.consent.granted ? runBtn("Revoke", ["outsourcerer", "consent", "revoke"]) : runBtn("Grant", ["outsourcerer", "consent", "grant"]))),
    sec("Limits tap", "Reads live Claude limits from the statusline so Fuel is not a guess.", failed(d.tap) ? errBox("tap", d.tap)
      : h("p", {}, d.tap.installed ? `Installed · last reading ${ago(d.tap.reading_age_s)} ago` : "Not installed. ", d.tap.installed ? null :
        runBtn("Install the tap", ["outsourcerer", "tap", "install"]))),
    sec("Supervision", "The heartbeat watches delegated runs while you are away.", failed(d.heartbeat) ? errBox("heartbeat", d.heartbeat)
      : h("p", {}, d.heartbeat.armed ? `Armed (pid ${d.heartbeat.pid})` : "Not armed. ", d.heartbeat.armed ? null :
        runBtn("Arm the heartbeat", ["outsourcerer", "heartbeat", "start"]))),
    sec("This dashboard", "Local only. No telemetry.", h("dl", { class: "facts" },
      h("dt", {}, "Address"), h("dd", { class: "mono" }, location.host),
      h("dt", {}, "Token"), h("dd", { class: "mono" }, failed(d.doctor) ? "<state home>/dash/token" : `${d.doctor.state_home.path}/dash/token (0600)`),
      h("dt", {}, "Actions"), h("dd", {}, "Buttons run one allow-listed command each (shown on hover); cancel and revoke ask twice."),
      h("dt", {}, "Version"), h("dd", { class: "mono" }, failed(d.doctor) ? "—" : d.doctor.version))));
} };

// ---- command palette (⌘K / Ctrl+K) ------------------------------------------------------------------------------------
// Every command is something the page can already do: go to a screen, open a run or session, or run one allow-listed
// action. Entries are built fresh from the data the page last fetched, so the palette never shows a stale action twice.
function themeToggle() {
  const dark = (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")) === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("osrc-theme", document.documentElement.dataset.theme); } catch (e) { /* storage blocked */ }
}
function paletteCommands() {
  const go = (r, label, hint) => ({ group: "Go to", title: label, sub: hint, keys: label + " " + r, run: () => { location.hash = r; } });
  const cmds = [
    go("needs", "Needs you", "what is blocked on you"), go("live", "Live runs", "jobs, sessions, groups, loops"),
    go("fuel", "Fuel", "limits and the Tab"), go("outcomes", "Outcomes", "verified rate, heatmap"),
    go("plans", "Plans", "graphs, decisions, land queue"), go("delegate", "New delegation", "advise + estimate"),
    go("lanes", "Lanes", "doctor, never-use, caps"), go("settings", "Settings", "mode, consent, tap"),
  ];
  const act = (group, title, argv, sub) => ({ group, title, sub: sub || cmdline(argv), keys: title + " " + argv.join(" "), argv,
    danger: DESTRUCTIVE(argv), run: () => runAction(argv) });
  const ib = cache.inbox;
  if (ib && ib.items) ib.items.forEach((it) => {
    const a = it.primary_action;
    if (a && a.input !== "answer") cmds.push(act("Needs you", `${a.label}: ${it.title}`, a.argv, kindLabel(it.kind) + (it.repo ? " · " + it.repo : "")));
    else if (a) cmds.push({ group: "Needs you", title: `Answer: ${it.title}`, sub: "opens the row to type your answer", keys: "answer " + it.title,
      run: () => { location.hash = "needs"; } });
    const sa = it.secondary_action;
    if (sa && sa.input !== "answer") cmds.push(act("Needs you", `${sa.label}: ${it.title}`, sa.argv));
    else if (sa) cmds.push({ group: "Needs you", title: `${sa.label}: ${it.title}`, sub: "opens the row to type it", keys: sa.label + " " + it.title,
      run: () => { location.hash = "needs"; } });
  });
  const st = cache.status;
  if (st && st.jobs) st.jobs.slice(0, 25).forEach((j) => cmds.push({ group: "Runs", title: `${nz(j.label, j.verb)} · ${nz(j.provider)} ${nz(j.model, "")}`,
    sub: `${j.status} · ${j.job_id}`, keys: [j.label, j.verb, j.provider, j.model, j.job_id, j.status, repoOf(j.cwd)].join(" "),
    run: () => { if (current !== "live") location.hash = "live"; setTimeout(() => openJob(j.job_id), current === "live" ? 0 : 400); } }));
  const fl = cache.fleet;
  // Live sessions first (most recent activity first); ended/dead ones are not worth a command. Registry
  // mirrors carry a generic summary ("external session"), so those are named by their id instead.
  const generic = /^(external|managed) session$/;
  const rank = (x) => (["blocked?", "blocked", "unresponsive?"].includes(x.state) ? 0 : x.state === "working" ? 1 : 2);
  if (fl && fl.items) fl.items.filter((x) => x.owner !== "managed" && (x.self || 0) === 0 && x.session_id && !["ended", "dead"].includes(x.state))
    .sort((a, b) => rank(a) - rank(b) || (a.status_age || 0) - (b.status_age || 0)).slice(0, 25).forEach((x) => {
      const name = [x.display_name, x.task_summary].find((n) => n && !generic.test(n)) || x.session_id;
      cmds.push(act("Sessions", `Read ${name}`, ["outsourcerer", "fleet", "show", x.session_id],
        `${nz(x.state_label || x.state)} · ${nz(repoOf(x.cwd), x.harness || "")}`));
    });
  const mode = cache.mode && cache.mode.mode;
  [["auto", "Auto-pilot"], ["hybrid", "Hybrid"], ["manual", "You-drive"]].forEach(([k, l]) => { if (k !== mode) cmds.push(act("Actions", `Switch mode to ${l}`, ["outsourcerer", "mode", k])); });
  if (cache.heartbeat && !cache.heartbeat.armed) cmds.push(act("Actions", "Arm the heartbeat", ["outsourcerer", "heartbeat", "start"], "supervise runs while you are away"));
  if (cache.tap && !cache.tap.installed) cmds.push(act("Actions", "Install the limits tap", ["outsourcerer", "tap", "install"], "live Claude limits for Fuel"));
  cmds.push({ group: "Actions", title: "Toggle light / dark theme", sub: "", keys: "theme light dark", run: themeToggle });
  cmds.push({ group: "Actions", title: "Refresh now", sub: "", keys: "refresh reload", run: () => refresh() });
  return cmds;
}
// Fuzzy match: every query character in order; earlier, contiguous and word-start hits score higher.
function fuzzy(q, text) {
  const t = text.toLowerCase(); let score = 0, ti = 0, prev = -2; const hits = [];
  for (const ch of q.toLowerCase()) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti); if (i < 0) return null;
    score += (i === prev + 1 ? 6 : 1) + (i === 0 || /[\s·:/_-]/.test(t[i - 1]) ? 4 : 0) - Math.min(i, 30) * 0.02;
    hits.push(i); prev = i; ti = i + 1;
  }
  return { score, hits };
}
function marked(text, hits) {
  const set = new Set(hits); const out = []; let buf = "", on = false;
  [...text].forEach((c, i) => { const m = set.has(i); if (m !== on) { if (buf) out.push(on ? h("mark", {}, buf) : buf); buf = ""; on = m; } buf += c; });
  if (buf) out.push(on ? h("mark", {}, buf) : buf);
  return out;
}
const pal = { open: false, all: [], shown: [], sel: 0, armed: -1, last: null };
function paletteOpen() {
  pal.open = true; pal.all = paletteCommands(); pal.sel = 0; pal.armed = -1; pal.last = document.activeElement;
  $("palette").hidden = false; $("palette-input").value = ""; paletteRender(); $("palette-input").focus();
  // Sessions and the tap state may not have been fetched yet (they load with Live / Settings): fetch them now,
  // then rebuild the list without moving the selection the user already has.
  many(["fleet", "tap", "inbox", "status", "mode", "heartbeat"]).then(() => { if (pal.open) { pal.all = paletteCommands(); paletteRender(); } });
}
function paletteClose() { pal.open = false; $("palette").hidden = true; if (pal.last && pal.last.focus) pal.last.focus(); }
function paletteRender() {
  const q = $("palette-input").value.trim();
  pal.shown = q ? pal.all.map((c) => { const m = fuzzy(q, c.title) || fuzzy(q, c.keys); return m ? { c, m, t: fuzzy(q, c.title) } : null; })
    .filter(Boolean).sort((a, b) => b.m.score - a.m.score).slice(0, 40) : pal.all.slice(0, 60).map((c) => ({ c, m: null, t: null }));
  if (pal.sel >= pal.shown.length) pal.sel = Math.max(0, pal.shown.length - 1);
  const list = $("palette-list"), nodes = []; let group = null;
  pal.shown.forEach((r, i) => {
    if (!q && r.c.group !== group) { group = r.c.group; nodes.push(h("div", { class: "palette-group", role: "presentation" }, group)); }
    nodes.push(h("div", { class: "palette-item" + (pal.armed === i ? " armed" : ""), role: "option", id: "pal-" + i, "aria-selected": String(i === pal.sel),
      onmousemove: () => { if (pal.sel !== i) { pal.sel = i; paletteRender(); } }, onclick: () => { pal.sel = i; paletteRun(); } },
      h("span", { class: "pt" }, pal.armed === i ? "Press Enter again to confirm: " : "", r.t ? marked(r.c.title, r.t.hits) : r.c.title),
      q ? h("span", { class: "ps" }, r.c.group) : null, h("span", { class: "ps" }, r.c.sub || "")));
  });
  put(list, nodes.length ? nodes : h("div", { class: "palette-empty" }, "No command matches."));
  $("palette-input").setAttribute("aria-activedescendant", pal.shown.length ? "pal-" + pal.sel : "");
  const el = $("pal-" + pal.sel); if (el) el.scrollIntoView({ block: "nearest" });
}
function paletteRun() {
  const r = pal.shown[pal.sel]; if (!r) return;
  if (r.c.danger && pal.armed !== pal.sel) { pal.armed = pal.sel; paletteRender(); return; }   // cancel / revoke / reset ask twice
  paletteClose(); r.c.run();
}
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.open ? paletteClose() : paletteOpen(); return; }
  if (!pal.open) return;
  if (e.key === "Escape") { e.preventDefault(); paletteClose(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); pal.sel = Math.min(pal.shown.length - 1, pal.sel + 1); pal.armed = -1; paletteRender(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); pal.sel = Math.max(0, pal.sel - 1); pal.armed = -1; paletteRender(); }
  else if (e.key === "Enter") { e.preventDefault(); paletteRun(); }
});
$("palette-input").addEventListener("input", () => { pal.sel = 0; pal.armed = -1; paletteRender(); });
$("palette").addEventListener("mousedown", (e) => { if (e.target === $("palette")) paletteClose(); });
$("palette-btn").addEventListener("click", paletteOpen);

// ---- theme + boot ------------------------------------------------------------------------------------------------------
(function theme() {
  let t = null;
  try { t = localStorage.getItem("osrc-theme"); } catch (e) { /* storage blocked */ }
  if (t) document.documentElement.dataset.theme = t;
  $("theme").addEventListener("click", themeToggle);
})();
route();
