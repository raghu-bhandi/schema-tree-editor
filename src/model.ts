/**
 * Turns a JSON Schema (generated from TypeScript, or hand-written) into the small model
 * the tree view needs: node types, their icon and label, allowed child types, and a
 * form schema for each type.
 *
 * A node type is a definition that has the `id` property and a `type` property with a
 * constant value (key names are configurable). `children`, if present, says which node
 * types may be nested. Optional custom keywords on a definition:
 *   title         -> label            (TS: @title Schedule)
 *   treeIcon      -> codicon name     (TS: @treeIcon folder)
 *   treeSubtitle  -> field shown after the name (TS: @treeSubtitle code)
 */
import { TreeKeys } from "./keys";

export interface NodeTypeInfo {
  type: string; def: string; label: string; icon: string; subtitle?: string; hasName: boolean;
  container: boolean; childTypes: string[]; fields: string[]; required: string[]; formSchema: any; idSchema: any;
}
export interface TreeModel { keys: TreeKeys; rootType: string; types: Record<string, NodeTypeInfo> }

export function deriveModel(schema: any, keys: TreeKeys): TreeModel {
  // Normalise draft-2019+ "$defs" to "definitions" so every consumer (incl. the form library) sees one shape.
  schema = JSON.parse(JSON.stringify(schema).replace(/"#\/\$defs\//g, '"#/definitions/'));
  const defs: Record<string, any> = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
  const refName = (r: string) => r.replace(/^#\/definitions\//, "");
  const resolve = (s: any): any => (s?.$ref ? resolve(defs[refName(s.$ref)]) : s);
  const constOf = (s: any) => { const r = resolve(s); return r?.const ?? (Array.isArray(r?.enum) && r.enum.length === 1 ? r.enum[0] : undefined); };
  const isNode = (d: any) => !!d?.properties?.[keys.id] && constOf(d.properties[keys.type]) !== undefined;
  const nodeDefsIn = (s: any): string[] => {
    if (!s) return [];
    if (s.$ref) { const n = refName(s.$ref); return isNode(defs[n]) ? [n] : nodeDefsIn(defs[n]); }
    const alts = s.anyOf || s.oneOf;
    return alts ? alts.flatMap(nodeDefsIn) : [];
  };
  // A schema whose root is an inline node (no $ref) is registered under a synthetic name.
  let rootName = schema.$ref ? refName(schema.$ref) : undefined;
  if (!rootName && isNode(schema)) { rootName = "(root)"; defs[rootName] = schema; }

  const reserved = new Set([keys.id, keys.type, keys.name, keys.children]);
  const types: Record<string, NodeTypeInfo> = {};
  for (const [name, d] of Object.entries(defs)) {
    if (!isNode(d)) continue;
    const t = String(constOf(d.properties[keys.type]));
    const kids = d.properties[keys.children];
    const childTypes = kids ? nodeDefsIn(resolve(kids)?.items).map(n => String(constOf(defs[n].properties[keys.type]))) : [];
    const fields = Object.keys(d.properties).filter(k => !reserved.has(k));
    const hasName = !!d.properties[keys.name];
    const props: Record<string, any> = {};
    if (hasName) props[keys.name] = { title: "Name", ...d.properties[keys.name], propertyOrder: 0 };
    fields.forEach((k, i) => (props[k] = { ...d.properties[k], propertyOrder: i + 1 }));
    const required = (d.required || []).filter((k: string) => k === keys.name || !reserved.has(k));
    types[t] = {
      type: t, def: name, hasName,
      label: d.title || name.replace(/Node$/, ""),
      icon: d.treeIcon || (kids ? "folder" : "symbol-field"),
      subtitle: d.treeSubtitle,
      container: !!kids, childTypes: [...new Set(childTypes)], fields, required, idSchema: resolve(d.properties[keys.id]),
      formSchema: { type: "object", title: " ", properties: props, required, additionalProperties: false, definitions: defs },
    };
  }
  if (!rootName || !isNode(defs[rootName])) throw new Error(`The schema's root must be a node: an object with "${keys.id}" and a constant "${keys.type}".`);
  if (!Object.keys(types).length) throw new Error("No node types found in the schema.");
  return { keys, rootType: String(constOf(defs[rootName].properties[keys.type])), types };
}
