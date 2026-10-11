import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const version = manifest.devDependencies["@playwright/test"];
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Pin @playwright/test to an exact version for UI snapshots.");
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--ipc=host",
    "--platform",
    "linux/arm64",
    "--env",
    "CI",
    "-v",
    `${process.cwd()}:/work`,
    "-w",
    "/work",
    `mcr.microsoft.com/playwright:v${version}-noble`,
    "node",
    "node_modules/@playwright/test/cli.js",
    "test",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
