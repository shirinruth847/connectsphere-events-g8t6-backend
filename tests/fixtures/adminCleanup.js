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

module.exports = { assertAuditCleanupAvailable, deleteFixtureAudit, withCleanupConnection };
