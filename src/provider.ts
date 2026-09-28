/**
 * Custom TEXT editor: the webview is just another view of the same TextDocument.
 * Hand edits in the JSON editor and edits in the tree both go through the document,
 * so undo/redo, dirty state, save and Git all behave normally.
 */
import * as vscode from "vscode";
import { applyOp, detectFormatting, idAtOffset, minimalEdit, parseProblems, rangeOfId, TreeOp } from "./jsonOps";
import { DEFAULT_KEYS, TreeKeys } from "./keys";
import { SchemaRegistry } from "./registry";

export class TreeEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "schemaTree.editor";
  private static active?: { document: vscode.TextDocument; post: (m: unknown) => void };
  static get current() { return TreeEditorProvider.active; }

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly registry: SchemaRegistry) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = this.html(panel.webview, dist);

    const post = (m: unknown) => panel.webview.postMessage(m);
    const state = { keys: DEFAULT_KEYS as TreeKeys };
    const sendModel = async () => {
      const t = await this.registry.forDocument(document);
      state.keys = t?.model?.keys ?? DEFAULT_KEYS;
      post({ type: "init", fileName: vscode.workspace.asRelativePath(document.uri), tree: t ? { name: t.name, label: t.label, model: t.model, problem: t.problem } : null });
    };
    const sendDoc = () => post({ type: "doc", text: document.getText(), version: document.version, problems: parseProblems(document.getText()) });

    let docTimer: NodeJS.Timeout | undefined, selTimer: NodeJS.Timeout | undefined;
    const subs: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString() || !e.contentChanges.length) return;
        clearTimeout(docTimer); docTimer = setTimeout(sendDoc, 40);
      }),
      this.registry.onDidChange(async () => { await sendModel(); sendDoc(); }),
      // Cursor in a JSON text editor for this file -> select that node in the tree.
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor.document.uri.toString() !== document.uri.toString()) return;
        if (!e.kind) return; // the cursor moved because the text changed (e.g. a tree edit), not because the user moved it
        clearTimeout(selTimer);
        selTimer = setTimeout(() => {
          const id = idAtOffset(document.getText(), document.offsetAt(e.selections[0].active), state.keys);
          if (id) post({ type: "select", id });
        }, 120);
      }),
      panel.onDidChangeViewState(() => { if (panel.active) TreeEditorProvider.active = { document, post }; }),
      panel.webview.onDidReceiveMessage(m => this.onMessage(m, document, state.keys, sendModel, sendDoc)),
    ];
    TreeEditorProvider.active = { document, post };
    panel.onDidDispose(() => {
      subs.forEach(s => s.dispose());
      this.ownVersions.delete(document.uri.toString());
      if (TreeEditorProvider.active?.document === document) TreeEditorProvider.active = undefined;
    });
  }

  private async onMessage(m: any, document: vscode.TextDocument, keys: TreeKeys, sendModel: () => Promise<void>, sendDoc: () => void) {
    switch (m.type) {
      case "ready": await sendModel(); sendDoc(); return;
      case "edit": return this.applyEdit(document, m.op as TreeOp, m.version, keys, sendDoc);
      case "reveal": return this.reveal(document, m.id, keys);
      case "copy": await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage(`Copied ${m.label || "to clipboard"}`, 2500); return;
      case "openText": return void vscode.commands.executeCommand("vscode.openWith", document.uri, "default", vscode.ViewColumn.Beside);
      case "error": vscode.window.showErrorMessage(m.message); return;
    }
  }

  /** Applies a tree op. Edits run one at a time, so each is computed from the text the previous one produced. */
  applyEdit(document: vscode.TextDocument, op: TreeOp, version: number, keys: TreeKeys, sendDoc: () => void): Promise<void> {
    const run = this.queue.then(() => this.applyNow(document, op, version, keys, sendDoc));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private queue: Promise<void> = Promise.resolve();
  /** Document versions produced by tree edits, per document. */
  private ownVersions = new Map<string, Set<number>>();

  private async applyNow(document: vscode.TextDocument, op: TreeOp, version: number, keys: TreeKeys, sendDoc: () => void) {
    // Quick successive edits arrive with a view that is behind only by our own edits; ops address
    // nodes by id, so they still apply. A hand edit, undo or redo in between means the op was
    // made on stale data: drop it and resync.
    const own = this.ownVersions.get(document.uri.toString()) ?? new Set<number>();
    this.ownVersions.set(document.uri.toString(), own);
    for (const v of own) if (v <= version) own.delete(v);
    for (let v = version + 1; v <= document.version; v++) {
      if (!own.has(v)) { vscode.window.showWarningMessage("The file changed before that tree edit arrived, so it wasn't applied. Please try again."); sendDoc(); return; }
    }
    const text = document.getText();
    let next: string;
    try { next = applyOp(text, op, keys, detectFormatting(text)); }
    catch (e: any) { vscode.window.showErrorMessage(e.message); sendDoc(); return; }
    const d = minimalEdit(text, next);
    if (!d) return;
    const we = new vscode.WorkspaceEdit();
    we.replace(document.uri, new vscode.Range(document.positionAt(d.start), document.positionAt(d.end)), d.text);
    if (await vscode.workspace.applyEdit(we)) own.add(document.version);
    else { vscode.window.showErrorMessage("VS Code rejected the edit. The file may be read-only."); sendDoc(); }
  }

  async reveal(document: vscode.TextDocument, id: string, keys: TreeKeys) {
    const r = rangeOfId(document.getText(), id, keys);
    if (!r) return;
    const range = new vscode.Range(document.positionAt(r.offset), document.positionAt(r.offset + r.length));
    // Reuse a JSON editor that is already visible for this file; otherwise open one beside.
    const open = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
    const editor = await vscode.window.showTextDocument(document, { viewColumn: open?.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus: false, selection: new vscode.Range(range.start, range.start) });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, f));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("webview.css")}">
</head><body><tree-editor></tree-editor>
<script nonce="${nonce}" src="${uri("webview.js")}"></script></body></html>`;
  }
}
