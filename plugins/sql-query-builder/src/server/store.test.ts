import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultSqlPreferences,
  sqlPreferencesSchema,
} from "../shared/contracts.js";
import { createSqlStore } from "./store.js";

test("lists bundled tables with schemas and columns", async () => {
  const store = createSqlStore();
  const tables = await store.listTables();
  assert.ok(tables.length >= 5);
  const users = tables.find((t) => t.name === "users");
  assert.ok(users);
  assert.equal(users.schema, "public");
  assert.ok(users.columns.some((c) => c.isPrimary));
  assert.ok(tables.some((t) => t.schema === "analytics"));
});

test("getTable resolves by name and misses unknown tables", async () => {
  const store = createSqlStore();
  assert.equal((await store.getTable("orders"))?.name, "orders");
  assert.equal(await store.getTable("nope"), undefined);
});

test("searchTables matches name, description, and columns", async () => {
  const store = createSqlStore();
  const byName = await store.searchTables("users");
  assert.ok(byName.some((t) => t.name === "users"));

  const byDescription = await store.searchTables("product catalog");
  assert.deepEqual(
    byDescription.map((t) => t.name),
    ["products"],
  );

  const byColumn = await store.searchTables("user_id");
  assert.ok(byColumn.some((t) => t.name === "orders"));
  assert.ok(byColumn.some((t) => t.name === "sessions"));

  const all = await store.searchTables("  ");
  assert.equal(all.length, (await store.listTables()).length);

  const none = await store.searchTables("zzz-no-match");
  assert.deepEqual(none, []);
});

test("saved queries reference known tables", async () => {
  const store = createSqlStore();
  const tables = (await store.listTables()).map((t) => t.name);
  const queries = await store.listQueries();
  assert.ok(queries.length > 0);
  for (const query of queries) {
    assert.ok(query.sql.startsWith("SELECT "));
    for (const table of query.tables) {
      assert.ok(tables.includes(table), `unknown table ${table}`);
    }
  }
});

test("updateSettings merges partial preferences within schema limits", async () => {
  const store = createSqlStore();
  const defaults = await store.readSettings();
  assert.deepEqual(defaults, {
    defaultSchema: "public",
    maxRows: 100,
    format: "table",
    showTimings: true,
  });

  const updated = await store.updateSettings({ maxRows: 500, format: "json" });
  assert.equal(updated.maxRows, 500);
  assert.equal(updated.format, "json");
  assert.equal(updated.defaultSchema, "public");

  assert.deepEqual(await store.readSettings(), updated);

  assert.throws(() =>
    sqlPreferencesSchema.parse({ ...defaultSqlPreferences, maxRows: 5 }),
  );
  assert.throws(() =>
    sqlPreferencesSchema.parse({
      ...defaultSqlPreferences,
      defaultSchema: "nope",
    }),
  );
  assert.doesNotThrow(() =>
    sqlPreferencesSchema.parse({
      ...defaultSqlPreferences,
      format: "csv",
      showTimings: false,
    }),
  );
});
