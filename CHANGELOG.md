# Changelog

## 0.1.0

First release.

- Custom editor for tree-shaped JSON: tree on the left, read-only details on the right, edit one node at a time in a slide-in form.
- Node types from TypeScript interfaces (generated schema) or a hand-written JSON Schema.
- Configurable key names (`id`, `name`, `type`, `children`) per tree.
- Add, clone, move (drag or "Move to…"), and delete, restricted to the child types the schema allows.
- Two-way sync with the JSON text editor: cursor selects the node, "Reveal in JSON" jumps back. Undo, save and Git work as usual.
- Filter, "Go to" palette, and keyboard shortcuts.
- `Generate Schemas from TypeScript` command, also runnable in CI with `--check`.
