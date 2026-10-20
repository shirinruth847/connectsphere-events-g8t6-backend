// Opt-in hosted verification. Requires an explicitly authorized development
// project, TEST_DATABASE_URL for cleanup, and a real frontend on localhost:3000.
const assert = require("node:assert/strict");
const path = require("node:path");
process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
const app = require("../../app");
const supabase = require("../../config/supabase");
const { assertAuditCleanupAvailable } = require("../fixtures/adminCleanup");
const { newRunId, createAuthFixtures, cleanupAuthFixtures } = require("../fixtures/authFixtures");

const runId = newRunId();
let browser;
let server;
function data(result) { if (result.error) throw new Error(result.error.message); return result.data; }

async function main() {
  assert.equal(new URL(process.env.SUPABASE_URL).hostname, "rvwiflsedoujspmzfrbq.supabase.co");
  assert(process.env.CONNECTSPHERE_FRONTEND_DIR, "Set CONNECTSPHERE_FRONTEND_DIR to the frontend app directory.");
  const { chromium } = require(path.join(process.env.CONNECTSPHERE_FRONTEND_DIR, "node_modules/@playwright/test"));
  await assertAuditCleanupAvailable();
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(8000, () => resolve(instance));
    instance.on("error", reject);
  });
  const fixtures = await createAuthFixtures(runId);
  const eventId = fixtures.events.unassignedQueueItem;
  const title = `spm32-${runId} unassignedQueueItem`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ timezoneId: "Asia/Singapore" });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on("pageerror", error => runtimeErrors.push(error.message));
  await page.goto("http://localhost:3000/login");
  await page.locator("#email").fill(fixtures.accounts.coordinatorLead.email);
  await page.locator("#password").fill(fixtures.accounts.coordinatorLead.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Assignment queue", exact: true }).waitFor();
  const queueCard = page.getByRole("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await queueCard.getByRole("combobox").selectOption(String(fixtures.accounts.coordinatorThree.userId));
  await queueCard.getByRole("button", { name: "Assign coordinator", exact: true }).click();
  await page.getByRole("button", { name: "Confirm assignment", exact: true }).click();
  await page.getByRole("status").filter({ hasText: `Coordinator assigned for REQ-${String(eventId).padStart(6, "0")}` }).waitFor();
  assert.equal(await queueCard.count(), 0);
  assert.deepEqual(data(await supabase.from("event").select("status,coordinator_id").eq("event_id", eventId).single()), {
    status: "UNDER_REVIEW", coordinator_id: fixtures.accounts.coordinatorThree.userId,
  });
  console.log("PASS: real Lead login, UI assignment, queue removal and persisted UNDER_REVIEW state");

  await page.goto("http://localhost:3000/assignments");
  const assignment = page.getByRole("article", { name: title, exact: true });
  await assignment.getByRole("combobox").selectOption(String(fixtures.accounts.coordinatorTwo.userId));
  await assignment.getByRole("button", { name: "Reassign coordinator", exact: true }).click();
  await page.getByRole("button", { name: "Confirm assignment", exact: true }).click();
  await page.getByRole("status").filter({ hasText: `Coordinator updated for REQ-${String(eventId).padStart(6, "0")}` }).waitFor();
  await assignment.getByText("spm32 coordinatorTwo", { exact: true }).waitFor();
  const stored = data(await supabase.from("event").select("status,coordinator_id").eq("event_id", eventId).single());
  assert.deepEqual(stored, { status: "UNDER_REVIEW", coordinator_id: fixtures.accounts.coordinatorTwo.userId });
  const history = data(await supabase.from("event_assignments").select("coordinator_id,assigned_by,ended_at").eq("event_id", eventId).order("assignment_id"));
  assert.equal(history.length, 2);
  assert(history[0].ended_at);
  assert.equal(history[1].ended_at, null);
  assert.equal(history[1].assigned_by, fixtures.accounts.coordinatorLead.userId);
  const notifications = data(await supabase.from("notification").select("notification_recipient(recipient_id)").eq("event_id", eventId));
  assert.equal(notifications.length, 5);
  assert.equal(notifications.flatMap(row => row.notification_recipient).length, 5);
  const activity = data(await supabase.from("activity_log").select("actor_role,audience").eq("entity_name", "event").eq("entity_id", eventId));
  assert.equal(activity.length, 2);
  assert(activity.every(row => row.actor_role === "COORDINATOR_LEAD" && row.audience === "STAFF_ONLY"));
  assert.deepEqual(runtimeErrors, []);
  console.log("PASS: real UI reassignment, preserved lifecycle, two history entries, five notifications and two staff audit entries");
  await context.close();
}

(async () => {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    try { await cleanupAuthFixtures(runId); console.log("PASS: namespaced fixture cleanup verified"); }
    catch (error) { console.error(`Cleanup failed for ${runId}: ${error.message}`); process.exitCode = 1; }
  }
})();
