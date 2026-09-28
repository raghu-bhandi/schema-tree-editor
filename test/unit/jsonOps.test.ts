import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyOp, detectFormatting, findPath, idAtOffset, minimalEdit, parseProblems, rangeOfId, TreeOp } from "../../src/jsonOps";
import { DEFAULT_KEYS, TreeKeys } from "../../src/keys";

const CUSTOM: TreeKeys = { id: "key", name: "label", type: "kind", children: "items" };

/** Builds the same small tree under either key set, so every op is checked with both. */
function doc(k: TreeKeys): string {
  const n = (id: string, type: string, name: string, kids?: string[]) => {
    const o: any = { [k.id]: id, [k.type]: type, [k.name]: name };
    if (kids) o[k.children] = kids.map(c => ({ [k.id]: c, [k.type]: "leaf", [k.name]: c.toUpperCase() }));
    return o;
  };
  const root = { ...n("root", "site", "Root"), [k.children]: [n("s1", "section", "One", ["a", "b", "c"]), n("s2", "section", "Two", [])] };
  return JSON.stringify(root, null, 2) + "\n";
}

const childIds = (text: string, parentId: string, k: TreeKeys) => {
  const root = JSON.parse(text);
  const p = findPath(root, parentId, k)!;
  const node = p.reduce((v: any, key) => v[key], root);
  return (node[k.children] ?? []).map((c: any) => c[k.id]);
};

/** Length of the single replacement that turns a into b. */
const diffSize = (a: string, b: string) => { const d = minimalEdit(a, b)!; return d.end - d.start + d.text.length; };

for (const [label, k] of [["default keys", DEFAULT_KEYS], ["custom keys", CUSTOM]] as const) {
  describe(`applyOp (${label})`, () => {
    const text = doc(k);
    const run = (op: TreeOp, t = text) => applyOp(t, op, k);

    test("update changes only the value", () => {
      const out = run({ op: "update", id: "b", set: { [k.name]: "Bee" } });
      assert.equal(out, text.replace(`"${k.name}": "B"`, `"${k.name}": "Bee"`));
      assert.ok(diffSize(text, out) <= 4);
    });

    test("update with unchanged values is a no-op", () => {
      const out = run({ op: "update", id: "b", set: { [k.id]: "b", [k.name]: "B" }, unset: ["missing"] });
      assert.equal(out, text);
      assert.equal(minimalEdit(text, out), null);
    });

    test("update adds new properties before the children array", () => {
      const out = run({ op: "update", id: "s1", set: { owner: "me" } });
      const s1 = JSON.parse(out)[k.children][0];
      assert.deepEqual(Object.keys(s1), [k.id, k.type, k.name, "owner", k.children]);
    });

    test("update unsets properties", () => {
      const withNote = run({ op: "update", id: "a", set: { note: "x" } });
      assert.equal(run({ op: "update", id: "a", set: {}, unset: ["note"] }, withNote), text);
    });

    test("insert at start, middle and end", () => {
      const leaf = (id: string) => ({ [k.id]: id, [k.type]: "leaf", [k.name]: id });
      assert.deepEqual(childIds(run({ op: "insert", parentId: "s1", index: 0, node: leaf("x") }), "s1", k), ["x", "a", "b", "c"]);
      assert.deepEqual(childIds(run({ op: "insert", parentId: "s1", index: 1, node: leaf("x") }), "s1", k), ["a", "x", "b", "c"]);
      assert.deepEqual(childIds(run({ op: "insert", parentId: "s1", index: 99, node: leaf("x") }), "s1", k), ["a", "b", "c", "x"]);
      assert.deepEqual(childIds(run({ op: "insert", parentId: "s2", index: 0, node: leaf("x") }), "s2", k), ["x"]);
    });

    test("insert creates the children array when missing", () => {
      const out = run({ op: "insert", parentId: "a", index: 0, node: { [k.id]: "x", [k.type]: "leaf" } });
      assert.deepEqual(childIds(out, "a", k), ["x"]);
    });

    test("remove", () => {
      const out = run({ op: "remove", id: "b" });
      assert.deepEqual(childIds(out, "s1", k), ["a", "c"]);
      assert.doesNotThrow(() => JSON.parse(out));
    });

    test("move within the same parent, forwards", () => {
      // index counts positions after the node was removed: [b, c] -> insert at 2
      assert.deepEqual(childIds(run({ op: "move", id: "a", parentId: "s1", index: 2 }), "s1", k), ["b", "c", "a"]);
      assert.deepEqual(childIds(run({ op: "move", id: "a", parentId: "s1", index: 1 }), "s1", k), ["b", "a", "c"]);
    });

    test("move within the same parent, backwards", () => {
      assert.deepEqual(childIds(run({ op: "move", id: "c", parentId: "s1", index: 0 }), "s1", k), ["c", "a", "b"]);
      assert.deepEqual(childIds(run({ op: "move", id: "c", parentId: "s1", index: 1 }), "s1", k), ["a", "c", "b"]);
    });

    test("move to another parent keeps the node intact", () => {
      const out = run({ op: "move", id: "b", parentId: "s2", index: 0 });
      assert.deepEqual(childIds(out, "s1", k), ["a", "c"]);
      assert.deepEqual(JSON.parse(out)[k.children][1][k.children], [{ [k.id]: "b", [k.type]: "leaf", [k.name]: "B" }]);
    });

    test("invalid ops throw", () => {
      assert.throws(() => run({ op: "remove", id: "root" }), /root/);
      assert.throws(() => run({ op: "move", id: "root", parentId: "s1", index: 0 }), /root/);
      assert.throws(() => run({ op: "move", id: "s1", parentId: "a", index: 0 }), /into itself/);
      assert.throws(() => run({ op: "update", id: "nope", set: {} }), /"nope" not found/);
    });
  });
}

describe("formatting", () => {
  test("detectFormatting", () => {
    assert.deepEqual(detectFormatting('{\n  "a": 1\n}'), { insertSpaces: true, tabSize: 2, eol: "\n" });
    assert.deepEqual(detectFormatting('{\r\n    "a": 1\r\n}'), { insertSpaces: true, tabSize: 4, eol: "\r\n" });
    assert.deepEqual(detectFormatting('{\n\t"a": 1\n}'), { insertSpaces: false, tabSize: 1, eol: "\n" });
  });

  test("tabs and CRLF are kept on insert", () => {
    const text = '{\r\n\t"id": "r",\r\n\t"type": "t",\r\n\t"children": [\r\n\t\t{ "id": "a", "type": "t" }\r\n\t]\r\n}\r\n';
    const out = applyOp(text, { op: "insert", parentId: "r", index: 1, node: { id: "b", type: "t" } });
    assert.ok(!/[^\r]\n/.test(out), "only CRLF line endings");
    assert.ok(!/^ +/m.test(out), "no space indentation");
    assert.deepEqual(JSON.parse(out).children.map((c: any) => c.id), ["a", "b"]);
  });

  test("comments survive edits (JSONC)", () => {
    const text = [
      "{",
      "  // the root",
      '  "id": "r",',
      '  "type": "t",',
      '  "name": "R", /* inline */',
      '  "children": [',
      '    { "id": "a", "type": "t", "name": "A" }, // first',
      '    { "id": "b", "type": "t", "name": "B" }',
      "  ]",
      "}",
    ].join("\n");
    let out = applyOp(text, { op: "update", id: "b", set: { name: "Bee" } });
    out = applyOp(out, { op: "insert", parentId: "r", index: 2, node: { id: "c", type: "t" } });
    out = applyOp(out, { op: "update", id: "r", set: { name: "Root" } });
    for (const c of ["// the root", "/* inline */", "// first"]) assert.ok(out.includes(c), `kept ${c}`);
    assert.ok(out.includes('"name": "Bee"') && out.includes('"name": "Root"') && out.includes('"id": "c"'));
  });
});

describe("minimalEdit", () => {
  test("null when equal", () => assert.equal(minimalEdit("abc", "abc"), null));
  test("trims common prefix and suffix", () => {
    assert.deepEqual(minimalEdit('{"a": "Install"}', '{"a": "Installation"}'), { start: 14, end: 14, text: "ation" });
    assert.deepEqual(minimalEdit("abXcd", "abcd"), { start: 2, end: 3, text: "" });
    assert.deepEqual(minimalEdit("aaa", "aaaa"), { start: 3, end: 3, text: "a" });
  });
  test("applying the edit reproduces the target", () => {
    const a = doc(DEFAULT_KEYS);
    const b = applyOp(a, { op: "move", id: "c", parentId: "s2", index: 0 });
    const d = minimalEdit(a, b)!;
    assert.equal(a.slice(0, d.start) + d.text + a.slice(d.end), b);
  });
});

describe("text lookups", () => {
  const text = doc(CUSTOM);

  test("rangeOfId covers exactly the node object", () => {
    const r = rangeOfId(text, "b", CUSTOM)!;
    assert.deepEqual(JSON.parse(text.slice(r.offset, r.offset + r.length)), { key: "b", kind: "leaf", label: "B" });
    assert.equal(rangeOfId(text, "nope", CUSTOM), null);
    assert.equal(rangeOfId("{ bad", "b", CUSTOM), null);
  });

  test("idAtOffset finds the innermost node", () => {
    assert.equal(idAtOffset(text, text.indexOf('"B"'), CUSTOM), "b");
    assert.equal(idAtOffset(text, text.indexOf('"One"'), CUSTOM), "s1");
    assert.equal(idAtOffset(text, 0, CUSTOM), "root");
    assert.equal(idAtOffset(text, text.indexOf('"B"'), DEFAULT_KEYS), null, "uses the configured keys");
  });

  test("parseProblems", () => {
    assert.deepEqual(parseProblems(text), []);
    assert.deepEqual(parseProblems('{\n  "a": 1,\n  "b"\n}'), ["syntax error at line 4"]);
    assert.deepEqual(parseProblems('{ "a": [1,], }'), [], "trailing commas are tolerated");
  });
});
