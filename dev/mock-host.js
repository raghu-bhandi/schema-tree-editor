/*
 * Browser stand-in for the VS Code extension host, for UI work without launching VS Code.
 * Uses the SAME jsonOps/model code as the extension. The textarea plays the role of the
 * VS Code JSON editor: type in it and the tree follows; edit the tree and the text follows.
 */
import { applyOp, detectFormatting, idAtOffset, parseProblems, rangeOfId } from "../src/jsonOps";
import { deriveModel } from "../src/model";
import navSchema from "../example/schemas/docs-nav.schema.json";
import flagsSchema from "../example/schemas/flags.schema.json";
import nav from "../example/data/docs-nav/v4.json";
import flags from "../example/data/flags/production.json";
import config from "../example/schema-trees.json";
import { withDefaults } from "../src/keys";

const cfg = name => config.trees.find(t => t.name === name);
const FILES = {
  "data/docs-nav/v4.json": { label: cfg("docs-nav").label, model: deriveModel(navSchema, withDefaults(cfg("docs-nav").keys)), text: JSON.stringify(nav, null, 2) + "\n" },
  "data/flags/production.json": { label: cfg("flags").label, model: deriveModel(flagsSchema, withDefaults(cfg("flags").keys)), text: JSON.stringify(flags, null, 2) + "\n" },
};
let current = Object.keys(FILES)[0], version = 1, state;
const post = data => setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data })), 0);
const f = () => FILES[current];
const ta = () => document.getElementById("json");
const sendInit = () => post({ type: "init", fileName: current, tree: { name: current, label: f().label, model: f().model } });
const sendDoc = () => post({ type: "doc", text: f().text, version, problems: parseProblems(f().text) });
const setText = (t, fromTextarea) => {
  f().text = t; version++;
  if (!fromTextarea) { const el = ta(), top = el.scrollTop; el.value = t; el.scrollTop = top; }
  sendDoc();
};

window.acquireVsCodeApi = () => ({
  getState: () => state, setState: s => { state = s; },
  postMessage(m) {
    switch (m.type) {
      case "ready": sendInit(); sendDoc(); break;
      case "edit":
        if (m.version !== version) return sendDoc();
        try { setText(applyOp(f().text, m.op, f().model.keys, detectFormatting(f().text))); } catch (e) { alert(e.message); sendDoc(); }
        break;
      case "reveal": { const r = rangeOfId(f().text, m.id, f().model.keys); if (!r) break; const el = ta(); el.focus(); el.setSelectionRange(r.offset, r.offset); el.scrollTop = el.value.slice(0, r.offset).split("\n").length * 17.5 - 60; break; }
      case "copy": navigator.clipboard?.writeText(m.text).catch(() => {}); break;
      case "openText": ta().focus(); break;
    }
  },
});

window.addEventListener("DOMContentLoaded", () => {
  const el = ta(), pick = document.getElementById("file");
  pick.innerHTML = Object.keys(FILES).map(k => `<option>${k}</option>`).join("");
  el.value = f().text;
  let t; el.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => setText(el.value, true), 150); });
  const sync = () => { const id = idAtOffset(el.value, el.selectionStart, f().model.keys); if (id) post({ type: "select", id }); };
  el.addEventListener("click", sync); el.addEventListener("keyup", e => { if (e.key.startsWith("Arrow") || e.key === "PageUp" || e.key === "PageDown") sync(); });
  pick.addEventListener("change", () => { current = pick.value; state = undefined; el.value = f().text; sendInit(); sendDoc(); });
});
