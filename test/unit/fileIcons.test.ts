import { expect, it } from "vitest";
import { FileIcons } from "../../src/searchView/fileIcons.js";

function theme(extra: Record<string, unknown> = {}): FileIcons {
  return new FileIcons({
    source: JSON.stringify({
      iconDefinitions: {
        generic: { iconPath: "file.svg" },
        yaml: { iconPath: "yaml.svg" },
        pnpm: { iconPath: "pnpm.svg" },
        typescript: { iconPath: "typescript.svg" },
        declaration: { iconPath: "declaration.svg" },
        special: { iconPath: "special.svg" },
        light: { iconPath: "light.svg" },
      },
      file: "generic",
      fileExtensions: { yaml: "yaml", ts: "typescript", "d.ts": "declaration" },
      fileNames: {
        "pnpm-workspace.yaml": "pnpm",
        "special/example.ts": "special",
      },
      languageIds: { typescript: "typescript", json: "yaml" },
      ...extra,
    }),
    resource: (path) => `https://webview.test/${path}`,
  });
}

it("uses filename logos ahead of extension icons and matches case insensitively", () => {
  const icons = theme();
  const icon = icons.icon({
    path: "/project/PNPM-WORKSPACE.YAML",
    language: "yaml",
    kind: "dark",
  });
  expect(icons.css).toContain(
    `.${icon}::before {background-image:url("https://webview.test/pnpm.svg");}`,
  );
});

it("prefers compound extensions and parent-qualified filename associations", () => {
  const icons = theme();
  const declaration = icons.icon({
    path: "/project/example.d.ts",
    language: "typescript",
    kind: "dark",
  });
  const special = icons.icon({
    path: "/project/special/example.ts",
    language: "typescript",
    kind: "dark",
  });
  expect(icons.css).toContain(
    `.${declaration}::before {background-image:url("https://webview.test/declaration.svg");}`,
  );
  expect(icons.css).toContain(
    `.${special}::before {background-image:url("https://webview.test/special.svg");}`,
  );
});

it("applies theme variants without overriding more specific base associations", () => {
  const icons = theme({
    light: { file: "light", fileExtensions: { yaml: "light" } },
  });
  const yaml = icons.icon({
    path: "/project/config.yaml",
    language: undefined,
    kind: "light",
  });
  const pnpm = icons.icon({
    path: "/project/pnpm-workspace.yaml",
    language: undefined,
    kind: "light",
  });
  expect(icons.css).toContain(
    `.${yaml}::before {background-image:url("https://webview.test/light.svg");}`,
  );
  expect(icons.css).toContain(
    `.${pnpm}::before {background-image:url("https://webview.test/pnpm.svg");}`,
  );
});

it("uses language associations including the jsonc fallback and generic icons", () => {
  const icons = theme();
  const language = icons.icon({
    path: "/project/config",
    language: "jsonc",
    kind: "dark",
  });
  const generic = icons.icon({
    path: "/project/unknown",
    language: undefined,
    kind: "dark",
  });
  expect(icons.css).toContain(
    `.${language}::before {background-image:url("https://webview.test/yaml.svg");}`,
  );
  expect(icons.css).toContain(
    `.${generic}::before {background-image:url("https://webview.test/file.svg");}`,
  );
});

it("loads commented JSON, font glyphs, and font resources", () => {
  const source = JSON.stringify({
    fonts: [
      {
        id: "seti",
        src: [{ path: "seti.woff", format: "woff" }],
        size: "150%",
      },
    ],
    iconDefinitions: { ts: { fontCharacter: "\\E001", fontColor: "#abcdef" } },
    fileExtensions: { ts: "ts" },
  }).replace("{", "{ /* JSONC */ ");
  const icons = new FileIcons({
    source,
    resource: (path) => `https://webview.test/${path}`,
  });
  expect(icons.css).toContain(
    'url("https://webview.test/seti.woff") format("woff")',
  );
  expect(icons.css).toContain(
    `content:${JSON.stringify(String.fromCodePoint(0xe001))}`,
  );
  expect(icons.css).toContain("color:#abcdef");
  expect(
    icons.icon({
      path: "/project/example.ts",
      language: undefined,
      kind: "dark",
    }),
  ).toBe("file-icon-0");
});

it("uses current-color masks and high-contrast associations", () => {
  const icons = theme({
    usesCurrentColor: true,
    highContrast: { fileExtensions: { ts: "special" } },
  });
  const icon = icons.icon({
    path: "/project/example.ts",
    language: undefined,
    kind: "highContrast",
  });
  expect(icons.css).toContain(
    `.${icon}::before {background-color:currentColor;mask:url("https://webview.test/special.svg") center/16px no-repeat;}`,
  );
});

it("rejects malformed JSON and omits unavailable resources", () => {
  expect(
    () => new FileIcons({ source: "{broken", resource: (path) => path }),
  ).toThrow("Invalid file icon theme JSON");
  const icons = new FileIcons({
    source: '{"file":"x","iconDefinitions":{"x":{"iconPath":"missing.svg"}}}',
    resource: () => undefined,
  });
  expect(icons.css).toBe("");
  expect(
    icons.icon({
      path: "/project/example.ts",
      language: undefined,
      kind: "dark",
    }),
  ).toBeUndefined();
});

it("uses contributed language icons when allowed without overriding file associations", () => {
  const icons = new FileIcons({
    source: JSON.stringify({
      file: "generic",
      iconDefinitions: {
        generic: { iconPath: "file.svg" },
        specific: { iconPath: "specific.svg" },
      },
      fileExtensions: { ts: "specific" },
      showLanguageModeIcons: true,
    }),
    resource: (path) => `https://webview.test/${path}`,
    languageIcons: new Map([
      [
        "custom",
        {
          light: "https://webview.test/light.svg",
          dark: "https://webview.test/dark.svg",
        },
      ],
    ]),
  });
  expect(
    icons.icon({ path: "/project/custom", language: "custom", kind: "light" }),
  ).toBe("language-icon-0-light");
  expect(
    icons.icon({
      path: "/project/custom",
      language: "custom",
      kind: "highContrastLight",
    }),
  ).toBe("language-icon-0-light");
  expect(
    icons.icon({ path: "/project/custom", language: "custom", kind: "dark" }),
  ).toBe("language-icon-0-dark");
  expect(
    icons.icon({
      path: "/project/example.ts",
      language: "custom",
      kind: "dark",
    }),
  ).toBe("file-icon-1");
});

it("does not add language icons when the selected theme disables them", () => {
  const icons = new FileIcons({
    source: JSON.stringify({
      file: "generic",
      iconDefinitions: { generic: { iconPath: "file.svg" } },
      showLanguageModeIcons: false,
    }),
    resource: (path) => `https://webview.test/${path}`,
    languageIcons: new Map([
      [
        "custom",
        {
          light: "https://webview.test/light.svg",
          dark: "https://webview.test/dark.svg",
        },
      ],
    ]),
  });
  expect(
    icons.icon({ path: "/project/custom", language: "custom", kind: "dark" }),
  ).toBe("file-icon-0");
  expect(icons.css).not.toContain("language-icon");
});
