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
  await expect(page.getByRole("status")).toHaveText("0 results");
  await expect(page).toHaveScreenshot("empty.png");
  await renderState(page, { count: 0, searching: true });
  await expect(page.getByRole("status")).toHaveText("Searching… 0 results");
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
    300,
  );
  const more = page.getByRole("button", {
    name: "Show next 1 results",
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
  await expect(page.getByRole("tooltip")).toBeHidden();
});
