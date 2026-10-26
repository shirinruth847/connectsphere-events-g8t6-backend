// Actual migrations on isolated PGlite. Reclamation is interleaved explicitly;
// this does not claim hosted, separate-connection concurrency verification.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const read = (file) => fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
const migration = "supabase/migrations/20261027100000_spm52_outbox_claim_ownership.sql";
const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const row = (db) => one(db, "SELECT * FROM outbox_entries WHERE entry_id = 1");
const claim = (db, max = 8) => one(db, "SELECT * FROM claim_outbox_entry(1,60,$1)", [max]);
const expire = (db) => db.exec("UPDATE outbox_entries SET lease_expires_at=now()-interval '1 second' WHERE entry_id=1");
const setup = async () => {
  const db = new PGlite();
  await db.exec(read("tests/fixtures/spm177DatabaseSchema.sql"));
  await db.exec(read("supabase/migrations/20261024045601_spm52_equipment_catalogue.sql"));
  await db.exec(read("supabase/migrations/20261026100000_spm52_outbox_retry_and_past_segments.sql"));
  await db.exec(`INSERT INTO equipment(name,category,total_quantity,details_pending) VALUES ('Synthetic','Test',1,true);
    INSERT INTO outbox_entries(target_collection,document_id,pg_version,payload) VALUES ('equipment_details','1',1,'{}')`);
  await db.exec(read(migration));
  return db;
};

for (const outcome of ["release", "failure", "completion"]) {
  test(`[SPM-52] stale ${outcome} cannot change a reclaimed lease or its equipment`, async () => {
    const db = await setup();
    try {
      const first = await claim(db);
      await expire(db);
      const second = await claim(db);
      assert.ok(second.claim_generation > first.claim_generation);
      const before = await row(db);
      if (outcome === "release") {
        assert.equal((await one(db, "SELECT release_outbox_entry(1,$1,'old worker',1) AS result", [first.claim_generation])).result, false);
      } else if (outcome === "failure") {
        assert.equal((await one(db, "SELECT fail_outbox_entry(1,$1,'old worker',2) AS result", [first.claim_generation])).result, null);
      } else {
        assert.equal((await one(db, "SELECT complete_outbox_entry(1,$1) AS result", [first.claim_generation])).result, false);
      }
      assert.deepEqual(await row(db), before);
      assert.equal((await one(db, "SELECT details_pending FROM equipment WHERE equipment_id=1")).details_pending, true);
      assert.equal(await claim(db), undefined, "a third worker cannot steal the active lease");
      assert.equal((await one(db, "SELECT complete_outbox_entry(1,$1) AS result", [second.claim_generation])).result, true);
      assert.equal((await row(db)).state, "APPLIED");
      assert.equal((await one(db, "SELECT details_pending FROM equipment WHERE equipment_id=1")).details_pending, false);
    } finally { await db.close(); }
  });
}

test("[SPM-52] batch reclamation advances ownership and retains retry accounting", async () => {
  const db = await setup();
  try {
    const first = await one(db, "SELECT * FROM claim_outbox_entries(50,60,8)");
    await expire(db);
    const second = await one(db, "SELECT * FROM claim_outbox_entries(50,60,8)");
    assert.ok(second.claim_generation > first.claim_generation);
    assert.equal(second.attempts, 1);
    assert.equal((await one(db, "SELECT release_outbox_entry(1,$1,'outage',30) AS result", [second.claim_generation])).result, true);
    const released = await row(db);
    assert.equal(released.attempts, 1);
    assert.equal(released.lease_expires_at, null);
    assert.ok(released.next_attempt_at > released.created_at);
    assert.equal((await one(db, "SELECT fail_outbox_entry(1,$1,'duplicate result',8) AS result", [second.claim_generation])).result, null);
    assert.deepEqual(await row(db), released);
  } finally { await db.close(); }
});

test("[SPM-52] an expired latest owner may complete if no worker reclaimed it", async () => {
  const db = await setup();
  try {
    const owner = await claim(db);
    await expire(db);
    assert.equal((await one(db, "SELECT complete_outbox_entry(1,$1) AS result", [owner.claim_generation])).result, true);
    assert.equal((await row(db)).state, "APPLIED");
  } finally { await db.close(); }
});

test("[SPM-52] terminal abandoned attempts retain the latest owner's late-success recovery", async () => {
  const db = await setup();
  try {
    const owner = await claim(db);
    await expire(db);
    assert.equal(await claim(db, 1), undefined);
    assert.equal((await row(db)).state, "FAILED");
    assert.equal((await one(db, "SELECT complete_outbox_entry(1,$1) AS result", [owner.claim_generation])).result, true);
  } finally { await db.close(); }
});

test("[SPM-52] current-owner failure counts once and duplicate results cannot consume retries", async () => {
  const db = await setup();
  try {
    const owner = await claim(db);
    assert.equal((await one(db, "SELECT fail_outbox_entry(1,$1,'invalid document',8) AS result", [owner.claim_generation])).result, "PENDING");
    const failed = await row(db);
    assert.equal(failed.attempts, 1);
    assert.equal((await one(db, "SELECT fail_outbox_entry(1,$1,'duplicate',8) AS result", [owner.claim_generation])).result, null);
    assert.equal((await one(db, "SELECT complete_outbox_entry(1,$1) AS result", [owner.claim_generation])).result, false);
    assert.deepEqual(await row(db), failed);
  } finally { await db.close(); }
});

test("[SPM-52] migration preserves payloads, removes unfenced RPCs and restricts browser execution", async () => {
  const db = await setup();
  try {
    const stored = await row(db);
    assert.equal(stored.claim_generation, 0);
    assert.equal(stored.state, "PENDING");
    assert.deepEqual(stored.payload, {});
    assert.equal((await one(db, "SELECT complete_outbox_entry(1,0) AS result")).result, false);
    for (const signature of ["complete_outbox_entry(bigint)", "fail_outbox_entry(bigint,text,integer)", "release_outbox_entry(bigint,text,integer)"]) {
      assert.equal((await one(db, "SELECT to_regprocedure($1)::text AS signature", [signature])).signature, null);
    }
    for (const signature of ["complete_outbox_entry(bigint,bigint)", "fail_outbox_entry(bigint,bigint,text,integer)", "release_outbox_entry(bigint,bigint,text,integer)"]) {
      const access = await one(db, "SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon, has_function_privilege('authenticated',$1,'EXECUTE') AS browser, has_function_privilege('service_role',$1,'EXECUTE') AS runtime", [signature]);
      assert.deepEqual(access, { anon: false, browser: false, runtime: true });
    }
  } finally { await db.close(); }
});
