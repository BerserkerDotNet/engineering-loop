// Canvas renderer for the loop execution visualizer.
//
// The renderer is a pure view over the projection: it never derives workflow
// state of its own, so it can never show something the contract would reject.

const params = new URLSearchParams(location.search);
const BOOTSTRAP = params.get("bootstrap") ?? "";
const INITIAL_RUN = params.get("runId") || null;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "prompt", label: "Prompt" },
  { id: "plan", label: "Plan" },
  { id: "progress", label: "Progress" },
  { id: "details", label: "Details" },
  { id: "usage", label: "Usage" },
  { id: "incidents", label: "Incidents" },
  { id: "messages", label: "Messages" },
];

const STAGE_W = 236;
const GAP_X = 56;
const GAP_Y = 16;
const ROW_H = 30;

const state = {
  credential: null,
  run: null,
  runs: null,
  view: "run",
  selection: null, // {kind:"controller"|"node"|"attempt", nodeId, attemptId}
  tab: "overview",
  zoom: 1,
  expandAll: false,
  expanded: new Set(),
  info: null,
  connected: false,
};

const el = (id) => document.getElementById(id);
const dom = {
  status: el("status-bar"),
  title: el("run-title"),
  facts: el("run-facts"),
  back: el("back-button"),
  allRuns: el("all-runs-button"),
  controller: el("controller-lane"),
  graph: el("graph"),
  canvas: el("graph-canvas"),
  runsList: el("runs-list"),
  zoomIn: el("zoom-in"),
  zoomOut: el("zoom-out"),
  zoomFit: el("zoom-fit"),
  zoomLevel: el("zoom-level"),
  toggleAttempts: el("toggle-attempts"),
  inspector: el("inspector"),
  inspectorTitle: el("inspector-title"),
  inspectorSubtitle: el("inspector-subtitle"),
  tabs: el("tabs"),
  panel: el("tab-panel"),
  composer: el("composer"),
  composerTarget: el("composer-target"),
  composerBody: el("composer-body"),
  composerNote: el("composer-note"),
  composerSend: el("composer-send"),
  splitter: el("splitter"),
  overlayToggle: el("overlay-toggle"),
  layout: el("layout"),
};

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function nonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function bootstrap() {
  const response = await fetch("./bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "x-loopviz-csrf": "1" },
    body: JSON.stringify({ bootstrap: BOOTSTRAP }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `bootstrap failed with ${response.status}`);
  }
  const payload = await response.json();
  state.credential = payload.credential;
  // The bootstrap token in the URL is single use; remove it from history.
  history.replaceState(null, "", location.pathname + (INITIAL_RUN ? `?runId=${encodeURIComponent(INITIAL_RUN)}` : ""));
}

async function api(name, input = {}) {
  if (!state.credential) throw new Error("not authenticated");
  const response = await fetch(`./api/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-loopviz-csrf": "1",
      "x-loopviz-credential": state.credential,
      "x-loopviz-nonce": nonce(),
    },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `${name} failed with ${response.status}`);
  return payload;
}

function connectStream() {
  const source = new EventSource(`./events?credential=${encodeURIComponent(state.credential)}`);
  source.addEventListener("hello", () => {
    state.connected = true;
    setStatus("Live", "ok");
  });
  source.addEventListener("run", (event) => {
    const payload = JSON.parse(event.data);
    if (state.view === "run" && payload.run && (!state.run || payload.run.runId === state.run.runId)) {
      state.run = payload.run;
      render();
    }
  });
  source.addEventListener("focus", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.nodeId) {
      state.selection = { kind: "node", nodeId: payload.nodeId, attemptId: null };
      if (payload.tab) state.tab = payload.tab;
    }
    if (payload.runId) void loadRun(payload.runId);
    else render();
  });
  source.onerror = () => {
    state.connected = false;
    setStatus("Reconnecting to the extension…", "warn");
  };
}

function setStatus(text, tone = "") {
  dom.status.textContent = text;
  dom.status.dataset.tone = tone;
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

async function loadRun(runId) {
  try {
    const payload = await api("run", runId ? { runId } : {});
    if (!payload.ok) {
      setStatus(payload.reason, "warn");
      return;
    }
    state.run = payload.run;
    state.view = "run";
    if (!state.selection) state.selection = { kind: "controller", nodeId: null, attemptId: null };
    render();
  } catch (error) {
    setStatus(error.message, "bad");
  }
}

async function loadRuns() {
  try {
    const payload = await api("runs");
    state.runs = payload.runs ?? [];
    state.view = "runs";
    render();
  } catch (error) {
    setStatus(error.message, "bad");
  }
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function duration(ms) {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function clockTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Cost is only ever labelled "actual" when the projection says the provider
 * billed real currency. Copilot credits are always estimated or partial.
 */
function costLabel(usage) {
  if (!usage) return "—";
  if (usage.confidence === "unavailable") return "unavailable";
  // Show the reconciled total, not just what live sampling happened to catch.
  const credits = usage.totalCredits ?? usage.credits ?? 0;
  const amount = usage.currency
    ? `${usage.currency} ${credits.toFixed(4)}`
    : `${credits.toFixed(3)} credits`;
  const suffix = usage.confidence === "actual" ? "actual" : usage.confidence;
  return `${amount} (${suffix})`;
}

function healthTone(health) {
  if (health === "connection_lost") return "lost";
  if (health === "healthy" || health === "recovered") return "ok";
  if (health === "ended") return "neutral";
  return "neutral";
}

function stateTone(value) {
  if (["succeeded", "completed", "accepted", "resolved"].includes(value)) return "ok";
  if (["failed", "denied", "rejected"].includes(value)) return "bad";
  if (["waiting", "blocked", "expired", "recovery_pending", "awaiting_children"].includes(value)) return "warn";
  return "neutral";
}

function text(node, value) {
  node.textContent = value ?? "";
  return node;
}

function make(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

function badge(label, tone = "neutral") {
  const node = make("span", "badge", label);
  node.dataset.tone = tone;
  return node;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render() {
  dom.back.hidden = state.view === "run";
  dom.runsList.hidden = state.view !== "runs";
  dom.graph.hidden = state.view !== "run";
  dom.controller.hidden = state.view !== "run";

  if (state.view === "runs") {
    renderRunsList();
    return;
  }
  if (!state.run) {
    dom.title.textContent = "No run yet";
    text(dom.facts, "");
    dom.canvas.replaceChildren();
    dom.controller.replaceChildren(make("p", "empty", "This session has not declared a run yet."));
    return;
  }
  renderSummary();
  renderController();
  renderGraph();
  renderInspector();
  renderComposerTargets();
}

function renderSummary() {
  const run = state.run;
  dom.title.textContent = run.title || run.runId;
  dom.title.title = `${run.skill} · ${run.runId}`;

  const settled = ["succeeded", "failed", "skipped", "canceled", "replaced"];
  const done = run.dag.nodes.filter((n) => settled.includes(n.state)).length;
  const openIncidents = run.incidents.filter((i) => !["resolved", "expired"].includes(i.state)).length;

  const facts = [
    ["Skill", run.skill],
    ["State", run.outcome ? `${run.state} · ${run.outcome.outcome}` : run.state],
    ["Stages", `${done}/${run.dag.nodes.length}`],
    ["Elapsed", duration(run.elapsedMs)],
    ["Cost", costLabel(run.usage)],
    ["Incidents", String(openIncidents)],
  ];
  if (run.integrity?.rejected > 0) facts.push(["Rejected", String(run.integrity.rejected)]);
  if (run.integrity?.quarantined > 0) facts.push(["Quarantined", String(run.integrity.quarantined)]);

  dom.facts.replaceChildren(...facts.map(([key, value]) => {
    const wrap = make("div");
    wrap.append(make("dt", null, key), make("dd", null, value));
    return wrap;
  }));

  if (!state.connected) setStatus("Reconnecting to the extension…", "warn");
  else if (openIncidents > 0) setStatus(`${openIncidents} open incident${openIncidents === 1 ? "" : "s"}`, "warn");
  else setStatus(`Live · updated ${clockTime(run.updatedAt)}`, "ok");
}

function renderController() {
  const controller = state.run.controller;
  const card = make("button", "controller-card");
  card.type = "button";
  card.setAttribute("aria-selected", String(state.selection?.kind === "controller"));
  card.append(make("span", "controller-card__pin", "Orchestrator"));
  card.append(make("span", "controller-card__name", controller.label));
  card.append(badge(controller.workflowState.replace(/_/g, " "), stateTone(controller.workflowState)));
  card.append(badge(`host ${controller.hostActivity.replace(/_/g, " ")}`, "neutral"));
  card.append(badge(controller.session.health.replace(/_/g, " "), healthTone(controller.session.health)));
  card.append(make("span", "stage__meta", duration(controller.elapsedMs)));
  if (controller.waitingOnNodeIds?.length) {
    card.append(badge(`waiting on ${controller.waitingOnNodeIds.length}`, "warn"));
  }
  card.addEventListener("click", () => {
    state.selection = { kind: "controller", nodeId: null, attemptId: null };
    render();
    openInspectorOnNarrow();
  });
  dom.controller.replaceChildren(card);
}

function nodeHeight(node, expanded) {
  const base = 62;
  if (!expanded) return base + (node.attempts.length > 1 ? 18 : 0);
  return base + 18 + node.attempts.length * ROW_H;
}

function isExpanded(node) {
  return state.expandAll || state.expanded.has(node.nodeId);
}

function renderGraph() {
  const run = state.run;
  const columns = new Map();
  for (const node of run.dag.nodes) {
    if (!columns.has(node.column)) columns.set(node.column, []);
    columns.get(node.column).push(node);
  }

  const positions = new Map();
  let maxBottom = 0;
  for (const [column, nodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let top = 0;
    for (const node of nodes) {
      const height = nodeHeight(node, isExpanded(node));
      positions.set(node.nodeId, { x: column * (STAGE_W + GAP_X), y: top, height });
      top += height + GAP_Y;
      maxBottom = Math.max(maxBottom, top);
    }
  }

  const width = (Math.max(1, columns.size)) * (STAGE_W + GAP_X);
  dom.canvas.style.width = `${width}px`;
  dom.canvas.style.height = `${Math.max(120, maxBottom)}px`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "graph-edges");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(Math.max(120, maxBottom)));
  svg.setAttribute("aria-hidden", "true");
  for (const edge of run.dag.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + STAGE_W;
    const y1 = from.y + 24;
    const x2 = to.x;
    const y2 = to.y + 24;
    const mid = x1 + (x2 - x1) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
    path.dataset.added = String(edge.addedDuringRun === true);
    svg.append(path);
  }

  const cards = run.dag.nodes.map((node) => renderStage(node, positions.get(node.nodeId)));
  dom.canvas.replaceChildren(svg, ...cards);
}

function renderStage(node, position) {
  const card = make("div", "stage");
  card.style.left = `${position.x}px`;
  card.style.top = `${position.y}px`;
  card.dataset.state = node.state;
  card.dataset.nodeId = node.nodeId;
  card.tabIndex = -1;
  card.setAttribute("role", "button");
  card.setAttribute("aria-selected", String(state.selection?.kind !== "controller" && state.selection?.nodeId === node.nodeId));

  const attempt = node.attempts[node.attempts.length - 1];
  const label = `${node.label}, ${node.state}${node.addedDuringRun ? ", added during run" : ""}${attempt ? `, attempt ${attempt.attemptNumber} ${attempt.state}` : ""}`;
  card.setAttribute("aria-label", label);

  const head = make("div", "stage__head");
  head.append(make("span", "stage__label", node.label));
  if (node.phase) head.append(make("span", "stage__phase", `Phase ${node.phase}`));
  card.append(head);

  const badges = make("div", "stage__meta");
  badges.append(badge(node.state, stateTone(node.state)));
  if (node.addedDuringRun) badges.append(badge("Added during run", "neutral"));
  if (attempt?.session?.health && attempt.session.health !== "unknown") {
    badges.append(badge(attempt.session.health.replace(/_/g, " "), healthTone(attempt.session.health)));
  }
  card.append(badges);

  const meta = make("div", "stage__meta");
  meta.append(make("span", null, duration(node.elapsedMs)));
  if (attempt?.model) meta.append(make("span", null, attempt.model));
  meta.append(make("span", null, costLabel(node.usage)));
  card.append(meta);

  if (node.attempts.length > 0) {
    const expanded = isExpanded(node);
    const expander = make("button", "stage__expander",
      expanded ? `Hide ${node.attempts.length} attempt${node.attempts.length === 1 ? "" : "s"}`
               : `Show ${node.attempts.length} attempt${node.attempts.length === 1 ? "" : "s"}`);
    expander.type = "button";
    expander.setAttribute("aria-expanded", String(expanded));
    expander.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.expanded.has(node.nodeId)) state.expanded.delete(node.nodeId);
      else state.expanded.add(node.nodeId);
      state.expandAll = false;
      dom.toggleAttempts.checked = false;
      render();
    });
    card.append(expander);

    if (expanded) {
      const list = make("ul", "attempts");
      for (const item of node.attempts) {
        const row = make("li");
        const button = make("button", "attempt");
        button.type = "button";
        button.setAttribute("aria-selected", String(state.selection?.attemptId === item.attemptId));
        button.append(make("span", "attempt__num", `#${item.attemptNumber}`));
        button.append(make("span", null, item.kind));
        button.append(badge(item.state, stateTone(item.state)));
        if (item.session.health === "connection_lost") button.append(badge("connection lost", "lost"));
        button.append(make("span", "attempt__num", duration(item.elapsedMs)));
        button.setAttribute("aria-label", `Attempt ${item.attemptNumber}, ${item.kind}, ${item.state}, ${duration(item.elapsedMs)}`);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          state.selection = { kind: "attempt", nodeId: node.nodeId, attemptId: item.attemptId };
          render();
          openInspectorOnNarrow();
        });
        row.append(button);
        list.append(row);
      }
      card.append(list);
    }
  }

  card.addEventListener("click", () => {
    state.selection = { kind: "node", nodeId: node.nodeId, attemptId: null };
    render();
    openInspectorOnNarrow();
  });
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      card.click();
    }
  });
  return card;
}

function renderRunsList() {
  dom.title.textContent = "All runs";
  dom.facts.replaceChildren();
  const runs = state.runs ?? [];
  if (runs.length === 0) {
    dom.runsList.replaceChildren(make("li", "empty", "No runs have been recorded yet."));
    return;
  }
  dom.runsList.replaceChildren(...runs.map((summary) => {
    const item = make("li");
    const button = make("button", "run-entry");
    button.type = "button";
    button.append(make("span", "run-entry__title", summary.title || summary.runId));
    button.append(make("span", "run-entry__meta", summary.skill ?? ""));
    button.append(make("span", "run-entry__meta", summary.outcome ?? summary.state ?? ""));
    button.append(make("span", "run-entry__meta", `${summary.completedNodes ?? 0}/${summary.totalNodes ?? 0}`));
    button.append(make("span", "run-entry__meta", duration(summary.elapsedMs)));
    button.addEventListener("click", () => void loadRun(summary.runId));
    item.append(button);
    return item;
  }));
}

// ---------------------------------------------------------------------------
// inspector
// ---------------------------------------------------------------------------

function currentSubject() {
  const run = state.run;
  if (!run || !state.selection) return null;
  if (state.selection.kind === "controller") {
    return { kind: "controller", label: run.controller.label, controller: run.controller, node: null, attempt: null };
  }
  const node = run.dag.nodes.find((n) => n.nodeId === state.selection.nodeId);
  if (!node) return null;
  const attempt = state.selection.attemptId
    ? node.attempts.find((a) => a.attemptId === state.selection.attemptId)
    : node.attempts[node.attempts.length - 1];
  return { kind: state.selection.kind, label: node.label, node, attempt: attempt ?? null, controller: null };
}

function renderInspector() {
  const subject = currentSubject();
  if (!subject) {
    dom.inspectorTitle.textContent = "Nothing selected";
    dom.inspectorSubtitle.textContent = "Select a stage to inspect it.";
    dom.tabs.replaceChildren();
    dom.panel.replaceChildren();
    return;
  }

  dom.inspectorTitle.textContent = subject.label;
  dom.inspectorSubtitle.textContent = subject.kind === "controller"
    ? `Controller · ${subject.controller.workflowState.replace(/_/g, " ")} · host ${subject.controller.hostActivity.replace(/_/g, " ")}`
    : `${subject.node.state}${subject.attempt ? ` · attempt ${subject.attempt.attemptNumber} (${subject.attempt.kind})` : ""}`;

  dom.tabs.replaceChildren(...TABS.map((tab) => {
    const button = make("button", "tab", tab.label);
    button.type = "button";
    button.id = `tab-${tab.id}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.tab === tab.id));
    button.setAttribute("aria-controls", "tab-panel");
    button.tabIndex = state.tab === tab.id ? 0 : -1;
    button.addEventListener("click", () => {
      state.tab = tab.id;
      renderInspector();
    });
    button.addEventListener("keydown", (event) => {
      const index = TABS.findIndex((t) => t.id === state.tab);
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const next = (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
        state.tab = TABS[next].id;
        renderInspector();
        el(`tab-${state.tab}`)?.focus();
      }
    });
    return button;
  }));

  dom.panel.setAttribute("aria-labelledby", `tab-${state.tab}`);
  dom.panel.replaceChildren(...renderTab(subject));
}

function kvList(pairs) {
  const list = make("dl", "kv");
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === "") continue;
    list.append(make("dt", null, key), make("dd", null, String(value)));
  }
  return list;
}

function semanticField(subject, field, emptyText) {
  const semantics = subject.attempt?.semantics ?? subject.controller?.semantics ?? null;
  const value = semantics?.[field];
  if (!value) return [make("p", "empty", emptyText)];
  return [make("pre", "pre", value)];
}

function renderTab(subject) {
  const run = state.run;
  switch (state.tab) {
    case "overview": {
      const parts = [];
      if (subject.kind === "controller") {
        const controller = subject.controller;
        parts.push(kvList([
          ["Workflow", controller.workflowState.replace(/_/g, " ")],
          ["Host activity", controller.hostActivity.replace(/_/g, " ")],
          ["Health", controller.session.health.replace(/_/g, " ")],
          ["Waiting on", controller.waitingOnNodeIds?.join(", ")],
          ["App session", controller.session.appSessionId],
          ["Elapsed", duration(controller.elapsedMs)],
          ["Reason", controller.stateReason],
        ]));
        if (["idle", "ended"].includes(controller.hostActivity)) {
          parts.push(make("p", "empty",
            "The orchestrator host is idle. That is host activity only and never means the run completed."));
        }
        parts.push(make("h3", null, "Timeline"), timeline(controller.timeline));
      } else {
        const node = subject.node;
        parts.push(kvList([
          ["Stage", node.label],
          ["State", node.state],
          ["Phase", node.phase],
          ["Role", node.role],
          ["Depends on", node.dependsOn.join(", ") || "—"],
          ["Added during run", node.addedDuringRun ? "yes" : "no"],
          ["Attempts", String(node.attempts.length)],
          ["Elapsed", duration(node.elapsedMs)],
          ["Reason", node.stateReason],
        ]));
        if (subject.attempt) {
          parts.push(make("h3", null, `Attempt ${subject.attempt.attemptNumber}`));
          parts.push(kvList([
            ["Kind", subject.attempt.kind],
            ["State", subject.attempt.state],
            ["Authoritative failure", subject.attempt.authoritativeFailure ? "yes" : "no"],
            ["Model", subject.attempt.model],
            ["Health", subject.attempt.session.health.replace(/_/g, " ")],
            ["App session", subject.attempt.session.appSessionId],
            ["Last heartbeat", clockTime(subject.attempt.session.lastHeartbeatAt)],
            ["Elapsed", duration(subject.attempt.elapsedMs)],
            ["Reason", subject.attempt.stateReason],
          ]));
          parts.push(make("h3", null, "Timeline"), timeline(subject.attempt.timeline));
        }
      }
      return parts;
    }

    case "prompt":
      return semanticField(subject, "prompt", "No prompt was reported for this stage.");
    case "plan":
      return semanticField(subject, "plan", "No plan was reported for this stage.");
    case "progress":
      return semanticField(subject, "progress", "No progress note was reported for this stage.");
    case "details":
      return semanticField(subject, "details", "No details were reported for this stage.");

    case "usage": {
      const usage = subject.kind === "controller"
        ? subject.controller.usage
        : (subject.attempt?.usage ?? subject.node.usage);
      const parts = [kvList([
        ["Confidence", usage.confidence],
        ["Cost", costLabel(usage)],
        ["Unit", usage.unit],
        ["Live samples", String(usage.samples ?? 0)],
        ["Live sample credits", (usage.credits ?? 0).toFixed(3)],
        ["Reconciled credits", (usage.reconciledCredits ?? 0).toFixed(3)],
        ["Unattributed credits", (usage.unattributedCredits ?? 0).toFixed(3)],
        ["Blind windows", String(usage.blindWindows ?? 0)],
        ["Input tokens", String(usage.tokens?.input ?? 0)],
        ["Output tokens", String(usage.tokens?.output ?? 0)],
        ["Cache read", String(usage.tokens?.cacheRead ?? 0)],
        ["Cache write", String(usage.tokens?.cacheWrite ?? 0)],
        ["Reasoning", String(usage.tokens?.reasoning ?? 0)],
      ])];
      if (usage.confidence !== "actual") {
        parts.push(make("p", "empty",
          "Copilot reports AI credits, not billed currency, so this figure is an estimate and is never labelled actual."));
      }
      if ((usage.blindWindows ?? 0) > 0) {
        parts.push(make("p", "empty",
          "Some usage was only visible through aggregate reconciliation, so this total is partial."));
      }
      if (run.priceSnapshots?.length) {
        parts.push(make("h3", null, "Price snapshots"));
        parts.push(kvList(run.priceSnapshots.map((snapshot) => [snapshot.snapshotId, `${snapshot.models.length} models · ${clockTime(snapshot.at)}`])));
      }
      return parts;
    }

    case "incidents": {
      const relevant = run.incidents.filter((incident) =>
        subject.kind === "controller" ? true : incident.nodeId === subject.node.nodeId);
      if (relevant.length === 0) return [make("p", "empty", "No incidents for this selection.")];
      return relevant.map((incident) => {
        const card = make("div", "incident");
        card.dataset.kind = incident.kind;
        card.append(make("h3", null, incident.summary));
        card.append(make("p", null,
          `${incident.kind.replace(/_/g, " ")} · ${incident.state.replace(/_/g, " ")} · opened ${clockTime(incident.openedAt)} · ${incident.attempts} delivery attempt${incident.attempts === 1 ? "" : "s"}`));
        if (incident.envelope) card.append(make("pre", "pre", incident.envelope));
        const actions = make("div", "composer__row");
        for (const [label, next] of [["Acknowledge", "acknowledged"], ["Resolve", "resolved"]]) {
          const button = make("button", "btn", label);
          button.type = "button";
          button.disabled = ["resolved", "expired"].includes(incident.state);
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              await api("acknowledgeIncident", { incidentId: incident.incidentId, state: next, reason: `${label} from the visualizer` });
              await loadRun(run.runId);
            } catch (error) {
              setStatus(error.message, "bad");
            }
          });
          actions.append(button);
        }
        actions.append(make("span", "composer__note",
          "Acknowledging never grants approval, delivery authority, push authority or terminal status."));
        card.append(actions);
        return card;
      });
    }

    case "messages": {
      const relevant = run.outbox.filter((message) =>
        subject.kind === "controller"
          ? message.targetAppSessionId === run.controller.session.appSessionId
          : message.targetNodeId === subject.node.nodeId ||
            subject.node.attempts.some((a) => a.session.appSessionId === message.targetAppSessionId));
      if (relevant.length === 0) return [make("p", "empty", "No messages have been sent to this session.")];
      return relevant.map((message) => {
        const card = make("div", "incident");
        card.dataset.kind = "message";
        card.append(make("h3", null, `${message.state} · ${clockTime(message.queuedAt)}`));
        card.append(make("p", null,
          `${message.attempts} delivery attempt${message.attempts === 1 ? "" : "s"} · expires ${clockTime(message.expiresAt)} · ${message.stateReason ?? ""}`));
        card.append(make("pre", "pre", message.body));
        return card;
      });
    }

    default:
      return [make("p", "empty", "Unknown tab.")];
  }
}

function timeline(entries) {
  if (!entries || entries.length === 0) return make("p", "empty", "Nothing recorded yet.");
  const list = make("ul", "timeline");
  for (const entry of [...entries].reverse()) {
    const item = make("li");
    item.dataset.authoritative = String(entry.authoritative === true);
    const time = make("time", null, clockTime(entry.at));
    time.dateTime = entry.at;
    const body = make("span");
    body.append(make("strong", null, `${entry.kind}: `), document.createTextNode(entry.text));
    item.append(time, body);
    list.append(item);
  }
  return list;
}

// ---------------------------------------------------------------------------
// composer
// ---------------------------------------------------------------------------

function renderComposerTargets() {
  const run = state.run;
  const options = [];
  if (run.controller.session.appSessionId) {
    options.push({ value: run.controller.session.appSessionId, label: `${run.controller.label} (orchestrator)`, nodeId: null });
  }
  for (const node of run.dag.nodes) {
    for (const attempt of node.attempts) {
      if (!attempt.session.appSessionId) continue;
      options.push({
        value: attempt.session.appSessionId,
        label: `${node.label} · attempt ${attempt.attemptNumber}`,
        nodeId: node.nodeId,
      });
    }
  }
  const previous = dom.composerTarget.value;
  dom.composerTarget.replaceChildren(...options.map((option) => {
    const node = make("option", null, option.label);
    node.value = option.value;
    node.dataset.nodeId = option.nodeId ?? "";
    return node;
  }));
  if (options.some((option) => option.value === previous)) dom.composerTarget.value = previous;
  dom.composerSend.disabled = options.length === 0 || Boolean(run.outcome);
  if (run.outcome) {
    dom.composerNote.textContent = "The run reached an authoritative outcome; new messages are denied.";
    dom.composerNote.dataset.tone = "";
  }
}

dom.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = dom.composerTarget.value;
  const body = dom.composerBody.value;
  if (!target || body.trim().length === 0) return;
  dom.composerSend.disabled = true;
  dom.composerNote.textContent = "Sending…";
  dom.composerNote.dataset.tone = "";
  try {
    const selected = dom.composerTarget.selectedOptions[0];
    const result = await api("sendMessage", {
      targetAppSessionId: target,
      targetNodeId: selected?.dataset.nodeId || null,
      body,
    });
    if (result.ok) {
      dom.composerNote.textContent = `Queued (${result.state}). The exact text is delivered unchanged.`;
      dom.composerNote.dataset.tone = "ok";
      dom.composerBody.value = "";
    } else {
      dom.composerNote.textContent = result.reason;
      dom.composerNote.dataset.tone = "bad";
    }
    await loadRun(state.run.runId);
  } catch (error) {
    dom.composerNote.textContent = error.message;
    dom.composerNote.dataset.tone = "bad";
  } finally {
    dom.composerSend.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// interaction: zoom, pan, keyboard, responsive overlay
// ---------------------------------------------------------------------------

function setZoom(value) {
  state.zoom = Math.min(2, Math.max(0.35, value));
  dom.canvas.style.setProperty("--zoom", String(state.zoom));
  dom.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function fitGraph() {
  const width = dom.canvas.scrollWidth || 1;
  const available = dom.graph.clientWidth - 28;
  setZoom(Math.min(1, available / width));
  dom.graph.scrollTo({ left: 0, top: 0 });
}

dom.zoomIn.addEventListener("click", () => setZoom(state.zoom + 0.1));
dom.zoomOut.addEventListener("click", () => setZoom(state.zoom - 0.1));
dom.zoomFit.addEventListener("click", fitGraph);
dom.toggleAttempts.addEventListener("change", () => {
  state.expandAll = dom.toggleAttempts.checked;
  state.expanded.clear();
  render();
});
dom.allRuns.addEventListener("click", () => void loadRuns());
dom.back.addEventListener("click", () => {
  state.view = "run";
  render();
});

let panning = null;
dom.graph.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".stage") || event.target.closest("button")) return;
  panning = { x: event.clientX, y: event.clientY, left: dom.graph.scrollLeft, top: dom.graph.scrollTop };
  dom.graph.dataset.panning = "true";
  dom.graph.setPointerCapture(event.pointerId);
});
dom.graph.addEventListener("pointermove", (event) => {
  if (!panning) return;
  dom.graph.scrollLeft = panning.left - (event.clientX - panning.x);
  dom.graph.scrollTop = panning.top - (event.clientY - panning.y);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
  dom.graph.addEventListener(type, () => {
    panning = null;
    dom.graph.dataset.panning = "false";
  });
}
dom.graph.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setZoom(state.zoom - Math.sign(event.deltaY) * 0.1);
}, { passive: false });

dom.graph.addEventListener("keydown", (event) => {
  const nodes = state.run?.dag.nodes ?? [];
  if (nodes.length === 0) return;
  const index = nodes.findIndex((n) => n.nodeId === state.selection?.nodeId);
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(nodes.length - 1, index + 1);
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, index - 1);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = nodes.length - 1;
  else return;
  event.preventDefault();
  if (next < 0) next = 0;
  state.selection = { kind: "node", nodeId: nodes[next].nodeId, attemptId: null };
  render();
  const card = dom.canvas.querySelector(`.stage[data-node-id="${CSS.escape(nodes[next].nodeId)}"]`);
  card?.focus();
  card?.scrollIntoView({ block: "nearest", inline: "nearest" });
});

// Resizable inspector
let resizing = false;
dom.splitter.addEventListener("pointerdown", (event) => {
  resizing = true;
  dom.splitter.setPointerCapture(event.pointerId);
});
window.addEventListener("pointermove", (event) => {
  if (!resizing) return;
  const width = Math.min(720, Math.max(260, window.innerWidth - event.clientX));
  dom.layout.style.setProperty("--inspector-w", `${width}px`);
});
window.addEventListener("pointerup", () => { resizing = false; });
dom.splitter.addEventListener("keydown", (event) => {
  const current = parseInt(getComputedStyle(dom.layout).getPropertyValue("--inspector-w"), 10) || 380;
  if (event.key === "ArrowLeft") dom.layout.style.setProperty("--inspector-w", `${Math.min(720, current + 24)}px`);
  else if (event.key === "ArrowRight") dom.layout.style.setProperty("--inspector-w", `${Math.max(260, current - 24)}px`);
});

const narrow = window.matchMedia("(max-width: 719px)");
function applyResponsive() {
  const isNarrow = narrow.matches;
  dom.overlayToggle.hidden = !isNarrow;
  if (isNarrow) {
    dom.inspector.hidden = dom.overlayToggle.getAttribute("aria-expanded") !== "true";
  } else {
    dom.inspector.hidden = false;
  }
}
function openInspectorOnNarrow() {
  if (!narrow.matches) return;
  dom.overlayToggle.setAttribute("aria-expanded", "true");
  applyResponsive();
  dom.inspector.focus?.();
}
dom.overlayToggle.addEventListener("click", () => {
  const open = dom.overlayToggle.getAttribute("aria-expanded") === "true";
  dom.overlayToggle.setAttribute("aria-expanded", String(!open));
  applyResponsive();
});
narrow.addEventListener("change", applyResponsive);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && narrow.matches) {
    dom.overlayToggle.setAttribute("aria-expanded", "false");
    applyResponsive();
  }
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

(async function start() {
  applyResponsive();
  setZoom(1);
  try {
    await bootstrap();
    state.info = await api("bootstrapInfo");
    connectStream();
    await loadRun(INITIAL_RUN);
    if (!state.run) {
      setStatus(state.info.storageError
        ? `Storage unavailable: ${state.info.storageError}`
        : "No run has been declared in this session yet.", state.info.storageError ? "bad" : "");
      await loadRuns();
    } else {
      requestAnimationFrame(fitGraph);
    }
  } catch (error) {
    setStatus(error.message, "bad");
  }
})();
