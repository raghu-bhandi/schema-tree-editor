import * as esbuild from "esbuild";
import fs from "node:fs";
const js = await esbuild.build({ entryPoints: ["dev/harness-entry.js"], bundle: true, minify: true, write: false, format: "iife", target: "es2022", loader: { ".json": "json" } });
const css = await esbuild.build({ entryPoints: ["webview/styles.css"], bundle: true, minify: true, write: false, loader: { ".ttf": "dataurl" } });
const html = fs.readFileSync("dev/harness.template.html", "utf8")
  .replace("/*__CSS__*/", () => css.outputFiles[0].text)
  .replace("/*__JS__*/", () => js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
fs.mkdirSync("dist-dev", { recursive: true });
fs.writeFileSync("dist-dev/preview.html", html);
console.log("dist-dev/preview.html", (html.length / 1024).toFixed(0) + " KB");
