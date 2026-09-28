import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveModel } from "../../src/model";
import { DEFAULT_KEYS, TreeKeys } from "../../src/keys";
import docsNav from "../../example/schemas/docs-nav.schema.json";
import flags from "../../example/schemas/flags.schema.json";

const CUSTOM: TreeKeys = { id: "key", name: "label", type: "kind", children: "items" };

describe("deriveModel", () => {
  test("definitions + anyOf (generated from TypeScript)", () => {
    const m = deriveModel(docsNav, DEFAULT_KEYS);
    assert.equal(m.rootType, "site");
    assert.deepEqual(Object.keys(m.types).sort(), ["link", "page", "section", "site"]);
    const { site, section, page } = m.types;
    assert.deepEqual(site.childTypes, ["section"]);
    assert.deepEqual(section.childTypes, ["section", "page", "link"]);
    assert.equal(page.container, false);
    assert.deepEqual(page.childTypes, []);
    assert.equal(site.label, "Site");
    assert.equal(site.icon, "globe");
    assert.equal(site.subtitle, "version");
    assert.equal(section.icon, "folder");
    assert.equal(page.def, "PageNode");
    assert.deepEqual(page.fields, ["file", "status", "summary"]);
    assert.deepEqual(page.required.sort(), ["file", "name", "status"]);
    assert.equal(page.idSchema.pattern, "^[a-z0-9-]+$");
    assert.deepEqual(Object.keys(page.formSchema.properties), ["name", "file", "status", "summary"]);
    assert.equal(page.formSchema.properties.name.propertyOrder, 0);
  });

  test("$defs + oneOf with custom keys (hand-written)", () => {
    const m = deriveModel(flags, CUSTOM);
    assert.equal(m.rootType, "flagSet");
    assert.deepEqual(m.keys, CUSTOM);
    assert.deepEqual(Object.keys(m.types).sort(), ["flag", "flagSet", "group", "rule"]);
    assert.deepEqual(m.types.group.childTypes, ["group", "flag"]);
    assert.deepEqual(m.types.flag.childTypes, ["rule"]);
    assert.equal(m.types.flag.container, true);
    assert.equal(m.types.rule.container, false);
    assert.equal(m.types.rule.hasName, true);
    // $ref'd id schema is resolved, and $defs refs are rewritten for the form library
    assert.equal(m.types.rule.idSchema.pattern, "^[a-z0-9_.-]+$");
    assert.ok(!JSON.stringify(m.types.rule.formSchema).includes("#/$defs/"));
    assert.ok(m.types.rule.formSchema.definitions.key);
    assert.deepEqual(Object.keys(m.types.rule.formSchema.properties), ["label", "when", "value", "rolloutPct"]);
  });

  test("same schema read with the wrong keys finds no nodes", () => {
    assert.throws(() => deriveModel(flags, DEFAULT_KEYS), /root must be a node/);
  });

  test("root without $ref", () => {
    const m = deriveModel({
      title: "Menu", type: "object",
      properties: {
        id: { type: "string" }, type: { const: "menu" }, name: { type: "string" },
        children: { type: "array", items: { $ref: "#/definitions/Item" } },
      },
      definitions: { Item: { type: "object", properties: { id: { type: "string" }, type: { const: "item" }, name: { type: "string" } } } },
    }, DEFAULT_KEYS);
    assert.equal(m.rootType, "menu");
    assert.equal(m.types.menu.label, "Menu");
    assert.deepEqual(m.types.menu.childTypes, ["item"]);
    assert.equal(m.types.item.label, "Item");
  });

  test("type without a name property", () => {
    const m = deriveModel({
      $ref: "#/definitions/Root",
      definitions: {
        Root: { properties: { id: {}, type: { const: "root" }, children: { items: { $ref: "#/definitions/Sep" } } } },
        Sep: { required: ["id", "type", "height"], properties: { id: {}, type: { enum: ["sep"] }, height: { type: "number" } } },
      },
    }, DEFAULT_KEYS);
    const sep = m.types.sep;
    assert.equal(sep.hasName, false);
    assert.deepEqual(Object.keys(sep.formSchema.properties), ["height"]);
    assert.deepEqual(sep.required, ["height"]);
    assert.equal(sep.icon, "symbol-field");
  });

  test("children through a named union alias and an array $ref", () => {
    const m = deriveModel({
      $ref: "#/definitions/Root",
      definitions: {
        Root: { properties: { id: {}, type: { const: "root" }, children: { $ref: "#/definitions/Kids" } } },
        Kids: { type: "array", items: { $ref: "#/definitions/Child" } },
        Child: { anyOf: [{ $ref: "#/definitions/A" }, { $ref: "#/definitions/B" }] },
        A: { properties: { id: {}, type: { const: "a" } } },
        B: { properties: { id: {}, type: { const: "b" } } },
      },
    }, DEFAULT_KEYS);
    assert.deepEqual(m.types.root.childTypes, ["a", "b"]);
  });

  test("root that isn't a node is rejected", () => {
    assert.throws(() => deriveModel({ $ref: "#/definitions/X", definitions: { X: { type: "string" } } }, DEFAULT_KEYS), /root must be a node/);
    assert.throws(() => deriveModel({ type: "object" }, DEFAULT_KEYS), /root must be a node/);
  });
});
