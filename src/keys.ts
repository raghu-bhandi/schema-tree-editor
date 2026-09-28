/** Property names that give a JSON object its tree meaning. All configurable per tree. */
export interface TreeKeys {
  /** Stable unique id of a node. */
  id: string;
  /** Display name. If a node type has no such property, the id is shown instead. */
  name: string;
  /** Discriminator: a string literal naming the node type. */
  type: string;
  /** Array of nested nodes. */
  children: string;
}
export const DEFAULT_KEYS: TreeKeys = { id: "id", name: "name", type: "type", children: "children" };
export const withDefaults = (...partials: (Partial<TreeKeys> | undefined)[]): TreeKeys => Object.assign({}, DEFAULT_KEYS, ...partials.filter(Boolean));
