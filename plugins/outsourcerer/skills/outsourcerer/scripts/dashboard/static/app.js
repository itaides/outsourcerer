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

// ---- data ------------------------------------------------------------------------------------------
const cache = {};
async function api(path) {
  const r = await fetch("/api/" + path, { credentials: "same-origin", cache: "no-store" });
  const ctype = r.headers.get("content-type") || "";
  const body = ctype.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error((body && body.error) || `HTTP ${r.status}`), { body, status: r.status });
  cache[path] = body;
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
    const label = { auto: "Auto-pilot", hybrid: "Hybrid", manual: "You-drive" }[d.mode.mode] || d.mode.mode;
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
    if (current === name) put($("view"), [...off.childNodes]);
  } catch (e) { if (current === name) put($("view"), h("div", { class: "err" }, "Could not load: " + e.message)); }
  if (current === name) timer = setTimeout(refresh, (scr.every || 10) * 1000);
}
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

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
      title: "Copies the exact command: " + cmdline(a.argv),
      onclick: () => {
        let argv = a.argv;
        if (needsInput) {
          const field = btn.parentElement.querySelector("input");
          const v = field && field.value.trim();
          if (!v) { field && field.focus(); toast("Type your answer first"); return; }
          argv = argv.map((x) => (x === "{answer}" ? v : x));
        }
        copy(cmdline(argv));
      } }, a.label);
    if (needsInput) out.push(h("input", { type: "text", placeholder: "your answer", "aria-label": "Answer for " + item.title, size: 18 }));
    out.push(btn);
  };
  one(item.primary_action, true);
  one(item.secondary_action, false);
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
    h("p", { class: "sub" }, ib.counts.items ? `${ib.counts.items} items · ${ib.counts.red} blocking work` : "All clear")));
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
  const d = await many(["status", "inbox", "loops"]);
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
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Live runs"),
    h("p", { class: "sub" }, `${jobs.filter(isLive).length} running · ${needIds.size} need you · ${d.status.omitted || 0} older not shown`))), tabs, table, loopCard);
  if (drawerFor) openJob(drawerFor, true);
} };

let drawerFor = null;
function closeDrawer() { drawerFor = null; $("drawer").hidden = true; $("drawer").replaceChildren(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) closeDrawer(); });
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
      !terminal ? h("button", { class: "btn small", type: "button", onclick: () => copy(cmdline(["outsourcerer", "watch", id])) }, "Copy: watch") : null,
      !terminal ? h("button", { class: "btn small", type: "button", onclick: () => copy(cmdline(["outsourcerer", "cancel", id])) }, "Copy: cancel") : null,
      h("button", { class: "btn small", type: "button", onclick: () => copy(cmdline(["outsourcerer", "result", id])) }, "Copy: result")));
}
async function openLoop(l) {
  drawerFor = null;
  const d = await many([`loop/${l.loop_id}`]);
  const x = failed(d[`loop/${l.loop_id}`]) ? l : (d[`loop/${l.loop_id}`].loops[0] || l);
  const sr = x.stop_rules;
  drawerShell(nz(x.task), x.loop_id,
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
  const grid = h("div", { class: "heat", style: `grid-template-columns: minmax(140px, 220px) repeat(${classes.length}, minmax(96px, 1fr))` },
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
      model !== "?" ? h("button", { class: "btn small", type: "button", onclick: () => copy(cmdline(["outsourcerer", "exclude", "add", model])) }, "Exclude this model (copy command)") : null);
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
let delTask = "", delShape = "bg", delVerb = "edit", delOut = null;
SCREENS.delegate = { every: 3600, async render(v) {
  const shapes = { bg: "One-shot", loop: "Loop (until a check passes)", fanout: "Fanout", crew: "Crew (N writers, keep best)", second: "Second opinion" };
  const verbs = { run: "Read-only", research: "Sandboxed", edit: "Edits", yolo: "Yolo" };
  const ta = h("textarea", { "aria-label": "Task", placeholder: "Describe the task…", oninput: (e) => { delTask = e.target.value; preview(); } });
  ta.value = delTask;
  const pre = h("div", { class: "log" });
  function preview() {
    const t = delTask.trim() || "<task>";
    const argv = delShape === "loop" ? ["outsourcerer", "loop", "verify", "--check", "<check command>", "--verb", delVerb === "run" || delVerb === "research" ? "edit" : delVerb, "--worktree", t]
      : delShape === "fanout" ? ["outsourcerer", "fanout", "--verb", delVerb, "--", t]
      : delShape === "crew" ? ["outsourcerer", "crew", "--check", "<check command>", "--", t, t, t]
      : delShape === "second" ? ["outsourcerer", "second-opinion", t]
      : ["outsourcerer", "bg", delVerb, t];
    pre.textContent = cmdline(argv); pre.dataset.cmd = cmdline(argv);
  }
  preview();
  const seg = (obj, cur, set) => h("div", { class: "tabs" }, Object.entries(obj).map(([k, l]) => h("button", { class: "tab", type: "button", "aria-selected": String(k === cur),
    onclick: () => { set(k); SCREENS.delegate.render($("view")); } }, l)));
  const go = h("button", { class: "pbtn", type: "button", onclick: async () => {
    if (!delTask.trim()) return toast("Describe the task first");
    go.disabled = true; go.textContent = "Asking advise and estimate…";
    const q = encodeURIComponent(delTask.trim());
    delOut = await many([`advise?task=${q}`, `estimate?task=${q}`]); delOut.q = q;
    go.disabled = false; if (current === "delegate") SCREENS.delegate.render($("view"));
  } }, "Recommend a lane");
  let res = null;
  if (delOut) {
    const a = delOut[`advise?task=${delOut.q}`], e = delOut[`estimate?task=${delOut.q}`];
    res = h("div", { class: "stack" },
      failed(a) ? errBox("advise", a) : h("section", { class: "card pad stack", style: "gap:6px" }, h("h2", {}, "Recommendation"),
        h("p", {}, h("span", { class: "mono" }, `${nz(a.recommendation.lane)} · ${nz(a.recommendation.model)}`), h("span", { class: "muted" }, `  ${a.category} · ${a.difficulty} · effort ${a.effort}`)),
        h("p", { class: "muted small" }, nz(a.recommendation.reason, "")), a.conservation ? h("p", { class: "amber small" }, a.conservation) : null,
        h("div", { class: "tbl" }, h("table", { style: "min-width:0" }, h("thead", {}, h("tr", {}, ["Lane", "Model", "Score", "Meets bar"].map((c) => h("th", {}, c)))),
          h("tbody", {}, (a.shortlist || []).slice(0, 8).map((s) => h("tr", {}, h("td", {}, s.lane), h("td", { class: "mono" }, s.model), h("td", { class: "mono" }, nz(s.score)), h("td", {}, s.meets ? "yes" : "no"))))))),
      failed(e) ? errBox("estimate", e) : h("section", { class: "card pad stack", style: "gap:6px" }, h("h2", {}, "Cost"),
        h("p", { class: "muted" }, `${e.prompt_tokens} prompt tokens · opus would cost ≈ $${Number(e.counterfactual_opus_usd).toFixed(2)}`),
        (e.plan_lanes || []).map((p) => h("div", { class: "small" }, h("span", { class: "mono" }, p.lane), `  ${p.label}: ${p.cost}`)),
        (e.cash_chain || []).map((c) => h("div", { class: "small" }, h("span", { class: "mono" }, c.model), `  ≈ $${c.usd === null ? "?" : c.usd.toFixed(3)} cash`))));
  }
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "New delegation"), h("p", { class: "sub" }, "Get a recommendation and the exact command. Run it in your lead session."))),
    h("div", { class: "cols" }, h("div", { class: "wide stack" }, ta, h("div", {}, h("div", { class: "muted small" }, "Shape"), seg(shapes, delShape, (k) => { delShape = k; })),
      h("div", {}, h("div", { class: "muted small" }, "Access"), seg(verbs, delVerb, (k) => { delVerb = k; })),
      h("div", { style: "display:flex;gap:8px" }, go, h("button", { class: "btn", type: "button", onclick: () => copy(pre.dataset.cmd) }, "Copy command")), pre),
      h("div", { class: "side" }, res || h("p", { class: "muted" }, "The recommendation and cost show here."))));
} };

// ---- 7 · Lanes ------------------------------------------------------------------------------------------------------
SCREENS.lanes = { every: 120, async render(v) {
  const d = await many(["doctor", "exclude", "limits", "tab"]);
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
      h("button", { class: "ghost small", type: "button", onclick: () => copy(cmdline(["outsourcerer", "exclude", "rm", e.entry])) }, "Copy: remove"))) : h("p", { class: "muted" }, "Nothing excluded."));
  const caps = failed(d.limits) ? errBox("limits", d.limits) : h("section", { class: "card pad stack", style: "gap:8px" }, h("h2", {}, "Daily caps"),
    d.limits.caps.length ? d.limits.caps.map((c) => { const p = c.per_day ? Math.min(100, Math.round((100 * (c.used_today || 0)) / c.per_day)) : 0;
      return h("div", { class: "stack", style: "gap:4px" }, h("div", { style: "display:flex;justify-content:space-between" }, h("span", { class: "mono" }, `${c.lane} ${c.model}`), h("span", { class: "mono" }, `${c.used_today || 0} / ${c.per_day}`)),
        h("div", { class: "bar" }, h("i", { class: p >= 90 ? "red" : p >= 70 ? "amber" : "", style: `width:${p}%` }))); }) : h("p", { class: "muted" }, "No caps set."));
  put(v, h("div", { class: "head" }, h("div", {}, h("h1", {}, "Lanes"), h("p", { class: "sub" }, `${doc.summary.ready} of ${doc.summary.lanes} ready · ${doc.summary.down} down`))),
    h("div", { class: "cols" }, h("div", { class: "wide" }, table), h("div", { class: "side stack" }, ex, caps)));
} };

// ---- 8 · Settings ---------------------------------------------------------------------------------------------------
SCREENS.settings = { every: 30, async render(v) {
  const d = await many(["mode", "consent", "tap", "heartbeat", "doctor"]);
  const sec = (title, sub, ...kids) => h("section", { class: "cols", style: "padding:20px 0;border-top:1px solid var(--bd)" },
    h("div", { class: "side" }, h("h2", {}, title), h("p", { class: "faint small" }, sub)), h("div", { class: "wide stack", style: "gap:8px" }, ...kids));
  const modes = [["auto", "Auto-pilot"], ["hybrid", "Hybrid"], ["manual", "You-drive"]];
  put(v, h("h1", { style: "margin-bottom:16px" }, "Settings"),
    sec("Driving mode", "How much Outsourcerer delegates without asking.", failed(d.mode) ? errBox("mode", d.mode) : [h("p", {}, d.mode.meaning),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, modes.map(([k, l]) => h("button", { class: k === d.mode.mode ? "pbtn small" : "btn small", type: "button",
        onclick: () => copy(cmdline(["outsourcerer", "mode", k])) }, l + (k === d.mode.mode ? " (current)" : ""))))]),
    sec("Cloud consent", "Sending code to a cloud lane. The secret scan still runs on every delegation.", failed(d.consent) ? errBox("consent", d.consent)
      : h("p", {}, h("span", { class: "dot-label" }, h("span", { class: "dot " + (d.consent.granted ? "green" : "gray") }), d.consent.granted ? `Granted ${nz(d.consent.granted_at, "")}` : "Not granted"))),
    sec("Limits tap", "Reads live Claude limits from the statusline so Fuel is not a guess.", failed(d.tap) ? errBox("tap", d.tap)
      : h("p", {}, d.tap.installed ? `Installed · last reading ${ago(d.tap.reading_age_s)} ago` : "Not installed. ", d.tap.installed ? null :
        h("button", { class: "btn small", type: "button", onclick: () => copy("outsourcerer tap install") }, "Copy: tap install"))),
    sec("Supervision", "The heartbeat watches delegated runs while you are away.", failed(d.heartbeat) ? errBox("heartbeat", d.heartbeat)
      : h("p", {}, d.heartbeat.armed ? `Armed (pid ${d.heartbeat.pid})` : "Not armed. ", d.heartbeat.armed ? null :
        h("button", { class: "btn small", type: "button", onclick: () => copy("outsourcerer heartbeat start") }, "Copy: heartbeat start"))),
    sec("This dashboard", "Local only. No telemetry.", h("dl", { class: "facts" },
      h("dt", {}, "Address"), h("dd", { class: "mono" }, location.host),
      h("dt", {}, "Token"), h("dd", { class: "mono" }, failed(d.doctor) ? "<state home>/dash/token" : `${d.doctor.state_home.path}/dash/token (0600)`),
      h("dt", {}, "Actions"), h("dd", {}, "Read-only: buttons copy the exact command."),
      h("dt", {}, "Version"), h("dd", { class: "mono" }, failed(d.doctor) ? "—" : d.doctor.version))));
} };

// ---- theme + boot ------------------------------------------------------------------------------------------------------
(function theme() {
  let t = null;
  try { t = localStorage.getItem("osrc-theme"); } catch (e) { /* storage blocked */ }
  if (t) document.documentElement.dataset.theme = t;
  $("theme").addEventListener("click", () => {
    const dark = (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")) === "dark";
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("osrc-theme", document.documentElement.dataset.theme); } catch (e) { /* ignore */ }
  });
})();
route();
