// A separate privileged test connection owns fixture cleanup. Runtime audit
// grants remain append-only. Never pass this connection to the application.
const { Client } = require("pg");

async function withCleanupConnection(operation) {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for tests that write audit logs. Use a privileged connection to the configured test database.");
  let client;
  try {
    try {
      client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
      await client.connect();
    } catch {
      throw new Error("Could not connect to the privileged test database. Check TEST_DATABASE_URL.");
    }
    return await operation(client);
  } finally {
    if (client) { try { await client.end(); } catch { /* Preserve the original error without connection details. */ } }
  }
}

async function assertAuditCleanupAvailable() {
  return withCleanupConnection(async client => {
    const { rows } = await client.query("SELECT has_table_privilege(current_user, 'public.activity_log', 'DELETE') AS allowed");
    if (!rows[0]?.allowed) throw new Error("The test cleanup connection cannot delete audit logs. No fixtures have been created.");
  });
}

async function deleteFixtureAudit(manifest) {
  if (!/^[a-z0-9]+$/.test(manifest.runId)) throw new Error("Invalid fixture run ID.");
  const ids = manifest.userIds ?? [];
  if (!ids.length) return;
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Invalid fixture user IDs.");
  return withCleanupConnection(async client => {
    await client.query("BEGIN");
    try {
      // Both manifest ownership and the exact synthetic run prefix must match.
      const { rows } = await client.query('SELECT user_id, email FROM public."user" WHERE user_id = ANY($1::integer[]) FOR UPDATE', [ids]);
      if (rows.some(user => ![`spm32-${manifest.runId}-`, `spm123-${manifest.runId}-`].some(prefix => user.email.startsWith(prefix)))) throw new Error("Refusing cleanup of a non-fixture profile.");
      await client.query('DELETE FROM public.activity_log AS a USING public."user" AS u WHERE a.user_id = u.user_id AND u.user_id = ANY($1::integer[]) AND (u.email LIKE $2 OR u.email LIKE $3)', [ids, `spm32-${manifest.runId}-%`, `spm123-${manifest.runId}-%`]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

// Clarification rounds (SPM-41) block event deletion, and their messages block both
// the round and the author's profile; the runtime may only read them, so fixture
// messages and rounds are removed here, messages first. Only rows on events whose
// organiser is one of this run's synthetic profiles are touched. Reads cascade
// with the round and history views with the event.
async function deleteFixtureClarifications(manifest) {
  if (!/^[a-z0-9]+$/.test(manifest.runId)) throw new Error("Invalid fixture run ID.");
  const ids = manifest.eventIds ?? [];
  if (!ids.length) return;
  if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("Invalid fixture event IDs.");
  const prefixes = [`spm32-${manifest.runId}-`, `spm123-${manifest.runId}-`];
  return withCleanupConnection(async client => {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query('SELECT e.event_id, u.email FROM public.event AS e JOIN public."user" AS u ON u.user_id = e.organiser_id WHERE e.event_id = ANY($1::integer[]) FOR UPDATE OF e', [ids]);
      if (rows.some(event => !prefixes.some(prefix => event.email.startsWith(prefix)))) throw new Error("Refusing cleanup of a non-fixture event.");
      await client.query('DELETE FROM public.clarification_messages AS m USING public.clarifications AS c, public.event AS e, public."user" AS u WHERE m.clarification_id = c.clarification_id AND c.event_id = e.event_id AND e.organiser_id = u.user_id AND e.event_id = ANY($1::integer[]) AND (u.email LIKE $2 OR u.email LIKE $3)', [ids, `${prefixes[0]}%`, `${prefixes[1]}%`]);
      await client.query('DELETE FROM public.clarifications AS c USING public.event AS e, public."user" AS u WHERE c.event_id = e.event_id AND e.organiser_id = u.user_id AND e.event_id = ANY($1::integer[]) AND (u.email LIKE $2 OR u.email LIKE $3)', [ids, `${prefixes[0]}%`, `${prefixes[1]}%`]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}

module.exports = { assertAuditCleanupAvailable, deleteFixtureAudit, deleteFixtureClarifications, withCleanupConnection };
