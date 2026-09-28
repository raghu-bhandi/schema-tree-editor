// Bundles the TypeScript tests with esbuild, then runs them.
//   node test/run.mjs unit          -> node:test on test/unit/*.test.ts
//   node test/run.mjs integration   -> test/integration inside VS Code (@vscode/test-electron)
// VSCODE_TEST_VERSION picks the VS Code build for integration tests (default: stable).
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "out", "test");
const kind = process.argv[2];
const bundle = (entryPoints, outdir) =>
  esbuild.build({ entryPoints, outdir, bundle: true, platform: "node", format: "cjs", target: "node18", external: ["vscode"], mainFields: ["module", "main"], sourcemap: "inline", logLevel: "warning" });

if (kind === "unit") {
  const dir = path.join(root, "test", "unit");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".test.ts")).map(f => path.join(dir, f));
  await bundle(files, path.join(out, "unit"));
  const built = files.map(f => path.join(out, "unit", path.basename(f).replace(/\.ts$/, ".js")));
  process.exit(spawnSync(process.execPath, ["--enable-source-maps", "--test", ...built], { stdio: "inherit" }).status ?? 1);
} else if (kind === "integration") {
  const { runTests } = await import("@vscode/test-electron");
  await bundle([path.join(root, "test", "integration", "index.ts")], path.join(out, "integration"));
  // Set when this runs from a VS Code terminal; it would start the test VS Code as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "schema-tree-test-"));
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || "stable",
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(out, "integration", "index.js"),
      launchArgs: [path.join(root, "example"), "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", userData],
    });
  } catch {
    process.exitCode = 1;
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
} else {
  console.error("usage: node test/run.mjs unit|integration");
  process.exit(2);
}
