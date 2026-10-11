import * as path from "node:path";
import { cp, mkdir } from "node:fs/promises";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const runId = process.pid.toString();
  const extensionsDir = `/tmp/fast-search-vscode-extensions-${runId}`;
  await mkdir(extensionsDir, { recursive: true });
  await cp(
    path.resolve("test/fixtures/icon-theme"),
    path.join(extensionsDir, "fast-search-test-icons"),
    { recursive: true },
  );
  await runTests({
    timeout: 60_000,
    extensionDevelopmentPath: process.cwd(),
    extensionTestsPath: path.resolve(__dirname, "suite/index"),
    launchArgs: [
      path.resolve(process.cwd(), "test/fixtures/workspace"),
      "--disable-workspace-trust",
      `--user-data-dir=/tmp/fast-search-vscode-user-${runId}`,
      `--extensions-dir=${extensionsDir}`,
    ],
  });
}
void main();
