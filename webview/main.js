/*
 * Webview side of Schema Tree Editor: a plain <tree-editor> custom element.
 * It never owns the data. It renders whatever JSON text the host sends, and turns
 * user actions into small operations (update / insert / remove / move) that the
 * host applies to the TextDocument. The document change then comes back here.
 */
import { Wunderbaum } from "wunderbaum";
import { JSONEditor } from "@json-editor/json-editor";

const vscode = acquireVsCodeApi();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 28);
const rid = () => Math.random().toString(36).slice(2, 6);
const ci = (name, cls = "") => `<i class="codicon codicon-${esc(name)} ${cls}" aria-hidden="true"></i>`;

class TreeEditor extends HTMLElement {
  connectedCallback() {
    if (this.r) return;
    const saved = vscode.getState() || {};
    this.expanded = new Set(saved.expanded || []);
    this.activeId = saved.activeId || null;
    this.model = null; this.doc = null; this.byId = new Map();

    this.innerHTML = `
      <header class="bar">
        <span class="file" data-r="file"></span>
        <div class="search"><input type="text" data-r="filter" placeholder="Filter by name ( / )" aria-label="Filter tree"><span data-r="count"></span></div>
        <button class="btn" data-a="jump" title="Go to node (G)">${ci("go-to-file")}Go to</button>
        <button class="btn icon" data-a="expand" title="Expand all">${ci("expand-all")}</button>
        <button class="btn icon" data-a="collapse" title="Collapse all">${ci("collapse-all")}</button>
        <button class="btn" data-a="openText" title="Open the JSON beside">${ci("json")}JSON</button>
      </header>
      <div class="banner" data-r="banner" hidden></div>
      <main class="split">
        <section class="treepane"><div class="tree" data-r="tree"></div><div class="stat" data-r="stat"></div></section>
        <section class="detail" data-r="detail"></section>
      </main>
      <dialog class="drawer" data-r="drawer">
        <form method="dialog" class="dhead"><span data-r="dicon"></span><h2 data-r="dtitle"></h2><button class="btn icon" value="cancel" title="Close (Esc)">${ci("close")}</button></form>
        <div class="typepick" data-r="typepick"></div>
        <div class="form" data-r="form"></div>
        <footer class="dfoot"><span class="err" data-r="derr"></span>
          <button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="save">Save <kbd>Ctrl Enter</kbd></button></footer>
      </dialog>
      <dialog class="palette" data-r="pal">
        <input type="text" data-r="palq" autocomplete="off" spellcheck="false" aria-label="Search nodes">
        <div class="palhint" data-r="palhint"></div>
        <ul role="listbox" data-r="pallist"></ul>
      </dialog>
      <div class="toast" role="status" data-r="toast"></div>`;
    this.r = {}; this.querySelectorAll("[data-r]").forEach(el => (this.r[el.dataset.r] = el));
    this.addEventListener("click", e => { const b = e.target.closest("[data-a]"); if (b) this.act(b.dataset.a, b); });
    this.r.pal.addEventListener("click", e => { if (e.target === this.r.pal) this.r.pal.close(); });
    this.r.drawer.addEventListener("click", e => { if (e.target === this.r.drawer) this.r.drawer.close(); });
    // Clicking the label of an optional field that is "off" switches it on (adds the key) and focuses it.
    this.r.form.addEventListener("click", e => {
      const lab = e.target.closest("label.je-form-input-label");
      if (!lab || e.target.matches("input")) return;
      const box = lab.querySelector("input.json-editor-opt-in"), field = lab.htmlFor && document.getElementById(lab.htmlFor);
      if (box && !box.checked) { e.preventDefault(); box.click(); requestAnimationFrame(() => field?.focus()); }
    });
    this.r.drawer.addEventListener("close", () => { this._je?.destroy(); this._je = null; this.tree?.setFocus(); });
    this._initKeys(); this._initFilter(); this._initPalette();
    window.addEventListener("message", e => this.onHost(e.data));
    vscode.postMessage({ type: "ready" });
  }

  /* ------------------------------------------------ host messages */
  onHost(m) {
    if (m.type === "init") {
      this.r.file.textContent = (m.tree ? m.tree.label + ": " : "") + m.fileName;
      this.model = m.tree?.model || null;
      this.k = this.model?.keys || { id: "id", name: "name", type: "type", children: "children" };
      this.problem = !m.tree ? "This file isn't listed in any schema-trees.json, so there are no node types to show." : m.tree.problem;
      this._destroyTree(); // the host sends the document right after this
    } else if (m.type === "doc") {
      this.lastDoc = m;
      this.version = m.version;
      let root = null, perr = m.problems?.[0];
      if (!perr) { try { root = JSON.parse(stripComments(m.text)); } catch (e) { perr = e.message; } }
      const banner = this.problem || (perr ? `The JSON has errors (${perr}). The tree shows the last valid version; fix the text to continue.` : "");
      this.r.banner.hidden = !banner; this.r.banner.textContent = banner;
      this.classList.toggle("readonly", !!banner);
      if (!this.model || !root) { if (!this.tree && !this.model) this.r.detail.innerHTML = ""; return; }
      this.doc = root;
      this.render();
    } else if (m.type === "select") {
      const n = this.tree?.findKey(m.id);
      if (n && !n.isActive()) n.makeVisible().then(() => n.setActive(true));
    }
  }

  /* ------------------------------------------------ tree rendering */
  _destroyTree() {
    try { this.tree?.destroy(); } catch {} // note: destroy() swaps the element for a copy of itself
    const fresh = document.createElement("div");
    fresh.className = "tree"; fresh.dataset.r = "tree";
    this.querySelector(".treepane > .tree").replaceWith(fresh); this.r.tree = fresh; this.tree = null; this.byId.clear();
  }

  toSource(n, isRoot) {
    const k = this.k, id = String(n[k.id] ?? ""), t = this.model.types[n[k.type]];
    this.byId.set(id, n);
    const d = { key: id, title: String(n[k.name] ?? id), type: n[k.type], expanded: isRoot || this.expanded.has(id) };
    if (!t) d.classes = "unknown";
    if (Array.isArray(n[k.children])) d.children = n[k.children].map(c => this.toSource(c));
    else if (t?.container) d.children = [];
    return d;
  }

  render() {
    this.byId.clear();
    const source = [this.toSource(this.doc, true)];
    if (this.tree) this.tree.visit(n => { n.expanded ? this.expanded.add(n.key) : this.expanded.delete(n.key); });
    const after = () => {
      const want = this.pendingSelect || this.activeId;
      this.pendingSelect = null;
      const n = (want && this.tree.findKey(want)) || this.tree.getFirstChild();
      const focusTree = this.focusAfter; this.focusAfter = false;
      n?.makeVisible({ scrollIntoView: false }).then(() => n.setActive(true, { focusTree }));
      if (this.r.filter.value.trim()) this._filter();
      this._stat();
    };
    if (this.tree) { this.tree.load(source).then(after); return; }
    const types = {};
    for (const [k, t] of Object.entries(this.model.types)) types[k] = { icon: "codicon codicon-" + t.icon };
    this.tree = new Wunderbaum({
      element: this.r.tree, header: false, rowHeightPx: 24, types, source,
      iconMap: {
        expanderExpanded: "codicon codicon-chevron-down", expanderCollapsed: "codicon codicon-chevron-right",
        expanderLazy: "codicon codicon-chevron-right", loading: "codicon codicon-loading", error: "codicon codicon-error",
        noData: "codicon codicon-info", folder: "codicon codicon-folder", folderOpen: "codicon codicon-folder-opened", doc: "codicon codicon-question",
      },
      filter: { mode: "hide", autoExpand: true, highlight: true, noData: "No matching nodes" },
      dnd: {
        guessDropEffect: false, preventVoidMoves: true, preventRecursion: true,
        dragStart: () => !this.readonly && !this.tree.isFilterActive() && !!this.tree.getActiveNode(),
        dragEnter: e => this._dropRegions(e.sourceNode, e.node),
        drop: e => {
          const src = e.sourceNode, tgt = e.node; if (!src) return;
          let parent, index;
          if (e.region === "over") { parent = tgt; index = tgt.children?.length || 0; }
          else { parent = tgt.parent; index = parent.children.indexOf(tgt) + (e.region === "after" ? 1 : 0); }
          const from = src.parent.children.indexOf(src);
          if (src.parent === parent && from < index) index--; // index is counted after removal
          this.send({ op: "move", id: src.key, parentId: parent.key, index }, src.key, `Moved “${src.title}”`);
        },
      },
      render: e => {
        const t = this.model.types[e.node.type], json = this.byId.get(e.node.key);
        const sub = t?.subtitle && json?.[t.subtitle];
        const el = e.nodeElem.querySelector("span.wb-title");
        if (el && sub != null && sub !== "" && !el.querySelector(".sub")) el.insertAdjacentHTML("beforeend", `<span class="sub">${esc(sub)}</span>`);
      },
      activate: e => { this.activeId = e.node.key; this._save(); this.renderDetail(e.node); },
      expand: () => this._save(),
      dblclick: e => { this.openEditor(e.node); return false; },
      keydown: e => this._treeKey(e),
      init: after,
    });
  }
  get readonly() { return this.classList.contains("readonly"); }
  _save() {
    if (!this.tree) return;
    const expanded = []; this.tree.visit(n => { if (n.expanded) expanded.push(n.key); });
    vscode.setState({ expanded, activeId: this.activeId });
  }
  _stat() { this.r.stat.textContent = this.byId.size.toLocaleString() + " nodes"; }

  _accepts(parentNode, childType) {
    const t = parentNode && this.model.types[parentNode.type];
    return !!t?.container && t.childTypes.includes(childType);
  }
  _dropRegions(src, tgt) {
    if (!src || src === tgt) return false;
    const r = [];
    if (this._accepts(tgt, src.type)) r.push("over");
    if (!tgt.parent.isRootNode() && this._accepts(tgt.parent, src.type)) r.push("before", "after");
    return r.length ? r : false;
  }

  /* ------------------------------------------------ sending edits */
  send(op, selectId, toast) {
    if (this.readonly) return this._toast("Fix the JSON errors first.");
    this.pendingSelect = selectId || null;
    this.focusAfter = true;
    vscode.postMessage({ type: "edit", op, version: this.version });
    if (toast) this._toast(toast);
  }

  /* ------------------------------------------------ keyboard */
  _treeKey(e) {
    const ev = e.event;
    if (ev.altKey) return;
    const k = (ev.ctrlKey || ev.metaKey ? "Mod+" : "") + (ev.shiftKey && ev.key.length > 1 ? "Shift+" : "") + (ev.key.length === 1 ? ev.key.toLowerCase() : ev.key);
    const map = { Enter: "edit", F2: "edit", e: "edit", n: "add", c: "clone", "Mod+d": "clone", m: "move", Delete: "delete", j: "reveal", y: "copyId", g: "jump" };
    if (map[k] && this.tree.getActiveNode()) { ev.preventDefault(); this.act(map[k]); return false; }
  }
  _initKeys() {
    document.addEventListener("keydown", e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
      const modal = this.r.drawer.open || this.r.pal.open;
      if (e.key === "/" && !typing && !modal) { e.preventDefault(); this.r.filter.focus(); this.r.filter.select(); }
      if (e.key === "g" && !typing && !modal && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.act("jump"); }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && this.r.drawer.open) { e.preventDefault(); this.save(); }
    });
  }
  _initFilter() {
    let t;
    this.r.filter.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => this._filter(), 120); });
    this.r.filter.addEventListener("keydown", e => {
      if (e.key === "Escape") { this.r.filter.value = ""; this._filter(); this.tree?.setFocus(); }
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        const hit = this.tree?.findFirst(n => n.match) || this.tree?.getActiveNode();
        hit?.setActive(true); this.tree?.setFocus();
      }
    });
  }
  _filter() {
    if (!this.tree) return;
    const q = this.r.filter.value.trim();
    if (!q) { this.tree.clearFilter(); this.r.count.textContent = ""; return; }
    const n = this.tree.filterNodes(q, { mode: "hide", autoExpand: true, highlight: true });
    this.r.count.textContent = String(n);
  }

  /* ------------------------------------------------ actions */
  act(a, btn) {
    const node = this.tree?.getActiveNode();
    switch (a) {
      case "jump": return this.tree && this.openPalette("jump");
      case "expand": return this.tree?.expandAll(true).then(() => this._save());
      case "collapse": return this.tree?.expandAll(false).then(() => { this.tree.getFirstChild()?.setExpanded(true); this._save(); });
      case "openText": return vscode.postMessage({ type: "openText" });
      case "edit": return node && this.openEditor(node);
      case "add": return node && this.openEditor(null, this.model.types[node.type]?.container ? node : node.parent);
      case "clone": return node && this.clone(node);
      case "move": return node && !node.parent.isRootNode() && this.openPalette("move");
      case "delete": return node && this.remove(node);
      case "reveal": return node && vscode.postMessage({ type: "reveal", id: node.key });
      case "copyId": return node && vscode.postMessage({ type: "copy", text: node.key, label: "id " + node.key });
      case "copyPath": return node && vscode.postMessage({ type: "copy", text: jsonPath(node), label: "JSON path" });
      case "goto": { const n = this.tree.findKey(btn.dataset.key); n?.makeVisible().then(() => n.setActive(true)); return; }
      case "pick-type": return this._setFormType(btn.dataset.type);
      case "cancel": return this.r.drawer.close();
      case "save": return this.save();
    }
  }

  clone(node) {
    if (node.parent.isRootNode()) return this._toast("The root node can't be cloned.");
    const src = this.byId.get(node.key);
    const taken = new Set(this.byId.keys());
    const k = this.k;
    const renew = n => {
      let id = n[k.id] + "-copy"; while (taken.has(id)) id = n[k.id] + "-" + rid();
      taken.add(id);
      const c = { ...structuredClone(n), [k.id]: id };
      if (Array.isArray(n[k.children])) c[k.children] = n[k.children].map(renew);
      return c;
    };
    const copy = renew(src);
    if (typeof src[k.name] === "string") copy[k.name] = src[k.name] + " (copy)";
    this.send({ op: "insert", parentId: node.parent.key, index: node.parent.children.indexOf(node) + 1, node: copy }, copy[k.id], `Cloned “${node.title}”`);
  }

  remove(node) {
    if (node.parent.isRootNode()) return this._toast("The root node can't be deleted.");
    const sib = node.getNextSibling() || node.getPrevSibling() || node.parent;
    let n = -1; node.visit(() => { n++; }, true);
    this.send({ op: "remove", id: node.key }, sib.key, `Deleted “${node.title}”${n ? ` and ${n} nested nodes` : ""}. Ctrl+Z undoes it.`);
  }

  /* ------------------------------------------------ read-only details */
  renderDetail(node) {
    const d = this.r.detail, json = this.byId.get(node.key), t = this.model.types[node.type];
    if (!json) { d.innerHTML = ""; return; }
    const path = node.getParentList(false, false);
    const crumbs = path.map(p => `<button data-a="goto" data-key="${esc(p.key)}">${esc(p.title)}</button><span class="sep">›</span>`).join("");
    const props = t ? t.formSchema.properties : {};
    const known = t ? t.fields : [];
    const reserved = Object.values(this.k);
    const extra = Object.keys(json).filter(k => !reserved.includes(k) && !known.includes(k));
    const row = (k, s, v, req) => {
      let out, cls = "";
      if (v === undefined || v === "" || v === null) { out = "not set"; cls = "empty"; }
      else if (typeof v === "boolean") out = v ? "true" : "false";
      else if (typeof v === "object") out = `<code>${esc(JSON.stringify(v))}</code>`;
      else if (s?.enum || s?.$ref) out = `<span class="pill">${esc(v)}</span>`;
      else out = esc(v);
      return `<dt title="${esc(k)}">${esc(s?.title || k)}${req ? '<span class="req" title="Required">*</span>' : ""}</dt><dd class="${cls}">${out}</dd>`;
    };
    const rows = known.map(k => row(k, props[k], json[k], t.required.includes(k))).join("")
      + extra.map(k => row(k, { title: k + " (not in type)" }, json[k])).join("");
    const kids = node.children || [];
    const accepts = t?.childTypes.map(c => this.model.types[c]?.label || c) || [];
    d.innerHTML = `
      ${path.length ? `<nav class="crumbs">${crumbs}</nav>` : ""}
      <div class="head">${ci(t?.icon || "question")}<h1>${esc(node.title)}</h1></div>
      <p class="meta"><span>${esc(t?.label || "Unknown type “" + node.type + "”")}</span>
        <button class="link" data-a="copyId" title="Copy id (Y)"><code>${esc(node.key)}</code>${ci("copy")}</button>
        <button class="link" data-a="copyPath" title="Copy JSON path"><code>${esc(jsonPath(node))}</code>${ci("copy")}</button></p>
      <div class="actions">
        <button class="btn primary" data-a="edit">${ci("edit")}Edit</button>
        ${t?.container ? `<button class="btn" data-a="add">${ci("add")}Add child</button>` : ""}
        ${path.length ? `<button class="btn" data-a="clone">${ci("copy")}Clone</button><button class="btn" data-a="move">${ci("arrow-swap")}Move to…</button>` : ""}
        <button class="btn" data-a="reveal">${ci("go-to-file")}Reveal in JSON</button>
        ${path.length ? `<button class="btn danger" data-a="delete">${ci("trash")}Delete</button>` : ""}
      </div>
      ${rows ? `<dl class="fields">${rows}</dl>` : ""}
      ${t?.container ? `<div class="kids"><h2>Children <span>${kids.length}</span></h2>
        ${accepts.length ? `<p class="meta">Accepts ${esc(accepts.join(", "))}</p>` : ""}
        <ul>${kids.slice(0, 300).map(c => {
          const ct = this.model.types[c.type], cj = this.byId.get(c.key);
          const sub = ct?.subtitle ? cj?.[ct.subtitle] : "";
          return `<li><button data-a="goto" data-key="${esc(c.key)}">${ci(ct?.icon || "question")}<span>${esc(c.title)}</span><span class="sub">${esc(sub ?? "")}</span></button></li>`;
        }).join("")}</ul></div>` : ""}
      <p class="hint">Enter edit · N add · C clone · M move · Del delete · J reveal in JSON · Y copy id · / filter · G go to</p>`;
  }

  /* ------------------------------------------------ editor (one node at a time) */
  openEditor(node, parentForNew) {
    if (this.readonly) return this._toast("Fix the JSON errors first.");
    this._edit = { node, parent: parentForNew || null };
    const tp = this.r.typepick;
    if (node) {
      const t = this.model.types[node.type];
      if (!t) return this._toast(`No type definition for “${node.type}”. Edit it in the JSON.`);
      tp.hidden = true;
      this.r.dtitle.textContent = "Edit " + t.label.toLowerCase();
      const json = this.byId.get(node.key), start = {};
      if (t.hasName) start[this.k.name] = json[this.k.name];
      for (const k of t.fields) if (json[k] !== undefined) start[k] = json[k];
      this._setFormType(node.type, start);
    } else {
      const allowed = this.model.types[parentForNew.type]?.childTypes || [];
      if (!allowed.length) return this._toast(`${this.model.types[parentForNew.type]?.label || "This node"} can't have children.`);
      tp.hidden = allowed.length < 2;
      tp.innerHTML = allowed.map(k => `<button type="button" data-a="pick-type" data-type="${esc(k)}">${ci(this.model.types[k].icon)}${esc(this.model.types[k].label)}</button>`).join("");
      this.r.dtitle.textContent = `New node in “${parentForNew.title}”`;
      this._setFormType(allowed[0]);
    }
    this.r.derr.textContent = "";
    if (!this.r.drawer.open) this.r.drawer.showModal();
    requestAnimationFrame(() => this.r.form.querySelector("input:not([type=checkbox]), textarea, select")?.focus());
  }

  _setFormType(type, startval) {
    const t = this.model.types[type];
    this._edit.type = type;
    this.r.form.classList.remove("show-errors");
    this.r.dicon.innerHTML = ci(t.icon);
    this.r.typepick.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.type === type)));
    const k = this.k;
    const prevName = t.hasName ? this._je?.getEditor("root." + k.name)?.getValue() : undefined;
    this._je?.destroy();
    const schema = structuredClone(t.formSchema);
    if (!this._edit.node) {
      const idSchema = { type: "string", ...(t.idSchema || {}), title: "Id", minLength: 1, propertyOrder: -1 };
      idSchema.description = (idSchema.description ? idSchema.description + " " : "") + "Must be unique; it can't be changed from this form later.";
      schema.properties = { [k.id]: idSchema, ...schema.properties };
      schema.required = [k.id, ...schema.required];
    }
    this._je = new JSONEditor(this.r.form, {
      schema, theme: "html", iconlib: null, startval,
      disable_collapse: true, disable_edit_json: true, disable_properties: true, disable_array_delete_all_rows: true, disable_array_delete_last_row: true,
      show_opt_in: true, show_errors: "never", use_default_values: true, prompt_before_delete: false, array_controls_top: true,
    });
    this._je.on("ready", () => {
      if (!this._edit.node) {
        const idEd = this._je.getEditor("root." + k.id), nameEd = t.hasName && this._je.getEditor("root." + k.name);
        if (prevName && nameEd) nameEd.setValue(prevName);
        let touched = false;
        const suggest = () => { if (!touched) idEd.setValue(`${slug(type)}-${(nameEd && slug(nameEd.getValue())) || "new"}-${this._sfx ||= rid()}`); };
        suggest();
        if (nameEd) this._je.watch("root." + k.name, suggest);
        idEd.input?.addEventListener("input", () => { touched = true; });
      }
    });
  }

  save() {
    const je = this._je; if (!je) return;
    // json-editor commits a field on "change"; commit the one still being typed in (Ctrl+Enter case).
    const a = document.activeElement;
    if (a && this.r.form.contains(a)) a.dispatchEvent(new Event("change", { bubbles: true }));
    const errs = je.validate();
    const v = je.getValue();
    const { node, parent, type } = this._edit;
    const k = this.k;
    if (!node && this.byId.has(v[k.id])) errs.push({ path: "root." + k.id, message: "This id is already used." });
    if (errs.length) {
      this.r.form.classList.add("show-errors");
      je.options.show_errors = "always"; je.root.showValidationErrors(errs);
      this.r.derr.textContent = errs.map(e => `${e.path.replace(/^root\.?/, "") || "form"}: ${e.message}`).slice(0, 2).join("; ");
      return;
    }
    const t = this.model.types[type];
    if (node) {
      const set = {}, unset = [];
      if (t.hasName) set[k.name] = v[k.name];
      for (const f of t.fields) (f in v ? (set[f] = v[f]) : unset.push(f));
      this.send({ op: "update", id: node.key, set, unset }, node.key, "Saved");
    } else {
      const { [k.id]: id, [k.name]: name, ...rest } = v;
      const nn = { [k.id]: id, [k.type]: type, ...(t.hasName ? { [k.name]: name } : {}), ...rest };
      if (t.container && t.required.includes(k.children)) nn[k.children] = [];
      parent.setExpanded(true); this.expanded.add(parent.key);
      this.send({ op: "insert", parentId: parent.key, index: parent.children?.length || 0, node: nn }, id, `Added “${name ?? id}”`);
      this._sfx = null;
    }
    this.r.drawer.close();
  }

  /* ------------------------------------------------ palette: go to / move to */
  _initPalette() {
    const q = this.r.palq, list = this.r.pallist;
    q.addEventListener("input", () => this._palSearch());
    q.addEventListener("keydown", e => {
      const items = [...list.querySelectorAll("li[data-key]")];
      let i = items.findIndex(li => li.getAttribute("aria-selected") === "true");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); i = Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        items.forEach((li, j) => li.setAttribute("aria-selected", String(j === i))); items[i]?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "Enter" && items[i]) { e.preventDefault(); this._palChoose(items[i].dataset.key); }
    });
    list.addEventListener("click", e => { const li = e.target.closest("li[data-key]"); if (li) this._palChoose(li.dataset.key); });
  }
  openPalette(mode) {
    const src = this.tree.getActiveNode();
    this._pal = { mode, src, index: [] };
    this.tree.visit(n => {
      if (mode === "move" && (n === src || n.isDescendantOf(src) || n === src.parent || !this._accepts(n, src.type))) return;
      const words = n.getParentList(false, true).map(a => a.title + " " + (this.byId.get(a.key)?.[this.model.types[a.type]?.subtitle] ?? "")).join(" ") + " " + n.key;
      const lc = words.toLowerCase();
      this._pal.index.push({ n, path: n.getParentList(false, false).map(p => p.title).join(" › "), lc, lcc: lc.replace(/[^a-z0-9]+/g, "") });
    });
    this.r.palq.value = "";
    this.r.palq.placeholder = mode === "move" ? `Move “${src.title}” into…` : "Go to node: name, path words, id or subtitle";
    this.r.palhint.textContent = mode === "move"
      ? `Only nodes that accept a ${this.model.types[src.type]?.label.toLowerCase() || "node"} are listed. It goes to the end.`
      : "Example: “guides auth login”";
    this._palSearch();
    this.r.pal.showModal();
    this.r.palq.focus();
  }
  _palSearch() {
    const terms = this.r.palq.value.toLowerCase().split(/\s+/).filter(Boolean);
    let hits = terms.length ? this._pal.index.filter(x => terms.every(t => x.lc.includes(t) || x.lcc.includes(t.replace(/[^a-z0-9]+/g, "")))) : this._pal.index;
    if (terms.length) {
      const last = terms[terms.length - 1];
      hits = hits.map(x => { const tl = x.n.title.toLowerCase(); return { x, s: (tl.startsWith(last) ? 0 : tl.includes(last) ? 1 : 2) + x.n.getLevel() / 100 }; })
        .sort((a, b) => a.s - b.s).map(a => a.x);
    }
    const hl = s => { let h = esc(s); for (const t of terms) h = h.replace(new RegExp("(" + esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>"); return h; };
    this.r.pallist.innerHTML = hits.slice(0, 80).map(x => `<li data-key="${esc(x.n.key)}" role="option" aria-selected="false">${ci(this.model.types[x.n.type]?.icon || "question")}<span class="t">${hl(x.n.title)}</span><span class="p">${esc(x.path)}</span></li>`).join("")
      || `<li class="none">${this._pal.mode === "move" ? "No node here accepts this type." : "No nodes match. Try fewer words."}</li>`;
    this.r.pallist.querySelector("li[data-key]")?.setAttribute("aria-selected", "true");
  }
  _palChoose(key) {
    const { mode, src } = this._pal;
    this.r.pal.close();
    const n = this.tree.findKey(key);
    if (mode === "jump") {
      if (this.tree.isFilterActive() && !n.match) { this.r.filter.value = ""; this._filter(); }
      n.makeVisible().then(() => { n.setActive(true); this.tree.setFocus(); });
      return;
    }
    this.expanded.add(n.key);
    this.send({ op: "move", id: src.key, parentId: n.key, index: n.children?.length || 0 }, src.key, `Moved “${src.title}” to “${n.title}”`);
  }

  _toast(msg) {
    this.r.toast.textContent = msg; this.r.toast.classList.add("show");
    clearTimeout(this._tt); this._tt = setTimeout(() => this.r.toast.classList.remove("show"), 2600);
  }
}

function jsonPath(node) {
  const parts = [], ck = document.querySelector("tree-editor").k.children;
  for (let n = node; n.parent && !n.parent.isRootNode(); n = n.parent) parts.unshift(`.${ck}[${n.parent.children.indexOf(n)}]`);
  return "$" + parts.join("");
}
/* JSONC tolerance: drop // and /* comments and trailing commas outside strings. */
function stripComments(s) {
  return s.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, g) => (g ? g : m));
}

customElements.define("tree-editor", TreeEditor);
