/**
 * Pure JSON-text operations shared by the extension host and the browser preview.
 * Every tree edit is applied to the document TEXT with jsonc-parser, so formatting,
 * key order and comments survive, and diffs stay small.
 */
import { applyEdits, findNodeAtLocation, FormattingOptions, JSONPath, modify, Node, parse, ParseError, parseTree } from "jsonc-parser";
import { DEFAULT_KEYS, TreeKeys } from "./keys";

type Json = Record<string, any>;

export type TreeOp =
  | { op: "update"; id: string; set: Record<string, unknown>; unset?: string[] }
  | { op: "insert"; parentId: string; index: number; node: Json }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; parentId: string; index: number };

/** Detect indentation and line endings so edits match the file's style. */
export function detectFormatting(text: string): FormattingOptions {
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m ? m[1] : "  ";
  return { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** JSON path (e.g. ["children", 2, "children", 0]) of the node with this id, or null. */
export function findPath(root: Json, id: string, k: TreeKeys = DEFAULT_KEYS): JSONPath | null {
  if (root?.[k.id] === id) return [];
  const kids = root?.[k.children];
  if (!Array.isArray(kids)) return null;
  for (let i = 0; i < kids.length; i++) {
    const p = findPath(kids[i], id, k);
    if (p) return [k.children, i, ...p];
  }
  return null;
}

const valueAt = (root: any, path: JSONPath): any => path.reduce((v, key) => (v == null ? v : v[key as any]), root);

function edit(text: string, path: JSONPath, value: unknown, fmt: FormattingOptions, k: TreeKeys, isArrayInsertion = false): string {
  // New properties go before the children array so a node's own fields stay above its nested nodes.
  const getInsertionIndex = (props: string[]) => { const i = props.indexOf(k.children); return i < 0 ? props.length : i; };
  return applyEdits(text, modify(text, path, value, { formattingOptions: fmt, isArrayInsertion, getInsertionIndex }));
}

/** Apply one tree operation to the JSON text. Throws with a readable message if it cannot. */
export function applyOp(text: string, op: TreeOp, k: TreeKeys = DEFAULT_KEYS, fmt = detectFormatting(text)): string {
  const root = parse(text) as Json;
  const need = (id: string) => { const p = findPath(root, id, k); if (!p) throw new Error(`Node "${id}" not found in the file.`); return p; };
  switch (op.op) {
    case "update": {
      const p = need(op.id);
      for (const [key, v] of Object.entries(op.set)) {
        if (JSON.stringify(valueAt(root, [...p, key])) !== JSON.stringify(v)) text = edit(text, [...p, key], v, fmt, k);
      }
      for (const key of op.unset || []) if (valueAt(root, [...p, key]) !== undefined) text = edit(text, [...p, key], undefined, fmt, k);
      return text;
    }
    case "insert":
      return insertChild(text, root, need(op.parentId), op.index, op.node, fmt, k);
    case "remove": {
      const p = need(op.id);
      if (!p.length) throw new Error("The root node cannot be removed.");
      return edit(text, p, undefined, fmt, k);
    }
    case "move": {
      const p = need(op.id);
      if (!p.length) throw new Error("The root node cannot be moved.");
      const node = valueAt(root, p);
      if (findPath(node, op.parentId, k)) throw new Error("A node cannot be moved into itself.");
      const removed = edit(text, p, undefined, fmt, k);
      const root2 = parse(removed) as Json;
      const pp = findPath(root2, op.parentId, k);
      if (!pp) throw new Error(`Target "${op.parentId}" not found.`);
      return insertChild(removed, root2, pp, op.index, node, fmt, k);
    }
  }
}

function insertChild(text: string, root: Json, parentPath: JSONPath, index: number, node: Json, fmt: FormattingOptions, k: TreeKeys): string {
  const kids = valueAt(root, [...parentPath, k.children]);
  if (!Array.isArray(kids)) return edit(text, [...parentPath, k.children], [node], fmt, k);
  const i = Math.max(0, Math.min(index, kids.length));
  return edit(text, [...parentPath, k.children, i === kids.length ? -1 : i], node, fmt, k, true);
}

/** Smallest single replacement turning a into b (trims common prefix/suffix). */
export function minimalEdit(a: string, b: string): { start: number; end: number; text: string } | null {
  if (a === b) return null;
  let s = 0; const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  return { start: s, end: ea, text: b.slice(s, eb) };
}

/** Text range of the node object with this id (for "Reveal in JSON"). */
export function rangeOfId(text: string, id: string, k: TreeKeys = DEFAULT_KEYS): { offset: number; length: number } | null {
  const tree = parseTree(text); if (!tree) return null;
  const p = findPath(parse(text), id, k); if (!p) return null;
  const n = findNodeAtLocation(tree, p);
  return n ? { offset: n.offset, length: n.length } : null;
}

/** Id of the innermost tree node that contains the offset (for cursor sync). */
export function idAtOffset(text: string, offset: number, k: TreeKeys = DEFAULT_KEYS): string | null {
  const tree = parseTree(text); if (!tree) return null;
  const idOf = (n: Node) => n.children?.find(pr => pr.children?.[0]?.value === k.id && pr.children[1]?.type === "string")?.children?.[1]?.value as string | undefined;
  let best: string | undefined;
  const visit = (n: Node) => {
    if (offset < n.offset || offset > n.offset + n.length) return;
    if (n.type === "object") { const id = idOf(n); if (id) best = id; }
    n.children?.forEach(visit);
  };
  visit(tree);
  return best ?? null;
}

/** Parse errors as readable strings with line numbers (empty when valid). */
export function parseProblems(text: string): string[] {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  return errors.slice(0, 3).map(e => `syntax error at line ${text.slice(0, e.offset).split("\n").length}`);
}
