import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { test, expect, renderState } from "./fixtures.js";

async function expectViewportScrollContained(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
    documentScroll: window.scrollY,
    bodyScroll: document.body.scrollTop,
  }));
  expect(metrics.documentHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.documentScroll).toBe(0);
  expect(metrics.bodyScroll).toBe(0);
}

test("contains repeated scrolling beyond the pagination button", async ({
  page,
}) => {
  await renderState(page, { count: 1000 });
  const form = page.locator("#search-form");
  const status = page.getByRole("status");
  const formBounds = await form.boundingBox();
  const statusBounds = await status.boundingBox();
  const more = page.getByRole("button", {
    name: "Show next 300 rows",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await expect(more).toBeInViewport();
  await page.mouse.move(90, 460);
  await page.mouse.wheel(0, 10000);
  await page.mouse.wheel(0, 10000);
  await expectViewportScrollContained(page);
  expect(await form.boundingBox()).toEqual(formBounds);
  expect(await status.boundingBox()).toEqual(statusBounds);
  await page.mouse.wheel(0, -10000);
  await expect
    .poll(() =>
      page.locator("#results-scroll").evaluate((node) => node.scrollTop),
    )
    .toBe(0);
  await expectViewportScrollContained(page);
});

for (const activation of [
  { name: "click", run: (button: Locator) => button.click() },
  { name: "Enter", run: (button: Locator) => button.press("Enter") },
  { name: "Space", run: (button: Locator) => button.press("Space") },
]) {
  test(`keeps the batch boundary when loading with ${activation.name}`, async ({
    page,
  }) => {
    await renderState(page, { count: 1000 });
    const rows = page.getByRole("treeitem");
    const scroller = page.locator("#results-scroll");
    for (const batch of [
      { loaded: 300, next: 300, total: 600 },
      { loaded: 600, next: 300, total: 900 },
      { loaded: 900, next: 101, total: 1001 },
    ]) {
      const more = page.getByRole("button", {
        name: `Show next ${batch.next} rows`,
        exact: true,
      });
      await more.scrollIntoViewIfNeeded();
      await more.focus();
      await page.keyboard.press("Escape");
      const scrollTop = await scroller.evaluate((node) => node.scrollTop);
      await activation.run(more);
      await expect(rows).toHaveCount(batch.total);
      await expect(rows.nth(batch.loaded)).toBeFocused();
      await expect(rows.nth(batch.loaded)).toBeInViewport();
      expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);
      await expectViewportScrollContained(page);
    }
    await expect(page.getByRole("button", { name: /Show next/ })).toHaveCount(
      0,
    );
  });
}

test("resets scrolling for a new paginated search session", async ({
  page,
}) => {
  await renderState(page, { count: 1000 });
  await page
    .getByRole("button", { name: "Show next 300 rows", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.locator("#results-scroll").evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(0);
  await renderState(page, { count: 1000, session: 2 });
  expect(
    await page.locator("#results-scroll").evaluate((node) => node.scrollTop),
  ).toBe(0);
  await expectViewportScrollContained(page);
});

test("retains pagination focus and scrolling during streaming and result removal", async ({
  page,
  messages,
}) => {
  await renderState(page, { count: 1000, searching: true });
  const more = page.getByRole("button", {
    name: "Show next 300 rows",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await more.focus();
  const scroller = page.locator("#results-scroll");
  const scrollTop = await scroller.evaluate((node) => node.scrollTop);
  await renderState(page, { count: 1001, searching: true });
  await expect(more).toBeFocused();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  await expectViewportScrollContained(page);
  await renderState(page, { count: 100 });
  const last = page.getByRole("treeitem", { name: /column 14:/ }).last();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(
    await scroller.evaluate((node) => node.scrollHeight - node.clientHeight),
  );
  await page.keyboard.press("Delete");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({
      type: "dismissMatch",
      session: 1,
      id: JSON.stringify([
        "file:///workspace/src/Result.swift",
        100,
        13,
        100,
        31,
      ]),
    });
  await renderState(page, { count: 99 });
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  await expectViewportScrollContained(page);
});

test("contains file descriptions and collapse behavior across paginated groups", async ({
  page,
}) => {
  await renderState(page, { count: 1000, fileCount: 4 });
  const formBounds = await page.locator("#search-form").boundingBox();
  const more = page.getByRole("button", {
    name: "Show next 300 rows",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await expectViewportScrollContained(page);
  await more.click();
  await expect(page.getByRole("treeitem")).toHaveCount(600);
  await expect(page.getByRole("treeitem").nth(300)).toBeFocused();
  await expectViewportScrollContained(page);
  const file = page.getByRole("treeitem", { name: /^Result2.swift,/ });
  await file.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("status")).toHaveText("1000 results in 4 files");
  expect(await page.locator("#search-form").boundingBox()).toEqual(formBounds);
  await expectViewportScrollContained(page);
});

test("keeps pagination help in the viewport and dismisses it on result scrolling", async ({
  page,
}) => {
  await renderState(page, { count: 1000 });
  const more = page.getByRole("button", {
    name: "Show next 300 rows",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await page.mouse.move(90, 10);
  await more.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(
    "Display the next 300 file and match rows.",
  );
  expect(
    await tooltip.evaluate((node) => node.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(480);
  await page.mouse.wheel(0, -220);
  await expect(tooltip).toBeHidden();
  await expectViewportScrollContained(page);
  await page.getByRole("textbox", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Search", exact: true }),
  ).toBeFocused();
  await expectViewportScrollContained(page);
});

test("keeps the full search section in place while results scroll to the bottom", async ({
  page,
}) => {
  await renderState(page, { count: 299 });
  const form = page.locator("#search-form");
  const status = page.getByRole("status");
  const formBounds = await form.boundingBox();
  const statusBounds = await status.boundingBox();
  await page.mouse.move(90, 400);
  await page.mouse.wheel(0, 10000);
  await expect(
    page.getByRole("treeitem", { name: /column 14:/ }).last(),
  ).toBeInViewport();
  expect(await form.boundingBox()).toEqual(formBounds);
  expect(await status.boundingBox()).toEqual(statusBounds);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(
    await page.locator("#results-scroll").evaluate((node) => node.scrollTop),
  ).toBeGreaterThan(0);
});

test("scrolls keyboard-focused matches below the pinned search section", async ({
  page,
}) => {
  await renderState(page, { count: 100 });
  const rows = page.getByRole("treeitem", { name: /column 14:/ });
  await rows.nth(30).focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(31)).toBeFocused();
  const matchBounds = await rows.nth(31).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  });
  const statusBottom = await page
    .getByRole("status")
    .evaluate((node) => node.getBoundingClientRect().bottom);
  expect(matchBounds.top).toBeGreaterThanOrEqual(statusBottom);
  expect(matchBounds.bottom).toBeLessThanOrEqual(480);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("preserves result scrolling when a new batch arrives", async ({
  page,
}) => {
  await renderState(page, { count: 100, searching: true });
  const row = page.getByRole("treeitem", { name: /column 14:/ }).nth(30);
  await row.focus();
  const scroller = page.locator("#results-scroll");
  const scrollTop = await scroller.evaluate((node) => node.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await renderState(page, { count: 101, searching: true });
  await expect(row).toBeFocused();
  expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrollTop);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("resizes the scrollable results below the full search section in a short sidebar", async ({
  page,
}) => {
  await renderState(page, { count: 1000 });
  await page.setViewportSize({ width: 180, height: 280 });
  await page
    .getByRole("treeitem", { name: /column 14:/ })
    .last()
    .focus();
  const bounds = await page.locator("#results-scroll").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  });
  const statusBottom = await page
    .getByRole("status")
    .evaluate((node) => node.getBoundingClientRect().bottom);
  expect(bounds.top).toBe(statusBottom);
  expect(bounds.bottom).toBe(280);
  expect(bounds.height).toBeGreaterThan(22);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    180,
  );
  await page.setViewportSize({ width: 320, height: 480 });
  expect(
    await page
      .locator("#results-scroll")
      .evaluate((node) => node.getBoundingClientRect().bottom),
  ).toBe(480);
  await expectViewportScrollContained(page);
});

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
  expect(layout.left).toBe(20);
  expect(layout.right).toBe(20);
  expect(layout.overflow).toBe(false);
  expect(layout.optionsRight).toBeLessThanOrEqual(layout.queryRight);
  await expect(page).toHaveScreenshot("results.png");
});

test("insets controls and pagination while keeping the results at the sidebar edges", async ({
  page,
}) => {
  await renderState(page, { count: 1000 });
  const expectFullWidth = async () => {
    const geometry = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      return {
        padding: [bodyStyle.paddingLeft, bodyStyle.paddingRight],
        viewportWidth: window.innerWidth,
        sections: ["search-form", "status", "results-scroll"].map((id) => {
          const section = document.getElementById(id);
          if (section === null) throw new Error(`Missing section: ${id}`);
          const bounds = section.getBoundingClientRect();
          const style = getComputedStyle(section);
          return {
            id,
            left: bounds.left,
            right: bounds.right,
            padding: [style.paddingLeft, style.paddingRight],
          };
        }),
        pagination: (() => {
          const scroller = document.getElementById("results-scroll");
          const button = document.querySelector(".show-more");
          if (scroller === null || button === null)
            throw new Error("Missing pagination controls");
          const scrollBounds = scroller.getBoundingClientRect();
          const buttonBounds = button.getBoundingClientRect();
          return {
            left: buttonBounds.left - scrollBounds.left,
            right:
              scrollBounds.left + scroller.clientWidth - buttonBounds.right,
          };
        })(),
        horizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(geometry.padding).toEqual(["0px", "0px"]);
    for (const bounds of geometry.sections) {
      expect(bounds.left).toBe(0);
      expect(bounds.right).toBe(geometry.viewportWidth);
      expect(bounds.padding).toEqual(
        bounds.id === "results-scroll" ? ["0px", "0px"] : ["20px", "20px"],
      );
    }
    expect(geometry.pagination).toEqual({ left: 20, right: 20 });
    expect(geometry.horizontalOverflow).toBe(false);
    await expectViewportScrollContained(page);
  };
  await expectFullWidth();
  const more = page.getByRole("button", {
    name: "Show next 300 rows",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await expectFullWidth();
  await more.click();
  await expect(page.getByRole("treeitem")).toHaveCount(600);
  await expectFullWidth();
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
    page.getByRole("textbox", { name: "Search", exact: true }),
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
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("fixture");
  await page.keyboard.press("Enter");
  await expect.poll(() => messages.at(-1)).toEqual({ type: "search" });
});

test("sends filter updates and cancellation", async ({ page, messages }) => {
  await renderState(page, { count: 299 });
  await page
    .getByRole("treeitem", { name: /column 14:/ })
    .last()
    .scrollIntoViewIfNeeded();
  await page.getByRole("textbox", { name: "Search", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search", exact: true })
    .fill("fixture");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({ type: "update", field: "query", value: "fixture" });
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
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
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
    page.getByRole("textbox", { name: "Search", exact: true }),
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
    page.getByRole("textbox", { name: "Search", exact: true }),
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

test("accepts plain folder filters and explains named-root selection", async ({
  page,
  messages,
}) => {
  const include = page.getByRole("textbox", { name: "files to include" });
  await include.fill("src, docs");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({ type: "update", field: "include", value: "src, docs" });
  await expect(page.getByRole("tooltip")).toContainText("./backend/src");
  await include.fill("./backend/src");
  await expect
    .poll(() => messages.at(-1))
    .toEqual({ type: "update", field: "include", value: "./backend/src" });
});

test("recalls independent field histories with Up and Down and clears after the newest value", async ({
  page,
  messages,
}) => {
  await renderState(page, {
    history: {
      query: ["beta", "alpha"],
      include: ["src", "docs"],
      exclude: ["dist", "vendor"],
    },
  });
  for (const [name, field, newest, oldest] of [
    ["Search", "query", "beta", "alpha"],
    ["files to include", "include", "src", "docs"],
    ["files to exclude", "exclude", "dist", "vendor"],
  ] as const) {
    const control = page.getByRole("textbox", { name, exact: true });
    await control.fill("");
    await control.press("ArrowUp");
    await expect(control).toHaveValue(newest);
    await expect
      .poll(() => messages.at(-1))
      .toEqual({ type: "update", field, value: newest });
    await control.press("ArrowUp");
    await expect(control).toHaveValue(oldest);
    await control.press("ArrowDown");
    await expect(control).toHaveValue(newest);
    await control.press("ArrowDown");
    await expect(control).toHaveValue("");
    await expect(control).toBeFocused();
    await expect
      .poll(() => messages.at(-1))
      .toEqual({ type: "update", field, value: "" });
  }
});
