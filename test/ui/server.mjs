import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { searchViewHtml } from "../../src/searchView/html.ts";

const assets = new Map([
  ["/media/search.js", ["media/search.js", "text/javascript"]],
  ["/media/search.css", ["media/search.css", "text/css"]],
  ["/theme.css", ["test/ui/theme.css", "text/css"]],
  [
    "/font.woff2",
    [
      "node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff2",
      "font/woff2",
    ],
  ],
]);
const themes = new Set(["dark", "light", "high-contrast"]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:4173");
  try {
    if (url.pathname === "/") {
      const theme = url.searchParams.get("theme") ?? "dark";
      if (!themes.has(theme)) {
        response.writeHead(400).end("Unknown test theme");
        return;
      }
      const html = searchViewHtml({
        scriptUri: "/media/search.js",
        styleUri: "/media/search.css",
        cspSource: "'self'",
        nonce: "ui-test",
      })
        .replace("default-src 'none';", "default-src 'none'; font-src 'self';")
        .replace("</head>", '<link rel="stylesheet" href="/theme.css"></head>')
        .replace("<body>", `<body class="vscode-${theme}">`);
      response.writeHead(200, { "Content-Type": "text/html" }).end(html);
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset === undefined) {
      response.writeHead(404).end();
      return;
    }
    const [path, contentType] = asset;
    response
      .writeHead(200, { "Content-Type": contentType })
      .end(await readFile(path));
  } catch (error) {
    console.error(error);
    response.writeHead(500).end("UI fixture failed");
  }
});
server.listen(4173, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
