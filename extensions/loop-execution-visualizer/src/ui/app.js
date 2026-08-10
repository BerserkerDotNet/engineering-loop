// Canvas renderer for the loop execution visualizer.
//
// The renderer is a pure view over the projection: it never derives workflow
// state of its own, so it can never show something the contract would reject.

const params = new URLSearchParams(location.search);
const BOOTSTRAP = params.get("bootstrap") ?? "";
const INITIAL_RUN = params.get("runId") || null;

// The design fixes these eight tabs and their order. They are the contract the
// inspector is checked against, so they are declared once here and consumed by
// both the tab strip and the panel renderer.
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "prompt", label: "Prompt" },
  { id: "timeline", label: "Timeline" },
  { id: "messages", label: "Messages" },
  { id: "usage", label: "Usage/Cost" },
  { id: "outputs", label: "Outputs" },
  { id: "diagnostics", label: "Diagnostics" },
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
  current: false,
  stream: null,
  renewTimer: null,
  runFilters: { skill: "all", status: "all", time: "all" },
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
  runsFilter: el("runs-filter"),
  runsFilterSkill: el("runs-filter-skill"),
  runsFilterStatus: el("runs-filter-status"),
  runsFilterTime: el("runs-filter-time"),
  runsFilterResult: el("runs-filter-result"),
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
  scheduleRenewal(payload.renewAfterMs);
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

function scheduleRenewal(delayMs) {
  if (state.renewTimer) clearTimeout(state.renewTimer);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  state.renewTimer = setTimeout(async () => {
    try {
      const payload = await api("renew");
      state.credential = payload.credential;
      scheduleRenewal(payload.renewAfterMs);
      connectStream();
    } catch (error) {
      setStatus(`Credential renewal failed: ${error.message}`, "warn");
    }
  }, delayMs);
}

function connectStream() {
  state.stream?.close();
  const source = new EventSource(`./events?credential=${encodeURIComponent(state.credential)}`);
  state.stream = source;
  source.addEventListener("hello", () => {
    state.connected = true;
    setStatus(state.current ? "Live" : "Historical snapshot", state.current ? "ok" : "");
  });
  source.addEventListener("run", (event) => {
    const payload = JSON.parse(event.data);
    if (state.view === "run" && payload.run && (!state.run || payload.run.runId === state.run.runId)) {
      state.run = payload.run;
      state.current = payload.current === true;
      render();
    }
  });
  source.addEventListener("credential", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.credential) state.credential = payload.credential;
  });
  source.addEventListener("credential_expired", (event) => {
    const payload = JSON.parse(event.data);
    setStatus(`Credential expired: ${payload.reason}`, "warn");
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
  // A routine tick and an incident must not be announced with the same urgency.
  // Assertive is reserved for facts an operator has to act on, so screen reader
  // users are not interrupted every second by a heartbeat update.
  dom.status.setAttribute("aria-live", tone === "bad" || tone === "warn" ? "assertive" : "polite");
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
    state.current = payload.current === true;
    state.view = "run";
    const url = new URL(location.href);
    url.searchParams.set("runId", payload.run.runId);
    url.searchParams.delete("bootstrap");
    history.replaceState(null, "", url);
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
    const skills = [...new Set(state.runs.map((run) => run.skill).filter(Boolean))].sort();
    dom.runsFilterSkill.replaceChildren(
      new Option("All skills", "all"),
      ...skills.map((skill) => new Option(skill, skill)),
    );
    dom.runsFilterSkill.value = skills.includes(state.runFilters.skill) ? state.runFilters.skill : "all";
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
 * The single word this UI uses for a fact the run does not carry. Defined once
 * so a missing model, a missing heartbeat and a missing cost never appear in
 * three different spellings.
 */
const UNAVAILABLE = "Unavailable";

/**
 * Cost is only ever labelled "actual" when the projection says the provider
 * billed real currency. Copilot credits are always estimated or partial.
 */
function costLabel(usage) {
  if (!usage || usage.confidence === "unavailable") return UNAVAILABLE;
  // Show the reconciled total, not just what live sampling happened to catch.
  const credits = usage.totalCredits ?? usage.credits ?? 0;
  const amount = usage.currency
    ? `${usage.currency} ${credits.toFixed(4)}`
    : `${credits.toFixed(3)} credits`;
  const suffix = usage.confidence === "actual" ? "actual" : usage.confidence;
  return `${amount} (${suffix})`;
}

/**
 * State vocabulary lookups.
 *
 * Every word and colour comes from the contract the extension shipped with, so
 * the renderer can never invent a state, mislabel one, or drift out of step
 * when the contract changes.
 */
function contractAxis(axis) {
  return state.info?.contract?.[axis] ?? null;
}

function stateLabel(axis, value) {
  if (value === undefined || value === null || value === "") return UNAVAILABLE;
  return contractAxis(axis)?.labels?.[value] ?? String(value).replace(/_/g, " ");
}

function stateTone(axis, value) {
  return contractAxis(axis)?.tones?.[value] ?? "neutral";
}

function isSettledNode(value) {
  return (contractAxis("node")?.settled ?? []).includes(value);
}

function expectedLabel(expected) {
  if (!expected) return null;
  const target = expected.sequence === null || expected.sequence === undefined
    ? expected.status
    : `${expected.status} · sequence ${expected.sequence}`;
  return expected.satisfied ? `${target} (received)` : `${target} (outstanding)`;
}

function firstLine(value) {
  const line = String(value).split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
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
  const active = document.activeElement;
  const restoreFocus = active?.classList?.contains("controller-card")
    ? { kind: "controller" }
    : active?.closest?.(".stage")?.dataset?.nodeId
      ? {
        kind: active.classList?.contains("attempt") ? "attempt" : "node",
        nodeId: active.closest(".stage").dataset.nodeId,
        attemptId: active.dataset?.attemptId ?? null,
      }
      : null;
  dom.back.hidden = state.view === "run";
  dom.runsList.hidden = state.view !== "runs";
  dom.runsFilter.hidden = state.view !== "runs";
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
  if (restoreFocus?.kind === "controller") {
    dom.controller.querySelector(".controller-card")?.focus({ preventScroll: true });
  } else if (restoreFocus?.nodeId) {
    const stage = dom.canvas.querySelector(`.stage[data-node-id="${CSS.escape(restoreFocus.nodeId)}"]`);
    const target = restoreFocus.kind === "attempt" && restoreFocus.attemptId
      ? stage?.querySelector(`.attempt[data-attempt-id="${CSS.escape(restoreFocus.attemptId)}"]`)
      : stage;
    target?.focus({ preventScroll: true });
  }
}

function renderSummary() {
  const run = state.run;
  dom.title.textContent = run.title || run.runId;
  dom.title.title = `${run.skill} · ${run.runId}`;

  const done = run.dag.nodes.filter((n) => isSettledNode(n.state)).length;
  const openIncidents = run.incidents.filter((i) => !(contractAxis("incident")?.terminal ?? []).includes(i.state)).length;

  const facts = [
    ["Skill", run.skill],
    ["State", run.outcome ? `${stateLabel("controller", run.state)} · ${run.outcome.outcome}` : stateLabel("controller", run.state)],
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

  if (!state.current) setStatus(`Historical snapshot · updated ${clockTime(run.updatedAt)}`, "");
  else if (!state.connected) setStatus("Reconnecting to the extension…", "warn");
  else if (openIncidents > 0) setStatus(`${openIncidents} open incident${openIncidents === 1 ? "" : "s"}`, "warn");
  else setStatus(`Live · updated ${clockTime(run.updatedAt)}`, "ok");
}

function renderController() {
  const run = state.run;
  const controller = run.controller;
  const card = make("button", "controller-card");
  card.type = "button";
  card.setAttribute("aria-selected", String(state.selection?.kind === "controller"));
  card.append(make("span", "controller-card__pin", "Orchestrator"));
  card.append(make("span", "controller-card__name", controller.label));
  card.append(badge(stateLabel("controller", controller.workflowState), stateTone("controller", controller.workflowState)));
  // Host activity is deliberately shown as a separate, subordinate fact: an
  // idle host is never the same thing as a completed run.
  card.append(badge(`host ${stateLabel("hostActivity", controller.hostActivity)}`, stateTone("hostActivity", controller.hostActivity)));
  card.append(badge(stateLabel("health", controller.session.health), stateTone("health", controller.session.health)));
  card.append(make("span", "stage__meta", duration(controller.elapsedMs)));
  card.append(make("span", "stage__meta", costLabel(controller.usage)));

  // The counts an operator needs to answer "what is this run waiting on?"
  // without opening every stage.
  const counts = new Map();
  for (const node of run.dag.nodes) counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([value, count]) => `${count} ${stateLabel("node", value).toLowerCase()}`)
    .join(" · ");
  if (summary) card.append(make("span", "stage__meta", summary));

  const waitingNodes = (contractAxis("node")?.waiting ?? []);
  const pendingApproval = run.dag.nodes.filter((n) => n.state === "waiting_approval").length;
  const pendingInput = run.dag.nodes.filter((n) => n.state === "waiting_input").length;
  const openIncidents = run.incidents.filter((i) => !(contractAxis("incident")?.terminal ?? []).includes(i.state)).length;
  if (controller.waitingOnNodeIds?.length) {
    card.append(badge(`waiting on ${controller.waitingOnNodeIds.length}`, "warn"));
  } else if (run.dag.nodes.some((n) => waitingNodes.includes(n.state))) {
    card.append(badge("stages waiting", "warn"));
  }
  if (pendingApproval > 0) card.append(badge(`${pendingApproval} awaiting approval`, "warn"));
  if (pendingInput > 0) card.append(badge(`${pendingInput} awaiting input`, "warn"));
  if (openIncidents > 0) card.append(badge(`${openIncidents} open incident${openIncidents === 1 ? "" : "s"}`, "bad"));
  // Freshness is what tells an operator whether they are looking at live data
  // or at the last thing that arrived before a stall.
  card.append(make("span", "stage__meta", controller.session.lastHeartbeatAt
    ? `heartbeat ${clockTime(controller.session.lastHeartbeatAt)}`
    : `heartbeat ${UNAVAILABLE}`));

  card.addEventListener("click", () => {
    state.selection = { kind: "controller", nodeId: null, attemptId: null };
    render();
    openInspectorOnNarrow();
  });
  dom.controller.replaceChildren(card);
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
  const cards = run.dag.nodes.map((node) => renderStage(node, { x: 0, y: 0 }));
  dom.canvas.replaceChildren(...cards);
  const measured = new Map(cards.map((card) => [
    card.dataset.nodeId,
    Math.ceil(card.getBoundingClientRect().height / state.zoom),
  ]));
  let maxBottom = 0;
  for (const [column, nodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let top = 0;
    for (const node of nodes) {
      const height = measured.get(node.nodeId) ?? cardFallbackHeight(node);
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
    // The graph itself is aria-hidden because the stage cards carry the same
    // relationships in text, but a title still gives a sighted user hovering a
    // dashed line the reason it is dashed rather than leaving it to be guessed.
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = edge.addedDuringRun === true
      ? `${edge.from} → ${edge.to} (added during run)`
      : `${edge.from} → ${edge.to}`;
    path.append(title);
    svg.append(path);
  }

  for (const card of cards) {
    const position = positions.get(card.dataset.nodeId);
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
  }
  dom.canvas.replaceChildren(svg, ...cards);
}

function cardFallbackHeight(node) {
  return 96 + (isExpanded(node) ? 24 + node.attempts.length * ROW_H : 0);
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
  const label = `${node.label}, ${stateLabel("node", node.state)}${node.addedDuringRun ? ", added during run" : ""}${attempt ? `, attempt ${attempt.attemptNumber} ${stateLabel("attempt", attempt.state)}` : ""}`;
  card.setAttribute("aria-label", label);

  const head = make("div", "stage__head");
  head.append(make("span", "stage__label", node.label));
  if (node.phase) head.append(make("span", "stage__phase", `Phase ${node.phase}`));
  card.append(head);

  const badges = make("div", "stage__meta");
  badges.append(badge(stateLabel("node", node.state), stateTone("node", node.state)));
  if (node.addedDuringRun) badges.append(badge("Added during run", "neutral"));
  if (attempt?.session?.health && attempt.session.health !== "unknown") {
    badges.append(badge(stateLabel("health", attempt.session.health), stateTone("health", attempt.session.health)));
  }
  card.append(badges);

  const meta = make("div", "stage__meta");
  meta.append(make("span", null, duration(node.elapsedMs)));
  meta.append(make("span", null, attempt?.model ?? UNAVAILABLE));
  meta.append(make("span", null, costLabel(node.usage)));
  card.append(meta);

  // Plan progress and current focus are what make a running stage readable at a
  // glance; the design requires both on the compact card, not only in the
  // inspector.
  const focus = make("div", "stage__meta");
  const progress = attempt?.semantics?.progress ?? null;
  focus.append(make("span", "stage__focus", progress ? firstLine(progress) : "No progress reported"));
  const activity = attempt?.session?.activity;
  if (activity && activity !== "unknown") {
    const detail = attempt.session.activityDetail;
    focus.append(make("span", "stage__focus", detail ? `${stateLabel("hostActivity", activity)} · ${detail}` : stateLabel("hostActivity", activity)));
  }
  card.append(focus);

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
        button.dataset.attemptId = item.attemptId;
        button.setAttribute("aria-selected", String(state.selection?.attemptId === item.attemptId));
        button.append(make("span", "attempt__num", `#${item.attemptNumber}`));
        button.append(make("span", null, item.kind));
        button.append(badge(stateLabel("attempt", item.state), stateTone("attempt", item.state)));
        if (item.session.health === "connection_lost") button.append(badge("Connection lost", "bad"));
        button.append(make("span", "attempt__num", duration(item.elapsedMs)));
        button.setAttribute("aria-label", `Attempt ${item.attemptNumber}, ${item.kind}, ${stateLabel("attempt", item.state)}, ${duration(item.elapsedMs)}`);
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
  const cutoff = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  }[state.runFilters.time] ?? null;
  const runs = (state.runs ?? []).filter((summary) => {
    if (state.runFilters.skill !== "all" && summary.skill !== state.runFilters.skill) return false;
    if (state.runFilters.status === "active" && summary.outcome) return false;
    if (["completed", "failed", "canceled"].includes(state.runFilters.status) &&
        summary.outcome !== state.runFilters.status) return false;
    if (cutoff !== null) {
      const updated = Date.parse(summary.updatedAt ?? summary.createdAt ?? "");
      if (!Number.isFinite(updated) || Date.now() - updated > cutoff) return false;
    }
    return true;
  });
  dom.runsFilterResult.value = `${runs.length} of ${(state.runs ?? []).length} runs`;
  if (runs.length === 0) {
    dom.runsList.replaceChildren(make("li", "empty", "No runs match these filters."));
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
    ? `Controller · ${stateLabel("controller", subject.controller.workflowState)} · host ${stateLabel("hostActivity", subject.controller.hostActivity)}`
    : `${stateLabel("node", subject.node.state)}${subject.attempt ? ` · attempt ${subject.attempt.attemptNumber} (${subject.attempt.kind}) · ${stateLabel("attempt", subject.attempt.state)}` : ""}`;

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

/**
 * Renders label/value pairs. A field the run does not carry is shown as
 * `Unavailable` rather than omitted, because the design requires a missing
 * field to be visibly missing instead of silently absent from the list.
 */
function kvList(pairs) {
  const list = make("dl", "kv");
  for (const [key, value] of pairs) {
    const empty = value === undefined || value === null || value === "";
    const dd = make("dd", null, empty ? UNAVAILABLE : String(value));
    if (empty) dd.dataset.unavailable = "true";
    list.append(make("dt", null, key), dd);
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
          ["Workflow", stateLabel("controller", controller.workflowState)],
          ["Host activity", stateLabel("hostActivity", controller.hostActivity)],
          ["Activity detail", controller.hostActivityDetail],
          ["Activity since", clockTime(controller.hostActivitySince)],
          ["Health", stateLabel("health", controller.session.health)],
          ["Waiting on", controller.waitingOnNodeIds?.join(", ")],
          ["App session", controller.session.appSessionId],
          ["Working directory", controller.session.workingDirectory],
          ["Last heartbeat", clockTime(controller.session.lastHeartbeatAt)],
          ["Elapsed", duration(controller.elapsedMs)],
          ["Reason", controller.stateReason],
        ]));
        // Which host states are not a completion signal is a contract fact, so
        // the reassurance appears for every such state rather than for a list
        // this file happened to remember.
        if ((contractAxis("hostActivity")?.neverImpliesCompletion ?? []).includes(controller.hostActivity)) {
          parts.push(make("p", "empty",
            `The orchestrator host is ${stateLabel("hostActivity", controller.hostActivity).toLowerCase()}. `
            + "That is host activity only and never means the run completed."));
        }
      } else {
        const node = subject.node;
        parts.push(kvList([
          ["Stage", node.label],
          ["State", stateLabel("node", node.state)],
          ["Phase", node.phase],
          ["Role", node.role],
          ["Depends on", node.dependsOn.join(", ")],
          ["Added during run", node.addedDuringRun ? "yes" : "no"],
          ["Attempts", String(node.attempts.length)],
          ["Elapsed", duration(node.elapsedMs)],
          ["Reason", node.stateReason],
        ]));
        if (subject.attempt) {
          parts.push(make("h3", null, `Attempt ${subject.attempt.attemptNumber}`));
          parts.push(kvList([
            ["Kind", subject.attempt.kind],
            ["State", stateLabel("attempt", subject.attempt.state)],
            ["Authoritative failure", subject.attempt.authoritativeFailure ? "yes" : "no"],
            ["Model", subject.attempt.model],
            ["Health", stateLabel("health", subject.attempt.session.health)],
            ["Host activity", stateLabel("hostActivity", subject.attempt.session.activity)],
            ["Activity detail", subject.attempt.session.activityDetail],
            ["App session", subject.attempt.session.appSessionId],
            ["Working directory", subject.attempt.session.workingDirectory],
            ["Last heartbeat", clockTime(subject.attempt.session.lastHeartbeatAt)],
            ["Expected envelope", expectedLabel(subject.attempt.expected)],
            ["Elapsed", duration(subject.attempt.elapsedMs)],
            ["Reason", subject.attempt.stateReason],
          ]));
        }
      }
      return parts;
    }

    case "prompt":
      return semanticField(subject, "prompt", "No prompt was reported for this stage.");
    case "plan":
      return semanticField(subject, "plan", "No plan was reported for this stage.");

    case "timeline": {
      const entries = subject.kind === "controller"
        ? subject.controller.timeline
        : (subject.attempt?.timeline ?? []);
      const parts = [];
      if (subject.kind !== "controller" && !subject.attempt) {
        parts.push(make("p", "empty", "Select an attempt to see its timeline."));
        return parts;
      }
      parts.push(timeline(entries));
      return parts;
    }

    case "outputs": {
      const semantics = subject.attempt?.semantics ?? subject.controller?.semantics ?? null;
      const parts = [];
      parts.push(make("h3", null, "Progress"));
      parts.push(...semanticField(subject, "progress", "No progress note was reported for this stage."));
      parts.push(make("h3", null, "Details"));
      parts.push(...semanticField(subject, "details", "No details were reported for this stage."));
      parts.push(make("h3", null, "Artifacts"));
      const artifacts = semantics?.artifacts ?? [];
      if (artifacts.length === 0) {
        parts.push(make("p", "empty", "No artifacts were reported for this stage."));
      } else {
        const list = make("ul", "timeline");
        for (const artifact of artifacts) list.append(make("li", null, String(artifact)));
        parts.push(list);
      }
      return parts;
    }

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
        parts.push(kvList(run.priceSnapshots.map((snapshot) => [snapshot.snapshotId, `${snapshot.modelCount} models · ${clockTime(snapshot.at)}`])));
      }
      return parts;
    }

    case "diagnostics": {
      const relevant = run.incidents.filter((incident) =>
        subject.kind === "controller" ? true : incident.subjectNodeId === subject.node.nodeId);
      const parts = [make("h3", null, "Incidents")];
      if (relevant.length === 0) {
        parts.push(make("p", "empty", "No incidents for this selection."));
      } else {
        parts.push(...relevant.map((incident) => {
        const card = make("div", "incident");
        card.dataset.kind = incident.kind;
        card.append(make("h3", null, incident.summary));
        card.append(make("p", null,
          `${incident.kind.replace(/_/g, " ")} · ${stateLabel("incident", incident.state)} · opened ${clockTime(incident.openedAt)} · ${incident.attempts} delivery attempt${incident.attempts === 1 ? "" : "s"}`));
        if (incident.envelope) card.append(make("pre", "pre", incident.envelope));
        const actions = make("div", "composer__row");
        for (const [label, next] of [["Acknowledge", "acknowledged"], ["Resolve", "resolved"]]) {
          const button = make("button", "btn", label);
          button.type = "button";
          button.disabled = !state.current || (contractAxis("incident")?.terminal ?? []).includes(incident.state);
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const result = await api("acknowledgeIncident", {
                runId: run.runId,
                incidentId: incident.incidentId,
                state: next,
                reason: `${label} from the visualizer`,
              });
              if (!result.ok) throw new Error(result.reason ?? `${label} was refused`);
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
        }));
      }

      // Integrity issues are the other half of diagnostics: a projection that
      // had to skip or quarantine a record must say so where an operator will
      // look, rather than only in the log.
      const issues = run.integrity?.notes ?? [];
      parts.push(make("h3", null, "Integrity"));
      parts.push(kvList([
        ["Events applied", run.integrity?.eventsApplied],
        ["Rejected", run.integrity?.rejected],
        ["Quarantined", run.integrity?.quarantined],
        ["Truncated records", run.integrity?.truncated],
        ["Dropped by retention", run.integrity?.retentionDroppedEvents],
      ]));
      if (issues.length === 0) {
        parts.push(make("p", "empty", "No integrity issues were recorded for this run."));
      } else {
        const list = make("ul", "timeline");
        for (const issue of issues) list.append(make("li", null, String(issue)));
        parts.push(list);
      }
      return parts;
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
        card.append(make("h3", null, `${stateLabel("outbox", message.state)} · ${clockTime(message.queuedAt)}`));
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
  dom.composerSend.disabled = !state.current || options.length === 0 || Boolean(run.outcome);
  if (!state.current) {
    dom.composerNote.textContent = "Historical runs are read-only. Return to the attached run to send a message.";
    dom.composerNote.dataset.tone = "";
    return;
  }
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
      runId: state.run.runId,
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
for (const [control, key] of [
  [dom.runsFilterSkill, "skill"],
  [dom.runsFilterStatus, "status"],
  [dom.runsFilterTime, "time"],
]) {
  control.addEventListener("change", () => {
    state.runFilters[key] = control.value;
    renderRunsList();
  });
}
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
