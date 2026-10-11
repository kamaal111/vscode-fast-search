import AxeBuilder from "@axe-core/playwright";
import { test, expect, renderState } from "./fixtures.js";

test("renders a compact sidebar without horizontal overflow", async ({
  page,
}) => {
  await renderState(page);
  const layout = await page.evaluate(() => {
    const form = document.querySelector("form");
    const query = document.querySelector("#query");
    const options = document.querySelector(".toggles");
    if (form === null || query === null || options === null)
      throw new Error("Missing search controls");
    return {
      left:
        form.getBoundingClientRect().left +
        parseFloat(getComputedStyle(form).paddingLeft),
      right: parseFloat(getComputedStyle(form).paddingRight),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      queryRight: query.getBoundingClientRect().right,
      optionsRight: options.getBoundingClientRect().right,
    };
  });
  expect(layout.left).toBe(0);
  expect(layout.right).toBe(0);
  expect(layout.overflow).toBe(false);
  expect(layout.optionsRight).toBeLessThanOrEqual(layout.queryRight);
  await expect(page).toHaveScreenshot("results.png");
});

test("aligns indented source previews with file icons and opens original columns", async ({
  page,
  messages,
}) => {
  await renderState(page, { indent: " \t " });
  const preview = page.locator(".match-preview").first();
  await expect(preview).toHaveText('let value = "searchable fixture"');
  await expect(preview.locator("mark")).toHaveText("searchable fixture");
  const iconBounds = await page.locator(".file-icon").boundingBox();
  const previewBounds = await preview.boundingBox();
  expect(previewBounds?.x).toBe(iconBounds?.x);
  await preview.click();
  expect(messages).toContainEqual({
    type: "open",
    uri: "file:///workspace/src/Result.swift",
    line: 1,
    column: 16,
    endLine: 1,
    endColumn: 34,
  });
});

test("shows hover help inside the viewport and dismisses it with Escape", async ({
  page,
}) => {
  await renderState(page);
  await page
    .getByRole("button", { name: "Match Whole Word", exact: true })
    .hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(
    "Match complete words rather than parts of words.",
  );
  const bounds = await tooltip.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  await expect(page).toHaveScreenshot("hover-help.png");
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("supports keyboard focus, toggle activation, and Enter to search", async ({
  page,
  messages,
}) => {
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("combobox", { name: "Search", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("Press Enter");
  await page.keyboard.press("Tab");
  const matchCase = page.getByRole("button", {
    name: "Match Case",
    exact: true,
  });
  await expect(matchCase).toBeFocused();
  await page.keyboard.press("Space");
  await expect(matchCase).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({ type: "toggle", field: "caseSensitive", value: true });
  await page
    .getByRole("combobox", { name: "Search", exact: true })
    .fill("fixture");
  await page.keyboard.press("Enter");
  await expect.poll(() => messages.at(-1)).toEqual({ type: "search" });
});

test("sends filter updates and cancellation", async ({ page, messages }) => {
  await page.getByRole("textbox", { name: "files to include" }).click();
  await page
    .getByRole("textbox", { name: "files to include" })
    .fill("**/*.swift");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({ type: "update", field: "include", value: "**/*.swift" });
  await page.getByRole("textbox", { name: "files to exclude" }).click();
  await page
    .getByRole("textbox", { name: "files to exclude" })
    .fill("**/generated/**");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({ type: "update", field: "exclude", value: "**/generated/**" });
  await page.getByRole("button", { name: "Cancel Search" }).click();
  await expect.poll(() => messages.at(-1)).toEqual({ type: "cancel" });
});

test("navigates results with arrows and opens the selected match", async ({
  page,
  messages,
}) => {
  await renderState(page);
  const rows = page.getByRole("treeitem", { name: /column 14:/ });
  await rows.nth(0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({
      type: "open",
      uri: "file:///workspace/src/Result.swift",
      line: 2,
      column: 13,
      endLine: 2,
      endColumn: 31,
    });
});

test("renders empty, loading, and error states", async ({ page }) => {
  await renderState(page, { count: 0 });
  await expect(page.getByRole("status")).toHaveText("0 results in 0 files");
  await expect(page).toHaveScreenshot("empty.png");
  await renderState(page, { count: 0, searching: true });
  await expect(page.getByRole("status")).toHaveText(
    "Searching… 0 results in 0 files",
  );
  await expect(page).toHaveScreenshot("loading.png");
  await renderState(page, { count: 0, error: "Invalid regular expression" });
  await expect(page.getByRole("status")).toHaveText(
    "Invalid regular expression",
  );
  await expect(page).toHaveScreenshot("error.png");
});

test("has no automated WCAG accessibility violations", async ({ page }) => {
  await renderState(page);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test("shows the remaining pagination batch and clears obsolete result help", async ({
  page,
}) => {
  await renderState(page, { count: 301 });
  await expect(page.getByRole("treeitem", { name: /column 14:/ })).toHaveCount(
    299,
  );
  const more = page.getByRole("button", {
    name: "Show next 2 rows",
    exact: true,
  });
  await more.click();
  await expect(page.getByRole("treeitem", { name: /column 14:/ })).toHaveCount(
    301,
  );
  await expect(more).toHaveCount(0);
  const row = page.getByRole("treeitem", { name: /column 14:/ }).last();
  await row.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("tooltip")).toBeVisible();
  await renderState(page, { count: 0 });
  await expect(
    page.getByRole("combobox", { name: "Search", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("tooltip")).not.toContainText("Open /workspace");
});

test("collapses files, retains counts during streaming, and resets on a new search", async ({
  page,
}) => {
  await renderState(page, { count: 301 });
  const file = page.getByRole("treeitem", { name: /^Result.swift,/ });
  await expect(file).toHaveAccessibleName("Result.swift, src, 301 matches");
  await file.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("treeitem", { name: /column 14:/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: /Show next/ })).toHaveCount(0);
  await renderState(page, { count: 302, searching: true });
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await expect(file).toBeFocused();
  await expect(file).toHaveAccessibleName("Result.swift, src, 302 matches");
  await renderState(page, { count: 2, session: 2 });
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("treeitem", { name: /column 14:/ })).toHaveCount(
    2,
  );
});

test("dismisses a match without opening, updates counts, and restores keyboard focus", async ({
  page,
  messages,
}) => {
  await renderState(page);
  await page
    .getByRole("button", {
      name: "Dismiss match at line 2, column 14 in Result.swift",
      exact: true,
    })
    .click();
  await expect
    .poll(() => messages.at(-1))
    .toEqual({
      type: "dismissMatch",
      session: 1,
      id: JSON.stringify(["file:///workspace/src/Result.swift", 1, 13, 1, 31]),
    });
  expect(messages).toHaveLength(1);
  await renderState(page, { count: 1, firstLine: 2 });
  await expect(
    page.getByRole("treeitem", { name: /^Result.swift,/ }),
  ).toHaveAccessibleName("Result.swift, src, 1 match");
  await expect(page.getByRole("status")).toHaveText("1 result in 1 file");
  await page.getByRole("treeitem", { name: /column 14:/ }).focus();
  await page.keyboard.press("Delete");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({
      type: "dismissMatch",
      session: 1,
      id: JSON.stringify(["file:///workspace/src/Result.swift", 2, 13, 2, 31]),
    });
  await renderState(page, { count: 0 });
  await expect(page.getByRole("treeitem")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Search", exact: true }),
  ).toBeFocused();
});

test("dismisses an entire file using its inline action without opening it", async ({
  page,
  messages,
}) => {
  await renderState(page);
  await page
    .getByRole("button", {
      name: "Dismiss results in Result.swift",
      exact: true,
    })
    .click();
  await expect
    .poll(() => messages.at(-1))
    .toEqual({
      type: "dismissFile",
      session: 1,
      uri: "file:///workspace/src/Result.swift",
    });
  expect(messages).toHaveLength(1);
  await renderState(page, { count: 0 });
  await expect(page.getByRole("treeitem")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("0 results in 0 files");
});
