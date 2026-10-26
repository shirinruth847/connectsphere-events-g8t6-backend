// Exercise the real constraint upgrade in isolation; no hosted writes or
// claim about the full deployed schema, grants or concurrent connections.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const read = (name) => fs.readFileSync(path.join(__dirname, "../../supabase/migrations", name), "utf8");
const suggestion = read("20261023041519_spm72_event_venue_suggestion.sql");
const upgrade = suggestion.slice(suggestion.indexOf("-- Keeps every operation"), suggestion.indexOf("-- One current suggestion"));
const clarification = read("20261024120000_spm41_clarification_threads.sql");
const currentCheck = clarification.match(/CHECK \(operation = ANY \(ARRAY\[[\s\S]*?\]\)\)/)[0];
const operations = [
  "event.request_clarification", "event.resubmit", "clarification.post_message",
  "event.save_amendments", "event.complete_clarification",
];

test("[SPM-72] upgrading after clarification preserves existing replay records and future commands", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE public.idempotency_records (
      operation text CONSTRAINT idempotency_records_operation_check ${currentCheck}
    )`);
    for (const operation of operations) await db.query("INSERT INTO public.idempotency_records VALUES ($1)", [operation]);
    await db.exec(upgrade);
    for (const operation of [...operations, "event.suggest_venue"]) {
      await db.query("INSERT INTO public.idempotency_records VALUES ($1)", [operation]);
    }
    assert.equal((await db.query("SELECT count(*)::int AS count FROM public.idempotency_records")).rows[0].count, 11);
    await assert.rejects(db.exec("INSERT INTO public.idempotency_records VALUES ('unsupported')"), { code: "23514" });
  } finally { await db.close(); }
});

test("[SPM-72] the upgrade extends older constraints without dropping operations added by another branch", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE public.idempotency_records (
      operation text CONSTRAINT idempotency_records_operation_check
      CHECK (operation IN ('event.create_draft', 'synthetic.other_branch'))
    ); INSERT INTO public.idempotency_records VALUES ('synthetic.other_branch')`);
    await db.exec(upgrade);
    for (const operation of ["event.create_draft", "synthetic.other_branch", "event.suggest_venue"]) {
      await db.query("INSERT INTO public.idempotency_records VALUES ($1)", [operation]);
    }
    await assert.rejects(db.exec("INSERT INTO public.idempotency_records VALUES ('unsupported')"), { code: "23514" });
  } finally { await db.close(); }
});
