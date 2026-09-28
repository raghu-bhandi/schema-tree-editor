/**
 * Runs inside the VS Code extension host (see test/run.mjs), with example/ as the workspace.
 * A tiny sequential runner keeps this free of a test framework.
 */
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { TreeOp } from "../../src/jsonOps";
import { DEFAULT_KEYS, TreeKeys } from "../../src/keys";
import { TreeEditorProvider } from "../../src/provider";
import { SchemaRegistry } from "../../src/registry";

const ws = () => vscode.workspace.workspaceFolders![0].uri;
const file = (p: string) => vscode.Uri.joinPath(ws(), p);
const DOCS = "data/docs-nav/v4.json", FLAGS = "data/flags/production.json";
const FLAG_KEYS: TreeKeys = { id: "key", name: "label", type: "kind", children: "items" };

async function waitFor<T>(get: () => T | undefined, what: string, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
    const v = get(); if (v) return v;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Applies an op through the provider and returns the document changes it caused. */
async function edit(doc: vscode.TextDocument, op: TreeOp, keys: TreeKeys, version = doc.version) {
  const changes: vscode.TextDocumentContentChangeEvent[] = [];
  let resynced = false;
  const sub = vscode.workspace.onDidChangeTextDocument(e => { if (e.document === doc) changes.push(...e.contentChanges); });
  try { await provider.applyEdit(doc, op, version, keys, () => (resynced = true)); }
  finally { sub.dispose(); }
  return { changes, resynced };
}

async function undoUntil(doc: vscode.TextDocument, text: string) {
  await vscode.commands.executeCommand("undo");
  await waitFor(() => doc.getText() === text, "undo to restore the text");
}

const openTree = async (p: string) => {
  const doc = await vscode.workspace.openTextDocument(file(p));
  await vscode.commands.executeCommand("vscode.openWith", doc.uri, TreeEditorProvider.viewType);
  return doc;
};

let registry: SchemaRegistry, provider: TreeEditorProvider;
const tests: [string, () => Promise<void>][] = [
  ["extension activates", async () => {
    const ext = vscode.extensions.all.find(e => e.packageJSON.name === "schema-tree-editor");
    assert.ok(ext, "extension is installed");
    await ext.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes("schemaTree.open"));
  }],

  ["openWith schemaTree.editor opens the custom editor", async () => {
    const doc = await openTree(DOCS);
    const tab = await waitFor(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputCustom ? t.input : undefined;
    }, "the custom editor tab");
    assert.equal(tab.viewType, TreeEditorProvider.viewType);
    assert.equal(tab.uri.toString(), doc.uri.toString());
  }],

  ["registry resolves both example trees", async () => {
    const docs = await registry.forDocument(await vscode.workspace.openTextDocument(file(DOCS)));
    assert.equal(docs?.name, "docs-nav");
    assert.equal(docs?.label, "Docs navigation");
    assert.equal(docs?.problem, undefined);
    assert.equal(docs?.model?.rootType, "site");
    assert.deepEqual(docs?.model?.keys, DEFAULT_KEYS);

    const flags = await registry.forDocument(await vscode.workspace.openTextDocument(file(FLAGS)));
    assert.equal(flags?.name, "flags");
    assert.equal(flags?.problem, undefined);
    assert.equal(flags?.model?.rootType, "flagSet");
    assert.deepEqual(flags?.model?.keys, FLAG_KEYS);

    assert.equal(await registry.forDocument(await vscode.workspace.openTextDocument(file("schema-trees.json"))), undefined);
    assert.deepEqual((await registry.configFiles()).map(u => vscode.workspace.asRelativePath(u)), ["schema-trees.json"]);
  }],

  ["a tree edit changes the document minimally, and undo reverts it", async () => {
    const doc = await openTree(DOCS);
    const before = doc.getText();
    const { changes } = await edit(doc, { op: "update", id: "install", set: { name: "Installation" } }, DEFAULT_KEYS);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].rangeLength, 0);
    assert.equal(changes[0].text, "ation");
    assert.equal(doc.getText(), before.replace('"name": "Install"', '"name": "Installation"'));
    assert.ok(doc.isDirty);

    await undoUntil(doc, before);
    assert.ok(!doc.isDirty);
  }],

  ["a no-op edit produces no change", async () => {
    const doc = await openTree(DOCS);
    const { changes } = await edit(doc, { op: "update", id: "install", set: { name: "Install", status: "published" } }, DEFAULT_KEYS);
    assert.equal(changes.length, 0);
    assert.ok(!doc.isDirty);
  }],

  ["an edit made before a hand edit is dropped and the view resyncs", async () => {
    const doc = await openTree(DOCS);
    const before = doc.getText(), seen = doc.version;
    const we = new vscode.WorkspaceEdit();
    we.insert(doc.uri, new vscode.Position(0, 0), " ");
    assert.ok(await vscode.workspace.applyEdit(we));
    const { changes, resynced } = await edit(doc, { op: "remove", id: "install" }, DEFAULT_KEYS, seen);
    assert.equal(changes.length, 0);
    assert.ok(resynced);
    await undoUntil(doc, before);
  }],

  ["quick successive tree edits all apply, in order", async () => {
    const doc = await openTree(DOCS);
    const before = doc.getText(), seen = doc.version;
    // Both ops were made on the same view, as when the second one is sent before the first comes back.
    const results = await Promise.all([
      edit(doc, { op: "update", id: "install", set: { name: "Setup" } }, DEFAULT_KEYS, seen),
      edit(doc, { op: "remove", id: "upgrading" }, DEFAULT_KEYS, seen),
    ]);
    assert.ok(results.every(r => !r.resynced));
    const section = JSON.parse(doc.getText()).children[0];
    assert.deepEqual(section.children.map((c: any) => c.id), ["install", "quick-start", "project-layout", "configuration"]);
    assert.equal(section.children[0].name, "Setup");
    const after = doc.getText();
    await vscode.commands.executeCommand("undo"); // two edits, two undos
    await waitFor(() => doc.getText() !== after, "the first undo");
    await undoUntil(doc, before);
    assert.ok(!doc.isDirty);
  }],

  ["a move with custom keys is one edit and one undo", async () => {
    const doc = await openTree(FLAGS);
    const before = doc.getText();
    const { changes } = await edit(doc, { op: "move", id: "ui", parentId: "prod", index: 0 }, FLAG_KEYS);
    assert.equal(changes.length, 1);
    assert.deepEqual(JSON.parse(doc.getText()).items.map((i: any) => i.key), ["ui", "checkout", "search"]);
    await undoUntil(doc, before);
    assert.ok(!doc.isDirty);
  }],
];

export async function run(): Promise<void> {
  registry = new SchemaRegistry();
  provider = new TreeEditorProvider({} as vscode.ExtensionContext, registry);
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ✔ ${name}`); }
    catch (e) { failed++; console.error(`  ✖ ${name}\n`, e); }
  }
  registry.dispose();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  if (failed) throw new Error(`${failed} integration test(s) failed`);
}
