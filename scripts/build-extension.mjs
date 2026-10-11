import { build } from "esbuild";

await build({
  entryPoints: ["src/extension/activate.ts"],
  bundle: true,
  platform: "node",
  mainFields: ["module", "main"],
  target: "node26",
  format: "cjs",
  external: ["vscode"],
  outfile: "dist/extension.js",
});
