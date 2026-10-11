const vscode = acquireVsCodeApi();
const query = document.querySelector("#query");
const include = document.querySelector("#include");
const exclude = document.querySelector("#exclude");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const resultsScroll = document.querySelector("#results-scroll");
const tooltip = document.querySelector("#control-tooltip");
let helpTarget;
let showTimer;
let hideTimer;
let keyboardHelp = false;
let pointerFocus = false;

function hideHelp() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  tooltip.hidden = true;
  tooltip.textContent = "";
  helpTarget = undefined;
  keyboardHelp = false;
}

function positionHelp() {
  if (helpTarget === undefined || tooltip.hidden) return;
  const anchor = helpTarget.getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  const margin = 4;
  const left = Math.max(
    margin,
    Math.min(anchor.left, window.innerWidth - bounds.width - margin),
  );
  const below = anchor.bottom + margin;
  const top =
    below + bounds.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, anchor.top - bounds.height - margin);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function showHelp(target, fromKeyboard = false) {
  const description = document.getElementById(target.dataset.help);
  if (description === null) return;
  helpTarget = target;
  keyboardHelp = fromKeyboard;
  const name =
    target.getAttribute("aria-label") ??
    target.labels?.[0]?.textContent ??
    target.textContent;
  tooltip.textContent = `${name.trim()} — ${description.textContent}`;
  tooltip.hidden = false;
  positionHelp();
}

function helpControl(target) {
  return target instanceof Element ? target.closest("[data-help]") : null;
}

document.addEventListener("mouseover", (event) => {
  if (tooltip.contains(event.target)) {
    clearTimeout(hideTimer);
    return;
  }
  const target = helpControl(event.target);
  if (target === null) return;
  if (target === helpTarget) {
    clearTimeout(hideTimer);
    if (!tooltip.hidden) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showHelp(target), 300);
    return;
  }
  hideHelp();
  helpTarget = target;
  showTimer = setTimeout(() => showHelp(target), 300);
});
document.addEventListener("mouseout", (event) => {
  const target = helpControl(event.target);
  if (target !== helpTarget && !tooltip.contains(event.target)) return;
  if (
    event.relatedTarget instanceof Node &&
    (helpTarget?.contains(event.relatedTarget) ||
      tooltip.contains(event.relatedTarget))
  )
    return;
  clearTimeout(showTimer);
  hideTimer = setTimeout(hideHelp, 100);
});
document.addEventListener("focusin", (event) => {
  hideHelp();
  const target = helpControl(event.target);
  if (target !== null && !pointerFocus) showHelp(target, true);
});
document.addEventListener("focusout", hideHelp);
document.addEventListener("pointermove", () => {
  if (keyboardHelp) hideHelp();
});
document.addEventListener("pointerdown", () => {
  pointerFocus = true;
  hideHelp();
});
document.addEventListener(
  "keydown",
  (event) => {
    pointerFocus = false;
    if (event.key === "Escape") hideHelp();
  },
  true,
);
window.addEventListener("resize", hideHelp);
document.addEventListener(
  "scroll",
  (event) => {
    if (tooltip.contains(event.target)) return;
    if (keyboardHelp && helpTarget === document.activeElement) positionHelp();
    else hideHelp();
  },
  true,
);

function describeControl(control, id, description) {
  const help = document.createElement("span");
  help.id = id;
  help.className = "sr-only";
  help.textContent = description;
  control.dataset.help = id;
  control.setAttribute("aria-describedby", id);
  control.append(help);
}

const pageSize = 300;
let visibleRows = pageSize;
let session;
let latestData;
const collapsed = new Set();
const pagination = document.querySelector("#result-pagination");
function registerHistory(element, field) {
  let snapshot;
  let cursor;
  const reset = () => {
    snapshot = undefined;
    cursor = undefined;
  };
  element.addEventListener("blur", reset);
  element.addEventListener("input", () => {
    reset();
    vscode.postMessage({ type: "update", field, value: element.value });
  });
  element.addEventListener("keydown", (event) => {
    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const history = latestData?.history[field] ?? [];
    if (snapshot === undefined) {
      if (history.length === 0) return;
      snapshot = [...history];
      cursor = -1;
    }
    event.preventDefault();
    let value;
    if (event.key === "ArrowUp") {
      let next = Math.min(cursor + 1, snapshot.length - 1);
      if (snapshot[next] === element.value && next < snapshot.length - 1)
        next += 1;
      cursor = next;
      value = snapshot[cursor];
    } else {
      cursor = Math.max(cursor - 1, -1);
      value = cursor < 0 ? "" : snapshot[cursor];
    }
    if (value === element.value) return;
    element.value = value;
    element.setSelectionRange(value.length, value.length);
    document.querySelector("#history-announcement").textContent =
      value || "Cleared input";
    hideHelp();
    vscode.postMessage({ type: "update", field, value });
  });
}
for (const [element, field] of [
  [query, "query"],
  [include, "include"],
  [exclude, "exclude"],
])
  registerHistory(element, field);
const form = document.querySelector("#search-form");
form.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.isComposing &&
    event.target instanceof HTMLInputElement
  ) {
    event.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  vscode.postMessage({ type: "search" });
});
document
  .querySelector("#cancel")
  .addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
for (const button of document.querySelectorAll("[data-toggle]"))
  button.addEventListener("click", () => {
    const value = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(value));
    vscode.postMessage({ type: "toggle", field: button.dataset.toggle, value });
  });
window.addEventListener("message", ({ data }) => {
  if (data.type === "iconTheme") {
    document.querySelector("#file-icon-theme").textContent = data.css;
    return;
  }
  if (data.type !== "state") return;
  const state = data.state;
  for (const [element, value] of [
    [query, state.query],
    [include, state.include],
    [exclude, state.exclude],
  ])
    if (document.activeElement !== element) element.value = value;
  for (const button of document.querySelectorAll("[data-toggle]"))
    button.setAttribute(
      "aria-pressed",
      String(Boolean(state.options[button.dataset.toggle])),
    );
  latestData = data;
  if (session !== state.session) {
    session = state.session;
    collapsed.clear();
    visibleRows = pageSize;
    resultsScroll.scrollTop = 0;
  }

  const count = state.results.length;
  const files = data.groups.length;
  status.textContent =
    state.error ??
    data.indexStatus ??
    data.announcement ??
    `${state.searching ? "Searching… " : ""}${count} ${count === 1 ? "result" : "results"} in ${files} ${files === 1 ? "file" : "files"}${state.warnings.length ? ` · ${state.warnings.length} skipped` : ""}`;
  renderResults();
});

function treeRows() {
  return [...results.querySelectorAll('[role="treeitem"]')];
}

function focusRow(row, options = {}) {
  for (const item of treeRows()) item.tabIndex = item === row ? 0 : -1;
  row?.focus(options);
}

function dismiss(row) {
  if (row === null || latestData === undefined) return;
  const message =
    row.dataset.kind === "file"
      ? { type: "dismissFile", session, uri: row.dataset.uri }
      : { type: "dismissMatch", session, id: row.dataset.matchId };
  vscode.postMessage(message);
}

function toggleFile(uri) {
  if (collapsed.has(uri)) collapsed.delete(uri);
  else collapsed.add(uri);
  renderResults();
}

function dismissButton(row, name, helpId) {
  const button = document.createElement("button");
  button.type = "button";
  button.tabIndex = -1;
  button.className = "dismiss-result";
  button.setAttribute("aria-label", name);
  button.textContent = "×";
  describeControl(
    button,
    helpId,
    "Hide these search results. Files are not changed; running a new search restores matching results.",
  );
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss(row);
  });
  return button;
}

function renderResults() {
  if (latestData === undefined) return;
  const { groups, showLineNumbers } = latestData;
  const oldRows = treeRows();
  const paginationFocused = pagination.contains(document.activeElement);
  const active = document.activeElement?.closest('[role="treeitem"]');
  const activeKey = active?.dataset.key;
  const actionFocused =
    document.activeElement?.classList.contains("dismiss-result");
  const oldIndex = oldRows.indexOf(active);
  const scrollTop = resultsScroll.scrollTop;
  const sections = [];
  let rendered = 0;
  let totalRows = 0;
  for (const group of groups) {
    const expanded = !collapsed.has(group.uri);
    totalRows += 1 + (expanded ? group.matches.length : 0);
    if (rendered >= visibleRows) continue;
    const section = document.createElement("div");
    section.className = "result-group";
    section.setAttribute("role", "treeitem");
    section.setAttribute("aria-expanded", String(expanded));
    section.setAttribute("aria-level", "1");
    section.setAttribute(
      "aria-label",
      `${group.filename}, ${group.directory || "project root"}, ${group.count} ${group.count === 1 ? "match" : "matches"}`,
    );
    section.dataset.kind = "file";
    section.dataset.uri = group.uri;
    section.dataset.key = `file:${group.uri}`;
    section.tabIndex = -1;
    const heading = document.createElement("div");
    heading.className = "result-heading";
    heading.title = group.path;
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = expanded ? "⌄" : "›";
    const icon = document.createElement("span");
    icon.className = `file-icon ${group.icon ?? ""}`;
    icon.hidden = !group.icon;
    icon.setAttribute("aria-hidden", "true");
    const filename = document.createElement("span");
    filename.className = "filename";
    filename.textContent = group.filename;
    const directory = document.createElement("span");
    directory.className = "directory";
    directory.textContent = group.directory;
    const badge = document.createElement("span");
    badge.className = "match-count";
    badge.textContent = String(group.count);
    badge.title = `${group.count} matches found`;
    heading.append(
      chevron,
      icon,
      filename,
      directory,
      badge,
      dismissButton(
        section,
        `Dismiss results in ${group.filename}`,
        `file-dismiss-help-${rendered}`,
      ),
    );
    heading.addEventListener("click", () => {
      focusRow(section);
      toggleFile(group.uri);
    });
    section.append(heading);
    rendered += 1;
    const children = document.createElement("div");
    children.setAttribute("role", "group");
    if (expanded)
      for (const match of group.matches) {
        if (rendered >= visibleRows) break;
        const row = document.createElement("div");
        row.className = "result";
        row.tabIndex = -1;
        row.dataset.kind = "match";
        row.dataset.uri = group.uri;
        row.dataset.matchId = match.id;
        row.dataset.key = `match:${match.id}`;
        row.setAttribute(
          "aria-label",
          `${group.path}, line ${match.line + 1}, column ${match.startColumn + 1}: ${match.preview}`,
        );
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", "2");
        const preview = document.createElement("span");
        preview.className = "match-preview";
        if (showLineNumbers || match.endLine > match.line) {
          const location = document.createElement("span");
          location.className = "location";
          location.textContent = `${showLineNumbers ? `${match.line + 1}:` : ""}${match.endLine > match.line ? `+${match.endLine - match.line}` : ""} `;
          preview.append(location);
        }
        const highlight = document.createElement("mark");
        highlight.textContent = match.preview.slice(
          match.previewStart,
          match.previewEnd,
        );
        preview.append(
          document.createTextNode(
            match.preview.slice(0, match.previewStart).trimStart(),
          ),
          highlight,
          document.createTextNode(match.preview.slice(match.previewEnd)),
        );
        describeControl(
          row,
          `result-help-${rendered}`,
          `Open ${group.path} at line ${match.line + 1}, column ${match.startColumn + 1} and select this match.`,
        );
        row.append(
          preview,
          dismissButton(
            row,
            `Dismiss match at line ${match.line + 1}, column ${match.startColumn + 1} in ${group.filename}`,
            `match-dismiss-help-${rendered}`,
          ),
        );
        row.addEventListener("click", () => {
          focusRow(row);
          vscode.postMessage({
            type: "open",
            uri: match.uri,
            line: match.line,
            column: match.startColumn,
            endLine: match.endLine,
            endColumn: match.endColumn,
          });
        });
        children.append(row);
        rendered += 1;
      }
    if (children.childElementCount > 0) section.append(children);
    sections.push(section);
  }
  if (
    helpTarget !== undefined &&
    (results.contains(helpTarget) || pagination.contains(helpTarget))
  )
    hideHelp();
  results.replaceChildren(...sections);
  pagination.replaceChildren();
  if (rendered < totalRows) {
    const more = document.createElement("button");
    more.className = "show-more";
    more.type = "button";
    const nextCount = Math.min(pageSize, totalRows - rendered);
    more.textContent = `Show next ${nextCount} rows`;
    more.setAttribute("aria-label", more.textContent);
    describeControl(
      more,
      "more-help",
      `Display the next ${nextCount} file and match rows.`,
    );
    more.addEventListener("click", () => {
      const previousRowCount = treeRows().length;
      visibleRows += pageSize;
      renderResults();
      focusRow(treeRows()[previousRowCount], { preventScroll: true });
    });
    pagination.append(more);
  }
  const rows = treeRows();
  let next = rows.find((row) => row.dataset.key === activeKey);
  if (
    next === undefined &&
    active?.dataset.kind === "match" &&
    collapsed.has(active.dataset.uri)
  )
    next = rows.find(
      (row) =>
        row.dataset.kind === "file" && row.dataset.uri === active.dataset.uri,
    );
  next ??= rows[Math.min(Math.max(oldIndex, 0), rows.length - 1)];
  if (next !== undefined) {
    next.tabIndex = 0;
    if (oldIndex >= 0) {
      const focus =
        actionFocused && next.dataset.key === activeKey
          ? next.querySelector(
              ":scope > .dismiss-result, :scope > .result-heading > .dismiss-result",
            )
          : next;
      (focus ?? next).focus({ preventScroll: true });
    }
  } else if (oldIndex >= 0) query.focus({ preventScroll: true });
  if (paginationFocused) {
    if (pagination.firstElementChild !== null)
      pagination.firstElementChild.focus({ preventScroll: true });
    else if (rows.length > 0) focusRow(rows.at(-1), { preventScroll: true });
    else query.focus({ preventScroll: true });
  }
  resultsScroll.scrollTop = scrollTop;
}

results.addEventListener("focusin", (event) => {
  const row = event.target.closest('[role="treeitem"]');
  if (row === null) return;
  for (const item of treeRows()) {
    item.tabIndex = item === row ? 0 : -1;
    const button = item.querySelector(
      ":scope > .dismiss-result, :scope > .result-heading > .dismiss-result",
    );
    if (button !== null) button.tabIndex = item === row ? 0 : -1;
  }
});
results.addEventListener("keydown", (event) => {
  const row = event.target.closest('[role="treeitem"]');
  if (row === null) return;
  const rows = treeRows();
  const index = rows.indexOf(row);
  let next;
  if (event.key === "ArrowDown")
    next = rows[Math.min(rows.length - 1, index + 1)];
  else if (event.key === "ArrowUp") next = rows[Math.max(0, index - 1)];
  else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows.at(-1);
  else if (event.key === "ArrowLeft") {
    if (row.dataset.kind === "file") {
      if (!collapsed.has(row.dataset.uri)) toggleFile(row.dataset.uri);
    } else next = row.closest(".result-group");
  } else if (event.key === "ArrowRight") {
    if (row.dataset.kind === "file") {
      if (collapsed.has(row.dataset.uri)) toggleFile(row.dataset.uri);
      else
        next =
          rows[index + 1]?.dataset.kind === "match"
            ? rows[index + 1]
            : undefined;
    }
  } else if (
    event.key === "Delete" ||
    (event.key === "Backspace" && event.metaKey)
  )
    dismiss(row);
  else if (
    (event.key === "Enter" || event.key === " ") &&
    event.target === row
  ) {
    if (row.dataset.kind === "file") toggleFile(row.dataset.uri);
    else row.click();
  } else return;
  event.preventDefault();
  if (next !== undefined) focusRow(next);
});

vscode.postMessage({ type: "ready" });
