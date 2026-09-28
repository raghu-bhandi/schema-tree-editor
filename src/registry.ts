/**
 * Finds schema-trees.json files in the workspace, maps documents to their tree by glob,
 * loads the tree's JSON Schema, and reloads when the config or a schema changes.
 */
import * as vscode from "vscode";
import { TreeKeys, withDefaults } from "./keys";
import { deriveModel, TreeModel } from "./model";

export const CONFIG_FILE = "schema-trees.json";

interface TreeEntry { name: string; label?: string; files: string[]; schema?: string; typesFile?: string; rootType?: string; keys?: Partial<TreeKeys> }
interface LoadedConfig { uri: vscode.Uri; dir: vscode.Uri; schemaDir: string; keys?: Partial<TreeKeys>; trees: TreeEntry[] }
export interface ResolvedTree { name: string; label: string; model?: TreeModel; problem?: string }

export class SchemaRegistry implements vscode.Disposable {
  private configs?: Promise<LoadedConfig[]>;
  private models = new Map<string, Promise<{ model?: TreeModel; problem?: string }>>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private watchers: vscode.Disposable[] = [];

  constructor() {
    const reset = () => { this.configs = undefined; this.models.clear(); this.emitter.fire(); };
    for (const glob of [`**/${CONFIG_FILE}`, "**/*.schema.json"]) {
      const w = vscode.workspace.createFileSystemWatcher(glob);
      w.onDidChange(reset); w.onDidCreate(reset); w.onDidDelete(reset);
      this.watchers.push(w);
    }
  }

  async configFiles(): Promise<vscode.Uri[]> { return (await this.loadConfigs()).map(c => c.uri); }

  private loadConfigs(): Promise<LoadedConfig[]> {
    return (this.configs ??= (async () => {
      const uris = await vscode.workspace.findFiles(`**/${CONFIG_FILE}`, "**/node_modules/**", 50);
      const out: LoadedConfig[] = [];
      for (const uri of uris) {
        try {
          const cfg = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
          out.push({ uri, dir: vscode.Uri.joinPath(uri, ".."), schemaDir: cfg.schemaDir || "schemas", keys: cfg.keys, trees: cfg.trees || [] });
        } catch (e: any) {
          vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(uri)}: ${e.message}`);
        }
      }
      return out;
    })());
  }

  /** The tree (label, model) that a document belongs to, or undefined if none matches. */
  async forDocument(doc: vscode.TextDocument): Promise<ResolvedTree | undefined> {
    for (const cfg of await this.loadConfigs()) {
      for (const t of cfg.trees) {
        const hit = (t.files || []).some(g => vscode.languages.match({ pattern: new vscode.RelativePattern(cfg.dir, g) }, doc) > 0);
        if (!hit) continue;
        const schemaUri = vscode.Uri.joinPath(cfg.dir, t.schema || `${cfg.schemaDir}/${t.name}.schema.json`);
        const keys = withDefaults(cfg.keys, t.keys);
        const cacheKey = schemaUri.toString() + JSON.stringify(keys);
        if (!this.models.has(cacheKey)) this.models.set(cacheKey, this.loadModel(schemaUri, keys, !t.schema));
        return { name: t.name, label: t.label || t.name, ...(await this.models.get(cacheKey)!) };
      }
    }
    return undefined;
  }

  private async loadModel(uri: vscode.Uri, keys: TreeKeys, generated: boolean) {
    try {
      const schema = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      return { model: deriveModel(schema, keys) };
    } catch (e: any) {
      const hint = generated ? ' Run "Schema Tree: Generate Schemas from TypeScript".' : "";
      return { problem: `Couldn't use ${vscode.workspace.asRelativePath(uri)}: ${e.code === "FileNotFound" ? "file not found." : e.message}${hint}` };
    }
  }

  dispose() { this.watchers.forEach(w => w.dispose()); this.emitter.dispose(); }
}
