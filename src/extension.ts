import * as vscode from "vscode";
import { TreeEditorProvider } from "./provider";
import { CONFIG_FILE, SchemaRegistry } from "./registry";

export function activate(ctx: vscode.ExtensionContext) {
  const registry = new SchemaRegistry();
  const provider = new TreeEditorProvider(ctx, registry);
  ctx.subscriptions.push(
    registry,
    vscode.window.registerCustomEditorProvider(TreeEditorProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand("schemaTree.open", async (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri;
      if (!uri) return vscode.window.showInformationMessage("Open a JSON file first.");
      const doc = await vscode.workspace.openTextDocument(uri);
      if (!(await registry.forDocument(doc))) {
        const pick = await vscode.window.showWarningMessage(
          `${vscode.workspace.asRelativePath(uri)} isn't listed in any ${CONFIG_FILE}.`, "Open anyway", "Learn how");
        if (pick === "Learn how") return vscode.env.openExternal(vscode.Uri.parse("https://github.com/raghu-bhandi/schema-tree-editor#quick-start"));
        if (pick !== "Open anyway") return;
      }
      await vscode.commands.executeCommand("vscode.openWith", uri, TreeEditorProvider.viewType, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand("schemaTree.openJson", () => {
      const cur = TreeEditorProvider.current;
      if (cur) vscode.commands.executeCommand("vscode.openWith", cur.document.uri, "default", vscode.ViewColumn.Beside);
    }),

    // Runs the bundled generator (dist/gen-schemas.mjs) next to each schema-trees.json.
    // It uses the workspace's own `ts-json-schema-generator` (a devDependency there).
    vscode.commands.registerCommand("schemaTree.generateSchemas", async () => {
      const configs = await registry.configFiles();
      if (!configs.length) return vscode.window.showWarningMessage(`No ${CONFIG_FILE} found in this workspace.`);
      const script = vscode.Uri.joinPath(ctx.extensionUri, "dist", "gen-schemas.mjs").fsPath;
      for (const cfg of configs) {
        const dir = vscode.Uri.joinPath(cfg, "..");
        const ws = vscode.workspace.getWorkspaceFolder(cfg);
        // "json.schemas" goes into the workspace folder's settings, which VS Code reads even when schema-trees.json is in a subfolder.
        const args = ws ? [script, "--settings-root", ws.uri.fsPath] : [script];
        const task = new vscode.Task({ type: "schemaTree", config: cfg.fsPath }, ws ?? vscode.TaskScope.Workspace, `Generate schemas (${vscode.workspace.asRelativePath(dir)})`,
          "schema-tree", new vscode.ProcessExecution("node", args, { cwd: dir.fsPath }));
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
        await vscode.tasks.executeTask(task);
      }
    }),
  );
}

export function deactivate() {}
