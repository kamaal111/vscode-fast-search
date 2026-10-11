import { parse, type ParseError } from "jsonc-parser";

type Variant = {
  file: string | undefined;
  names: Map<string, string>;
  extensions: Map<string, string>;
  languages: Map<string, string>;
};
type ThemeOptions = {
  source: string;
  resource(path: string): string | undefined;
  languageIcons?: Map<string, { light: string; dark: string }>;
};
type FileIconOptions = {
  path: string;
  language: string | undefined;
  kind: "dark" | "light" | "highContrast" | "highContrastLight";
};

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function associations(value: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, icon] of Object.entries(object(value) ?? {}))
    if (typeof icon === "string") entries.set(key.toLowerCase(), icon);
  return entries;
}

function variant(value: unknown): Variant {
  const data = object(value) ?? {};
  return {
    file: typeof data.file === "string" ? data.file : undefined,
    names: associations(data.fileNames),
    extensions: associations(data.fileExtensions),
    languages: associations(data.languageIds),
  };
}

function cssString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\3c ");
}

function size(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^\d+(?:\.\d+)?(?:%|px|em|rem)$/.test(value)
    ? value
    : undefined;
}

/** Resolves the installed theme's associations without reading file contents. */
export class FileIcons {
  readonly css: string;
  private readonly base: Variant;
  private readonly light: Variant;
  private readonly highContrast: Variant;
  private readonly definitions = new Map<string, string>();
  private readonly languageIcons = new Map<
    string,
    { light: string; dark: string }
  >();

  constructor({ source, resource, languageIcons }: ThemeOptions) {
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
    const data = object(parsed);
    if (errors.length > 0 || data === undefined)
      throw new Error("Invalid file icon theme JSON");
    this.base = variant(data);
    this.light = variant(data.light);
    this.highContrast = variant(data.highContrast);
    const rules: string[] = [];
    const fonts = new Map<string, { family: string; size: string }>();
    if (Array.isArray(data.fonts)) {
      for (const raw of data.fonts) {
        const font = object(raw);
        if (
          font === undefined ||
          typeof font.id !== "string" ||
          !Array.isArray(font.src)
        )
          continue;
        const family = `fast-search-icon-font-${fonts.size}`;
        const sources = font.src.flatMap((rawSource: unknown) => {
          const source = object(rawSource);
          if (source === undefined || typeof source.path !== "string")
            return [];
          const uri = resource(source.path);
          if (uri === undefined) return [];
          const format =
            typeof source.format === "string" &&
            /^(woff2?|truetype|opentype)$/.test(source.format)
              ? ` format(${cssString(source.format)})`
              : "";
          return [`url(${cssString(uri)})${format}`];
        });
        if (sources.length === 0) continue;
        fonts.set(font.id, { family, size: size(font.size) ?? "150%" });
        const weight =
          typeof font.weight === "string" &&
          /^(normal|bold|[1-9]00)$/.test(font.weight)
            ? font.weight
            : "normal";
        const style =
          font.style === "italic" || font.style === "oblique"
            ? font.style
            : "normal";
        rules.push(
          `@font-face {font-family:${cssString(family)};src:${sources.join(",")};font-weight:${weight};font-style:${style};font-display:block;}`,
        );
      }
    }
    const defaultFont = fonts.values().next().value;
    for (const [id, raw] of Object.entries(
      object(data.iconDefinitions) ?? {},
    )) {
      const definition = object(raw);
      if (definition === undefined) continue;
      const declarations: string[] = [];
      if (typeof definition.iconPath === "string") {
        const uri = resource(definition.iconPath);
        if (uri === undefined) continue;
        const url = `url(${cssString(uri)})`;
        if (data.usesCurrentColor === true)
          declarations.push(
            `background-color:currentColor;mask:${url} center/16px no-repeat`,
          );
        else declarations.push(`background-image:${url}`);
      } else if (typeof definition.fontCharacter === "string") {
        const font =
          typeof definition.fontId === "string"
            ? fonts.get(definition.fontId)
            : defaultFont;
        if (font === undefined) continue;
        const character = definition.fontCharacter.replace(
          /\\([0-9a-fA-F]{1,6})\s?/g,
          (_whole, hex: string) => {
            const code = Number.parseInt(hex, 16);
            return code <= 0x10ffff ? String.fromCodePoint(code) : "";
          },
        );
        declarations.push(
          `content:${cssString(character)};font-family:${cssString(font.family)};font-size:${size(definition.fontSize) ?? font.size}`,
        );
        if (
          typeof definition.fontColor === "string" &&
          /^#[0-9a-fA-F]{3,8}$/.test(definition.fontColor)
        )
          declarations.push(`color:${definition.fontColor}`);
      } else continue;
      const className = `file-icon-${this.definitions.size}`;
      this.definitions.set(id, className);
      rules.push(`.${className}::before {${declarations.join(";")};}`);
    }
    const hasSpecificIcons = [this.base, this.light, this.highContrast].some(
      (item) =>
        item.names.size + item.extensions.size + item.languages.size > 0,
    );
    if (
      data.showLanguageModeIcons === true ||
      (hasSpecificIcons && data.showLanguageModeIcons !== false)
    ) {
      for (const [id, icons] of languageIcons ?? []) {
        if (
          [this.base, this.light, this.highContrast].some((item) =>
            item.languages.has(id),
          )
        )
          continue;
        const classes = {
          light: `language-icon-${this.languageIcons.size}-light`,
          dark: `language-icon-${this.languageIcons.size}-dark`,
        };
        this.languageIcons.set(id, classes);
        for (const kind of ["light", "dark"] as const) {
          this.definitions.set(classes[kind], classes[kind]);
          rules.push(
            `.${classes[kind]}::before {background-image:url(${cssString(icons[kind])});}`,
          );
        }
      }
    }
    this.css = rules.join("\n");
  }

  icon({ path, language, kind }: FileIconOptions): string | undefined {
    const lower = path.toLowerCase();
    const filename = lower.split("/").at(-1) ?? lower;
    const parent = lower.split("/").at(-2);
    let best: { icon: string; score: number } | undefined;
    const consider = (icon: string | undefined, score: number): void => {
      if (
        icon !== undefined &&
        this.definitions.has(icon) &&
        (best === undefined || score >= best.score)
      )
        best = { icon, score };
    };
    const variants = [
      this.base,
      ...(kind === "light"
        ? [this.light]
        : kind === "highContrast" || kind === "highContrastLight"
          ? [this.highContrast]
          : []),
    ];
    const languageIcon = this.languageIcons.get(language ?? "");
    consider(
      kind === "light" || kind === "highContrastLight"
        ? languageIcon?.light
        : languageIcon?.dark,
      1,
    );
    for (const current of variants) {
      consider(current.file, 0);
      consider(current.languages.get(language ?? ""), 1);
      if (language === "jsonc" && !current.languages.has("jsonc"))
        consider(current.languages.get("json"), 1);
      const segments = filename.length <= 255 ? filename.split(".") : [];
      for (let index = 1; index < segments.length; index += 1) {
        const extension = segments.slice(index).join(".");
        const score = 10 + segments.length - index;
        consider(current.extensions.get(extension), score);
        if (parent !== undefined)
          consider(current.extensions.get(`${parent}/${extension}`), score + 1);
      }
      consider(current.names.get(filename), 1000);
      if (parent !== undefined)
        consider(current.names.get(`${parent}/${filename}`), 1100);
    }
    return best === undefined ? undefined : this.definitions.get(best.icon);
  }
}
