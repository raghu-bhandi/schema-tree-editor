#!/usr/bin/env node
/**
 * Schema Tree Editor: schema generator.
 *
 * Reads ./schema-trees.json. For every tree with `typesFile` + `rootType`, generates
 * <schemaDir>/<name>.schema.json from the TypeScript interfaces. Trees with a
 * hand-written `schema` are left alone. Then registers all tree schemas under
 * "json.schemas" in .vscode/settings.json, so hand-editing gets validation and
 * autocomplete from VS Code's built-in JSON support.
 *
 * Needs `ts-json-schema-generator` installed in your project (devDependency).
 *
 *   node gen-schemas.mjs            write schemas + settings
 *   node gen-schemas.mjs --check    exit 1 if a generated schema is out of date (for CI)
 *   --settings-root <dir>           workspace folder whose .vscode/settings.json gets "json.schemas"
 *                                   (default: this folder; set it when schema-trees.json is in a subfolder)
 */
import { applyEdits, modify, parse } from "jsonc-parser";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "schema-trees.json");
if (!fs.existsSync(configPath)) { console.error(`No schema-trees.json in ${root}`); process.exit(2); }
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const schemaDir = path.join(root, config.schemaDir || "schemas");
const check = process.argv.includes("--check");
const rel = (p, from = root) => "./" + path.relative(from, p).split(path.sep).join("/");
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
let settingsRoot = path.resolve(arg("--settings-root") || root);
const up = path.relative(settingsRoot, root);
if (up.startsWith("..") || path.isAbsolute(up)) { console.warn(`--settings-root must contain ${root}; using that folder instead.`); settingsRoot = root; }
// Prefix that turns this folder's globs into globs relative to settingsRoot ("" or "/sub/dir").
const sub = path.relative(settingsRoot, root).split(path.sep).filter(Boolean).map(p => "/" + p).join("");

let createGenerator;
const needsTs = config.trees.some(t => t.typesFile && !t.schema);
if (needsTs) {
  try { ({ createGenerator } = createRequire(path.join(root, "package.json"))("ts-json-schema-generator")); }
  catch { console.error("ts-json-schema-generator isn't installed here. Run: npm i -D ts-json-schema-generator"); process.exit(2); }
}

let stale = 0;
const entries = [];
for (const tree of config.trees) {
  let out;
  if (tree.schema) {
    out = path.join(root, tree.schema);
    console.log(`kept  ${rel(out)} (hand-written)`);
  } else {
    if (!tree.typesFile || !tree.rootType) { console.error(`✗ tree "${tree.name}" needs either "schema" or "typesFile" + "rootType"`); stale++; continue; }
    const tsconfig = path.join(root, "tsconfig.json");
    const schema = createGenerator({
      path: path.join(root, tree.typesFile),
      tsconfig: fs.existsSync(tsconfig) ? tsconfig : undefined,
      type: tree.rootType, expose: "export", topRef: true, jsDoc: "extended",
      extraTags: ["treeIcon", "treeSubtitle"], additionalProperties: false, skipTypeCheck: true,
    }).createSchema(tree.rootType);
    schema.title = tree.label || tree.name;
    out = path.join(schemaDir, `${tree.name}.schema.json`);
    const text = JSON.stringify(schema, null, 2) + "\n";
    if (check) {
      const old = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
      if (old !== text) { console.error(`✗ ${rel(out)} is out of date. Run the generator.`); stale++; }
      else console.log(`✓ ${rel(out)}`);
    } else {
      fs.mkdirSync(schemaDir, { recursive: true });
      fs.writeFileSync(out, text);
      console.log(`wrote ${rel(out)}`);
    }
  }
  entries.push({ fileMatch: tree.files.map(g => (g.startsWith("**") ? g : sub + (g.startsWith("/") ? g : "/" + g))), url: rel(out, settingsRoot) });
}
if (check) process.exit(stale ? 1 : 0);

// Merge into .vscode/settings.json: keeps comments and unrelated "json.schemas" entries.
const settingsPath = path.join(settingsRoot, ".vscode", "settings.json");
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
let settings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "{}\n";
const ours = new Set(entries.map(e => e.url));
const others = (parse(settings)?.["json.schemas"] || []).filter(e => !ours.has(e.url));
settings = applyEdits(settings, modify(settings, ["json.schemas"], [...others, ...entries], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
fs.writeFileSync(settingsPath, settings);
console.log(`updated ${rel(settingsPath)} (json.schemas)`);
process.exit(stale ? 1 : 0);
