import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const runId = process.pid.toString();
  await runTests({
    timeout: 60_000,
    extensionDevelopmentPath: process.cwd(),
    extensionTestsPath: path.resolve(__dirname, "suite/index"),
    launchArgs: [
      path.resolve(process.cwd(), "test/fixtures/workspace"),
      "--disable-workspace-trust",
      `--user-data-dir=/tmp/fast-search-vscode-user-${runId}`,
      `--extensions-dir=/tmp/fast-search-vscode-extensions-${runId}`,
    ],
  });
}
void main();
