// Temporary synthetic identities and events for the SPM-180 browser walkthrough.
// Usage: node tests/fixtures/spm180BrowserFixture.js create
//        node tests/fixtures/spm180BrowserFixture.js cleanup <runId>
const { newRunId, createAuthFixtures, cleanupAuthFixtures } = require("./authFixtures");

async function main() {
  const [operation, requestedRunId] = process.argv.slice(2);
  if (operation === "create") {
    const runId = newRunId();
    const fixtures = await createAuthFixtures(runId);
    const lead = fixtures.accounts.coordinatorLead;
    console.log(JSON.stringify({
      runId,
      leadEmail: lead.email,
      leadPassword: lead.password,
      reassignableEventId: fixtures.events.reassignable,
      eventTitleSearch: `spm32-${runId} reassignable`,
      oldCoordinatorId: fixtures.accounts.coordinator.userId,
      availableCoordinatorName: "spm32 coordinatorThree",
    }));
    return;
  }
  if (operation === "cleanup" && /^[a-z0-9]+$/.test(requestedRunId || "")) {
    await cleanupAuthFixtures(requestedRunId);
    console.log(`Cleaned synthetic SPM-180 fixture run ${requestedRunId}.`);
    return;
  }
  throw new Error("Usage: create | cleanup <runId>");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
