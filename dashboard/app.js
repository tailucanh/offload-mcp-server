// offload dashboard: polls the local dashboard server and renders jobs. No build step, no dependencies.
// Everything that comes from a job (task, report, file names) is untrusted text: it is only ever
// inserted as text nodes, or escaped before the small Markdown renderer adds its own tags.
// UI strings live in i18n.js; the language follows the browser and can be changed in the header.
"use strict";

const POLL_MS = 2000;
const FINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const PROBLEM = new Set(["failed", "timed_out", "interrupted"]);
const READ_TOOLS = new Set(["read_file", "view_file", "view_file_outline", "view_code_item"]);
const I18N = globalThis.OFFLOAD_I18N || { en: {} };

const state = {
  jobs: [],
  clockSkew: 0,
  selected: null,
  detail: null,
  filter: "all",
  search: "",
  tab: load("tab") || "timeline",
  lang: pickLanguage(),
  onlyUnread: false,
  live: { ok: null, key: "connecting" },
  rendered: { id: null, keys: {} }
};

// ---------- small helpers ----------

function load(key) {
  try { return localStorage.getItem(`offload.${key}`); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(`offload.${key}`, value); } catch { /* private mode */ }
}

/** Saved choice, else the first browser language we have, else English. */
function pickLanguage() {
  const saved = load("lang");
  if (saved && I18N[saved]) return saved;
  for (const tag of navigator.languages || [navigator.language || "en"]) {
    const lower = String(tag).toLowerCase();
    if (lower.startsWith("zh")) return /-(tw|hk|mo|hant)/.test(lower) ? "zh-TW" : "zh";
    if (lower.startsWith("pt")) return "pt-BR";
    const base = lower.split("-")[0];
    if (I18N[base]) return base;
  }
  return "en";
}

/** Translated string with {name} placeholders filled in; falls back to English, then to the key. */
function t(key, vars) {
  const text = (I18N[state.lang] && I18N[state.lang][key]) ?? I18N.en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all)) : text;
}

/** Like t(), but placeholders may be DOM nodes; returns an array of strings and nodes. */
function tNodes(key, nodes) {
  return t(key).split(/(\{\w+\})/g).map(part => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1] in nodes ? nodes[m[1]] : part;
  }).filter(part => part !== "");
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $ = id => document.getElementById(id);
const now = () => Date.now() + state.clockSkew;
const isActive = job => !FINAL.has(job.status) && !job.stale;
const shortId = id => id.slice(-6);
const statusKey = job => (job.stale ? "stale" : job.status);
const statusText = job => t(`st_${statusKey(job)}`);
const locale = () => (state.lang === "en" ? "en-US" : state.lang);
const num = n => (typeof n === "number" ? n.toLocaleString(locale()) : "–");

function duration(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function elapsedMs(job) {
  if (!job.startedAt) return undefined;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now();
  return end - Date.parse(job.startedAt);
}

function ago(iso) {
  if (!iso) return "–";
  const s = Math.round((now() - Date.parse(iso)) / 1000);
  if (s < 45) return t("justNow");
  if (s < 3600) return t("minAgo", { n: Math.round(s / 60) });
  if (s < 86400) return t("hAgo", { n: Math.round(s / 3600) });
  return new Date(iso).toLocaleDateString(locale());
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function kb(bytes) {
  if (typeof bytes !== "number") return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

const slash = p => String(p).replace(/\\/g, "/");
function relative(target, workspace) {
  const tt = slash(target);
  const w = slash(workspace || "").replace(/\/$/, "");
  if (w && tt.toLowerCase().startsWith(`${w.toLowerCase()}/`)) return tt.slice(w.length + 1);
  return tt;
}
/** "read_file D:/ws/src/a.ts" → "read_file src/a.ts" */
function shortStep(step, workspace) {
  const space = step.indexOf(" ");
  return space < 0 ? step : `${step.slice(0, space)} ${relative(step.slice(space + 1), workspace)}`;
}
function editorLink(workspace, rel, line) {
  const abs = /^([a-zA-Z]:|\/)/.test(rel) ? slash(rel) : `${slash(workspace).replace(/\/$/, "")}/${rel}`;
  return `vscode://file/${encodeURI(abs.startsWith("/") ? abs.slice(1) : abs)}${line ? `:${line}` : ""}`;
}
const baseName = p => slash(p || "").split("/").filter(Boolean).pop() || p;

// ---------- language ----------

function applyLanguage() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  const select = $("lang");
  select.title = t("language");
  select.setAttribute("aria-label", t("language"));
  select.closest("label").title = t("language");
  select.value = state.lang;
  renderLive();
}

function setupLanguagePicker() {
  const select = $("lang");
  select.replaceChildren(...Object.entries(I18N).map(([code, dict]) => h("option", { value: code }, dict._name || code)));
  select.value = state.lang;
  select.addEventListener("change", () => {
    state.lang = select.value;
    store("lang", state.lang);
    state.rendered.keys = {};
    applyLanguage();
    renderStats();
    renderList();
    renderDetail();
  });
}

// ---------- data ----------

async function api(path, options) {
  const res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

let detailBusy = false;
let jobsDir = "";
async function tick() {
  try {
    const data = await api("/api/jobs?limit=300");
    state.jobs = data.jobs;
    state.clockSkew = Date.parse(data.now) - Date.now();
    jobsDir = data.jobsDir;
    $("version").textContent = `v${data.version}`;
    setLive(true);
    if (!state.selected) {
      const fromHash = new URLSearchParams(location.hash.slice(1)).get("job");
      const pick = state.jobs.find(j => j.id === fromHash) || state.jobs.find(isActive) || state.jobs[0];
      if (pick) state.selected = pick.id;
    }
    renderStats();
    renderList();
    const sel = state.jobs.find(j => j.id === state.selected);
    const missing = !state.detail || state.detail.job.id !== state.selected;
    const changed = sel && state.detail && (sel.status !== state.detail.job.status || sel.finishedAt !== state.detail.job.finishedAt || sel.stale !== state.detail.job.stale);
    if (sel && !detailBusy && (missing || changed || isActive(sel))) await loadDetail();
    else renderDetail();
  } catch (error) {
    setLive(false, error.status === 401 ? "tokenExpired" : "unreachable");
  }
}

async function loadDetail() {
  if (!state.selected) return;
  detailBusy = true;
  try {
    const id = state.selected;
    const data = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (id === state.selected) {
      state.detail = data;
      renderDetail();
    }
  } catch (error) {
    if (error.status === 404) {
      state.detail = null;
      renderDetail();
    }
  } finally {
    detailBusy = false;
  }
}

function setLive(ok, key) {
  state.live = { ok, key: ok ? "live" : key };
  renderLive();
}

function renderLive() {
  const live = $("live");
  live.className = `live ${state.live.ok === true ? "ok" : state.live.ok === false ? "down" : ""}`;
  $("live-text").textContent = t(state.live.key);
}

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  state.detail = null;
  history.replaceState(null, "", `#job=${id}`);
  renderList();
  renderDetail();
  void loadDetail();
}

// ---------- header and list ----------

function renderStats() {
  const today = new Date(now()).toDateString();
  const todays = state.jobs.filter(j => new Date(j.createdAt).toDateString() === today);
  const count = s => state.jobs.filter(j => j.status === s && !j.stale).length;
  const tokens = todays.reduce((sum, j) => sum + (j.workerTokens || 0), 0);
  const items = [
    [t("statRunning"), count("running")],
    [t("statQueued"), count("queued")],
    [t("statToday"), todays.length],
    [t("statTokens"), num(tokens)]
  ];
  $("stats").replaceChildren(...items.map(([label, value]) => h("span", { class: "stat" }, label, h("b", {}, value))));
  $("jobs-foot").textContent = jobsDir ? t("jobsFolder", { dir: jobsDir }) : "";
  const running = count("running");
  document.title = running ? `(${running}) offload dashboard` : "offload dashboard";
}

function matches(job) {
  if (state.filter === "active" && !isActive(job)) return false;
  if (state.filter === "done" && job.status !== "succeeded") return false;
  if (state.filter === "problem" && !(PROBLEM.has(job.status) || job.stale || job.stepsOpen?.length || job.injectionFlags?.length)) return false;
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return [job.id, job.task, job.workspace, job.model, job.backend].some(v => String(v || "").toLowerCase().includes(q));
}

function renderList() {
  const list = $("jobs");
  const jobs = state.jobs.filter(matches);
  if (jobs.length === 0) {
    list.replaceChildren(h("li", { class: "empty-list" }, state.jobs.length ? t("emptyFilter") : t("emptyAll")));
    return;
  }
  list.replaceChildren(...jobs.map(job => {
    const cov = job.coverage
      ? t("filesOf", { a: job.coverage.opened, b: job.coverage.inScope })
      : job.manifestTotal !== undefined ? t("filesN", { n: num(job.manifestTotal) }) : "";
    return h("li", {},
      h("button", { type: "button", class: `job${job.id === state.selected ? " selected" : ""}`, onclick: () => select(job.id) },
        h("div", { class: "job-head" },
          h("span", { class: `pill ${statusKey(job)}` }, statusText(job)),
          h("span", { class: "job-id" }, shortId(job.id)),
          job.kind === "followup" ? h("span", {}, t("followupTag")) : null,
          h("span", { class: "job-time" }, isActive(job) ? duration(elapsedMs(job)) : job.finishedAt ? `${duration(elapsedMs(job))} · ${ago(job.finishedAt)}` : ago(job.createdAt))
        ),
        h("div", { class: "job-task" }, job.task),
        h("div", { class: "job-meta" },
          h("span", { title: job.workspace }, baseName(job.workspace)),
          job.model ? h("span", {}, job.model) : null,
          cov ? h("span", {}, cov) : null,
          job.workerTokens ? h("span", {}, t("tokN", { n: num(job.workerTokens) })) : null,
          job.question ? h("span", {}, t("asks")) : null
        ),
        isActive(job) && job.progress
          ? h("div", { class: "job-step" }, t("stepsLine", { n: job.progress.toolCalls, step: job.progress.lastStep ? shortStep(job.progress.lastStep, job.workspace) : t("thinking") }))
          : null
      ));
  }));
}

// ---------- detail ----------

function filesOpened(detail) {
  const read = new Set();
  for (const e of detail.timeline.entries) {
    if (e.kind === "tool" && READ_TOOLS.has(e.name) && e.state === "DONE" && e.target) {
      read.add(relative(e.target, detail.job.workspace).toLowerCase());
    }
  }
  return read;
}

function placeholder() {
  return h("div", { class: "placeholder" },
    h("h2", {}, t("noJobTitle")),
    h("p", {}, tNodes("noJobText", { tool: h("code", {}, "offload_submit_task") })));
}

function renderDetail() {
  const box = $("detail");
  const detail = state.detail;
  if (!state.selected || !detail) {
    if (!state.selected) {
      box.replaceChildren(placeholder());
      state.rendered = { id: null, keys: {} };
    } else if (state.rendered.id !== `loading:${state.selected}`) {
      box.replaceChildren(h("div", { class: "placeholder" }, h("div", { class: "spinner" })));
      state.rendered = { id: `loading:${state.selected}`, keys: {} };
    }
    return;
  }
  const job = { ...detail.job, ...(state.jobs.find(j => j.id === detail.job.id) || {}) };
  if (state.rendered.id !== job.id) {
    box.replaceChildren(
      h("div", { id: "d-head" }), h("dl", { class: "facts", id: "d-facts" }), h("div", { id: "d-cov" }),
      h("div", { class: "alerts", id: "d-alerts" }), h("div", { class: "related", id: "d-related" }),
      h("nav", { class: "tabs", id: "d-tabs" }), h("div", { id: "d-pane" })
    );
    box.scrollTop = 0;
    state.rendered = { id: job.id, keys: {} };
  }
  const opened = filesOpened(detail);
  const L = state.lang;
  part("d-head", JSON.stringify([L, job.status, job.stale, job.task]), () => head(job));
  part("d-facts", JSON.stringify([L, job.status, job.startedAt, job.finishedAt, job.workerTokens, job.model, Math.floor(now() / 1000)]), () => facts(job));
  part("d-cov", JSON.stringify([L, job.coverage, opened.size, detail.scope.length, job.status]), () => coverageBar(job, detail, opened));
  part("d-alerts", JSON.stringify([L, job.error, job.stale, job.question, job.injectionFlags, job.redactions, job.changedFiles, job.stepsOpen, job.stepLogged, job.formatOk, job.deniedActions]), () => alerts(job));
  part("d-related", JSON.stringify([L, job.parentId, detail.followups]), () => related(job, detail));
  part("d-tabs", JSON.stringify([L, state.tab, detail.timeline.total, detail.scope.length, !!detail.report]), () => tabs(detail));
  paneFor(job, detail, opened);
}

/** Re-renders one block only when its content key changed, so scroll positions and selections survive polling. */
function part(id, key, build) {
  if (state.rendered.keys[id] === key) return;
  state.rendered.keys[id] = key;
  const el = $(id);
  if (!el) return;
  const content = build();
  el.replaceChildren(...(Array.isArray(content) ? content : [content]).filter(Boolean));
}

function head(job) {
  const actions = [];
  if (isActive(job)) actions.push(h("button", { type: "button", class: "btn danger", onclick: event => cancelJob(job.id, event.currentTarget) }, t("cancelJob")));
  actions.push(h("button", { type: "button", class: "btn", onclick: event => copy(job.id, event.currentTarget) }, t("copyId")));
  return h("div", { class: "d-head" },
    h("div", { class: "d-title" },
      h("h1", {}, job.task),
      h("div", { class: "d-sub" },
        h("span", { class: `pill ${statusKey(job)}` }, statusText(job)),
        h("span", { class: "mono" }, job.id),
        job.kind === "followup" ? h("span", {}, t("followup")) : null,
        h("span", { title: job.workspace }, baseName(job.workspace))
      )
    ),
    h("div", { class: "d-actions" }, actions)
  );
}

function facts(job) {
  const rows = [
    ["fElapsed", duration(elapsedMs(job))],
    ["fBackend", job.model ? `${job.backend} · ${job.model}` : job.backend],
    ["fScope", job.manifestTotal !== undefined ? `${num(job.manifestTotal)}${job.scopeBytes ? ` · ${kb(job.scopeBytes)}` : ""}` : "–"],
    ["fTokens", num(job.workerTokens)],
    ["fSteps", job.stepCount ?? "–"],
    ["fCreated", job.createdAt ? `${clock(job.createdAt)} · ${ago(job.createdAt)}` : "–"],
    ["fTimeout", job.timeoutSec ? duration(job.timeoutSec * 1000) : "–"],
    ["fWorkspace", job.workspace]
  ];
  if (isActive(job) && job.progress) {
    rows.splice(1, 0, ["fLastEvent", t("ago", { d: duration(now() - Date.parse(job.progress.lastEventAt)) })]);
  }
  return rows.map(([k, v]) => h("div", { class: k === "fWorkspace" ? "fact wide" : "fact" }, h("dt", {}, t(k)), h("dd", {}, v)));
}

function coverageBar(job, detail, opened) {
  let done;
  let total;
  let label;
  if (job.coverage) {
    done = job.coverage.opened;
    total = job.coverage.inScope;
    const source = job.coverage.source === "report" ? t("srcReport") : t("srcTool");
    label = t("covMeasured", { source, a: num(done), b: num(total) });
  } else if (detail.scope.length && detail.timeline.total) {
    total = detail.scope.length;
    done = detail.scope.filter(f => opened.has(f.toLowerCase())).length;
    label = t("covSoFar", { a: num(done), b: num(total) });
  } else {
    return null;
  }
  const pct = total ? Math.round((done / total) * 100) : 0;
  const fill = h("span");
  fill.style.width = `${pct}%`;
  return h("div", { class: "coverage" },
    h("div", { class: "coverage-label" }, h("span", {}, label), h("b", {}, `${pct}%`)),
    h("div", { class: `bar${pct === 100 ? " full" : ""}` }, fill)
  );
}

function alerts(job) {
  const out = [];
  const add = (kind, title, text) => out.push(h("div", { class: `alert ${kind}` }, h("b", {}, title), text ? ` ${text}` : ""));
  if (job.stale) add("warn", t("aStaleT"), t("aStale"));
  if (job.error) add("bad", t("aErrorT"), job.error);
  if (job.question) add("info", t("aAskT"), t("aAsk", { q: job.question }));
  if (job.stepLogged === false) add("warn", t("aBriefT"), t("aNoLog"));
  else if (job.stepsOpen?.length) add("warn", t("aBriefT"), t("aStepsOpen", { list: job.stepsOpen.join(", "), n: job.stepCount }));
  if (job.formatOk === false) add("warn", t("aFormatT"), t("aFormat"));
  if (job.injectionFlags?.length) add("warn", t("aInjectT"), t("aInject", { flags: job.injectionFlags.join("; ") }));
  if (job.changedFiles?.length) add("warn", t("aChangedT"), job.changedFiles.slice(0, 10).join(", "));
  if (job.deniedActions?.length) add("warn", t("aDeniedT"), job.deniedActions.join(", "));
  if (job.redactions) add("note", t("aMaskedT"), t("aMasked", { n: job.redactions }));
  return out;
}

function related(job, detail) {
  const out = [];
  if (job.parentId) out.push(t("relParent"), jobLink(job.parentId));
  if (detail.followups.length) out.push(t("relChildren"), ...detail.followups.map(jobLink));
  return out.length ? out : null;
}

function jobLink(id) {
  return h("button", { type: "button", onclick: () => select(id), title: id }, shortId(id));
}

const TABS = [
  ["timeline", "tTimeline", d => d.timeline.total],
  ["report", "tReport", () => null],
  ["brief", "tBrief", () => null],
  ["scope", "tScope", d => d.scope.length],
  ["log", "tLog", () => null]
];

function tabs(detail) {
  return TABS.map(([key, label, count]) => {
    const n = count(detail);
    return h("button", {
      type: "button", class: state.tab === key ? "on" : "",
      onclick: () => { state.tab = key; store("tab", key); renderDetail(); }
    }, t(label), n ? h("span", { class: "count" }, num(n)) : null);
  });
}

function paneFor(job, detail, opened) {
  const keyBase = [state.lang, state.tab, job.id];
  if (state.tab === "timeline") {
    const last = detail.timeline.entries.at(-1);
    part("d-pane", JSON.stringify([...keyBase, detail.timeline.total, last?.t, isActive(job), job.progress?.lastEventAt && Math.floor((now() - Date.parse(job.progress.lastEventAt)) / 5000)]), () => timeline(job, detail));
  } else if (state.tab === "report") {
    part("d-pane", JSON.stringify([...keyBase, detail.report?.length, job.status]), () => report(job, detail));
  } else if (state.tab === "brief") {
    part("d-pane", JSON.stringify([...keyBase, detail.prompt.length]), () => h("div", { class: "pane" }, h("pre", { class: "raw" }, detail.prompt || t("noPrompt"))));
  } else if (state.tab === "scope") {
    part("d-pane", JSON.stringify([...keyBase, detail.scope.length, opened.size, state.onlyUnread, job.coverage?.opened]), () => scope(job, detail, opened));
  } else {
    part("d-pane", JSON.stringify([...keyBase, detail.stderr.length, job.exitCode]), () => h("div", { class: "pane" },
      h("pre", { class: "raw" }, `${job.exitCode !== undefined ? `${t("exitCode", { n: job.exitCode })}\n\n` : ""}${detail.stderr || t("stderrEmpty")}`)));
  }
}

function timeline(job, detail) {
  const old = $("tl-list");
  const atBottom = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 30;
  const previousTop = old ? old.scrollTop : 0;
  const rows = detail.timeline.entries.map(e => {
    if (e.kind === "say") {
      return h("li", { class: "tl say", title: t("expand"), onclick: event => event.currentTarget.classList.toggle("open") },
        h("span", { class: "tl-time" }, clock(e.t)), h("span", { class: "tl-icon" }, "💬"), h("span", { class: "tl-name" }, t("tlWorker")), h("span", { class: "tl-target" }, e.text), h("span"));
    }
    if (e.kind === "end") {
      return h("li", { class: `tl end${e.state === "SUCCESS" ? "" : " error"}` }, h("span", { class: "tl-time" }, clock(e.t)), h("span", { class: "tl-icon" }, e.state === "SUCCESS" ? "✓" : "✗"), h("span", { class: "tl-name" }, t("tlResult")), h("span", { class: "tl-target" }, e.state || "", e.error ? ` · ${e.error}` : ""), h("span", { class: "tl-sec" }, e.sec ? duration(e.sec * 1000) : ""));
    }
    const error = e.state === "ERROR";
    const rel = e.target ? relative(e.target, job.workspace) : "";
    const target = rel && READ_TOOLS.has(e.name) ? h("a", { href: editorLink(job.workspace, rel), title: t("openVs") }, rel) : rel;
    return h("li", { class: `tl${error ? " error" : ""}` },
      h("span", { class: "tl-time" }, clock(e.t)),
      h("span", { class: "tl-icon" }, error ? "✗" : READ_TOOLS.has(e.name) ? "📄" : "•"),
      h("span", { class: "tl-name" }, e.name),
      h("span", { class: "tl-target" }, target),
      h("span", { class: "tl-sec" }, e.sec ? `${e.sec < 10 ? e.sec.toFixed(1) : Math.round(e.sec)}s` : ""),
      e.error ? h("span", { class: "tl-err" }, e.error) : null
    );
  });
  if (detail.timeline.total > detail.timeline.entries.length) {
    rows.unshift(h("li", { class: "tl-wait" }, t("tlEarlier", { n: num(detail.timeline.total - detail.timeline.entries.length) })));
  }
  const list = h("ol", { class: "timeline", id: "tl-list" }, rows);
  let footer = null;
  if (isActive(job)) {
    const quiet = job.progress ? duration(now() - Date.parse(job.progress.lastEventAt)) : "–";
    footer = h("div", { class: "tl-wait" }, h("span", { class: "spinner" }), job.status === "queued" ? t("tlQueued") : t("tlWorking", { d: quiet }));
  } else if (!rows.length) {
    footer = h("div", { class: "tl-wait" }, t("tlNone"));
  }
  requestAnimationFrame(() => {
    const el = $("tl-list");
    if (el) el.scrollTop = atBottom ? el.scrollHeight : previousTop;
  });
  return h("div", { class: "pane" }, list, footer);
}

function report(job, detail) {
  if (!detail.report) {
    return h("div", { class: "pane pane-pad muted" }, isActive(job) ? t("rpWait") : t("rpNone"));
  }
  const body = h("div", { class: "pane pane-pad md" });
  body.innerHTML = markdown(detail.report, job.workspace);
  return body;
}

function scope(job, detail, opened) {
  if (!detail.scope.length) return h("div", { class: "pane pane-pad muted" }, t("scNone"));
  const known = detail.timeline.total > 0;
  const missed = new Set((job.coverage?.missed || []).map(f => f.toLowerCase()));
  const isRead = f => (known ? opened.has(f.toLowerCase()) : job.coverage ? !missed.has(f.toLowerCase()) : null);
  const files = detail.scope.filter(f => !state.onlyUnread || isRead(f) === false);
  const readCount = detail.scope.filter(f => isRead(f)).length;
  const toggle = h("input", { type: "checkbox", onchange: e => { state.onlyUnread = e.currentTarget.checked; renderDetail(); } });
  toggle.checked = state.onlyUnread;
  return h("div", { class: "pane" },
    h("div", { class: "scope-tools" },
      h("span", {}, t("scFiles", { n: num(detail.scope.length) })),
      known || job.coverage ? h("span", {}, t("scOpened", { n: num(readCount) })) : h("span", {}, t("scUnknown")),
      h("label", {}, toggle, t("scOnlyUnread"))
    ),
    h("ul", { class: "scope" }, files.map(f => {
      const read = isRead(f);
      return h("li", { class: read === true ? "read" : read === false ? "unread" : "" },
        h("span", { class: "mark" }, read === true ? "✓" : read === false ? "·" : ""),
        h("a", { href: editorLink(job.workspace, f), title: t("openVs") }, f));
    }))
  );
}

// ---------- actions ----------

async function cancelJob(id, button) {
  if (!confirm(t("confirmCancel"))) return;
  button.disabled = true;
  button.textContent = t("cancelling");
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "X-Offload": "1" } });
  } catch (error) {
    alert(t("cancelFailed", { msg: error.message }));
    button.disabled = false;
    button.textContent = t("cancelJob");
  }
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = t("copied");
    setTimeout(() => { button.textContent = t("copyId"); }, 1200);
  } catch { /* clipboard blocked */ }
}

// ---------- Markdown (escape first, then add a small set of tags) ----------

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const LOC = /(^|[\s(\[|,;])((?:[\w@.-]+[\\/])*[\w@.-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?(?![\w])/g;

function linkify(escaped, workspace) {
  return escaped.replace(LOC, (all, pre, file, start, end) =>
    `${pre}<a class="loc" href="${esc(editorLink(workspace, file.replace(/\\/g, "/"), start))}" title="${esc(t("openVs"))}">${file}:${start}${end ? `-${end}` : ""}</a>`);
}

function inline(text, workspace) {
  return text.split(/(`[^`]+`)/g).map(seg => {
    if (/^`[^`]+`$/.test(seg)) return `<code>${linkify(esc(seg.slice(1, -1)), workspace)}</code>`;
    let s = esc(seg);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    return linkify(s, workspace);
  }).join("");
}

function markdown(src, workspace) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inline(heading[2], workspace)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const isSep = r => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(r);
      let html = "<div class=\"table-wrap\"><table>";
      let body = rows;
      if (rows.length > 1 && isSep(rows[1])) {
        html += `<thead><tr>${cells(rows[0]).map(c => `<th>${inline(c, workspace)}</th>`).join("")}</tr></thead>`;
        body = rows.slice(2);
      }
      html += `<tbody>${body.filter(r => !isSep(r)).map(r => `<tr>${cells(r).map(c => `<td>${inline(c, workspace)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      out.push(html);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map(it => `<li>${inline(it, workspace)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(p => inline(p, workspace)).join("<br>")}</p>`);
  }
  return out.join("\n");
}

// ---------- wiring ----------

$("filters").addEventListener("click", event => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  for (const b of $("filters").querySelectorAll("button")) b.classList.toggle("on", b === button);
  renderList();
});
$("search").addEventListener("input", event => {
  state.search = event.currentTarget.value;
  renderList();
});
window.addEventListener("hashchange", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("job");
  if (id && id !== state.selected) select(id);
});
document.addEventListener("keydown", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key !== "j" && event.key !== "k") return;
  const jobs = state.jobs.filter(matches);
  const at = jobs.findIndex(j => j.id === state.selected);
  const next = jobs[Math.min(Math.max(at + (event.key === "j" ? 1 : -1), 0), jobs.length - 1)];
  if (next) select(next.id);
});

setupLanguagePicker();
applyLanguage();
renderDetail();
void tick();
setInterval(() => {
  if (document.hidden) return;
  void tick();
}, POLL_MS);
