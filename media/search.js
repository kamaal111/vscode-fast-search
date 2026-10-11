const vscode = acquireVsCodeApi();
const query = document.querySelector("#query");
const include = document.querySelector("#include");
const exclude = document.querySelector("#exclude");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
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
let visibleMatches = pageSize;
let previousCount = 0;
for (const [element, field] of [
  [query, "query"],
  [include, "include"],
  [exclude, "exclude"],
])
  element.addEventListener("input", () =>
    vscode.postMessage({ type: "update", field, value: element.value }),
  );
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
  document.querySelector("#history").replaceChildren(
    ...data.history.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }),
  );
  status.textContent =
    state.error ??
    data.indexStatus ??
    data.announcement ??
    (state.searching
      ? `Searching… ${state.results.length} results`
      : `${state.results.length} results${state.warnings.length ? ` · ${state.warnings.length} skipped` : ""}`);
  if (state.results.length < previousCount) visibleMatches = pageSize;
  previousCount = state.results.length;
  const sections = [];
  let rendered = 0;
  for (const group of data.groups) {
    if (rendered >= visibleMatches) break;
    const section = document.createElement("div");
    section.className = "result-group";
    const heading = document.createElement("div");
    heading.className = "result-heading";
    heading.setAttribute("role", "treeitem");
    heading.setAttribute("aria-expanded", "true");
    heading.setAttribute("aria-level", "1");
    heading.textContent = group.uri.replace("file://", "");
    section.append(heading);
    const children = document.createElement("div");
    children.setAttribute("role", "group");
    for (const match of group.matches.slice(0, visibleMatches - rendered)) {
      const row = document.createElement("button");
      row.className = "result";
      row.type = "button";
      const path = match.uri.replace("file://", "");
      row.setAttribute(
        "aria-label",
        `${path}, line ${match.line + 1}, column ${match.startColumn + 1}: ${match.preview}`,
      );
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", "2");
      const location = document.createElement("span");
      location.className = "location";
      location.textContent = `${match.line + 1}:${match.startColumn + 1}  `;
      const before = document.createTextNode(
        match.preview.slice(0, match.previewStart),
      );
      const highlight = document.createElement("mark");
      highlight.textContent = match.preview.slice(
        match.previewStart,
        match.previewEnd,
      );
      const after = document.createTextNode(
        match.preview.slice(match.previewEnd),
      );
      row.append(location, before, highlight, after);
      describeControl(
        row,
        `result-help-${rendered}`,
        `Open ${path} at line ${match.line + 1}, column ${match.startColumn + 1} and select this match.`,
      );
      row.addEventListener("click", () =>
        vscode.postMessage({
          type: "open",
          uri: match.uri,
          line: match.line,
          column: match.startColumn,
          endLine: match.endLine,
          endColumn: match.endColumn,
        }),
      );
      children.append(row);
      rendered += 1;
    }
    section.append(children);
    sections.push(section);
  }
  if (rendered < state.results.length) {
    const more = document.createElement("button");
    more.className = "show-more";
    more.type = "button";
    const nextCount = Math.min(pageSize, state.results.length - rendered);
    more.textContent = `Show next ${nextCount} results`;
    more.setAttribute("aria-label", more.textContent);
    describeControl(
      more,
      "more-help",
      `Display the next ${nextCount} search results.`,
    );
    more.addEventListener("click", () => {
      visibleMatches += pageSize;
      window.dispatchEvent(new MessageEvent("message", { data }));
    });
    sections.push(more);
  }
  if (helpTarget !== undefined && results.contains(helpTarget)) hideHelp();
  results.replaceChildren(...sections);
});
results.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...results.querySelectorAll(".result")];
  const current = rows.indexOf(document.activeElement);
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const next =
    rows[Math.max(0, Math.min(rows.length - 1, current + direction))];
  if (next !== undefined) {
    event.preventDefault();
    next.focus();
  }
});
