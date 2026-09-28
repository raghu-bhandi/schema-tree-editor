import * as esbuild from "esbuild";
const watch = process.argv.includes("--watch");
const builds = [
  // Node builds use jsonc-parser's ESM entry: its UMD entry has require() calls esbuild can't bundle.
  { entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", platform: "node", format: "cjs", external: ["vscode"], target: "node18", mainFields: ["module", "main"] },
  { entryPoints: ["webview/main.js"], outfile: "dist/webview.js", platform: "browser", format: "iife", target: "es2022" },
  { entryPoints: ["webview/styles.css"], outfile: "dist/webview.css", loader: { ".ttf": "file" }, assetNames: "[name]" },
  // The schema generator, runnable with plain `node` (jsonc-parser bundled in; ts-json-schema-generator is loaded from the user's project).
  { entryPoints: ["tools/gen-schemas.mjs"], outfile: "dist/gen-schemas.mjs", platform: "node", format: "esm", target: "node18", minify: false, mainFields: ["module", "main"] },
];
for (const b of builds) {
  const opts = { bundle: true, minify: !watch, sourcemap: watch, logLevel: "info", ...b };
  if (watch) await (await esbuild.context(opts)).watch(); else await esbuild.build(opts);
}
