const vscode = acquireVsCodeApi();
const query = document.querySelector("#query");
const include = document.querySelector("#include");
const exclude = document.querySelector("#exclude");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
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
document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  vscode.postMessage({ type: "search" });
});
document
  .querySelector("#cancel")
  .addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
document.querySelector("#useExcludes").addEventListener("change", (event) =>
  vscode.postMessage({
    type: "toggle",
    field: "useExcludes",
    value: event.target.checked,
  }),
);
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
  document.querySelector("#useExcludes").checked = state.options.useExcludes;
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
    more.textContent = `Show next ${Math.min(pageSize, state.results.length - rendered)} results`;
    more.addEventListener("click", () => {
      visibleMatches += pageSize;
      window.dispatchEvent(new MessageEvent("message", { data }));
    });
    sections.push(more);
  }
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
