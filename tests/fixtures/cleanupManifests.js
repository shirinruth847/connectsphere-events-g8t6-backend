// Removes fixtures left behind by interrupted integration runs.
// Only records listed in local manifests are touched.
const fs = require("fs");
const path = require("path");
const { cleanupManifest, MANIFEST_DIR } = require("./authFixtures");

const cleanupAll = async () => {
  const files = fs.existsSync(MANIFEST_DIR) ? fs.readdirSync(MANIFEST_DIR).filter((name) => name.endsWith(".json")) : [];

  for (const name of files) {
    const manifest = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, name), "utf8"));
    await cleanupManifest(manifest);
    console.log(`Cleaned fixture run ${manifest.runId}`);
  }
  console.log(`${files.length} manifest(s) processed.`);
};

cleanupAll().catch((error) => {
  console.error("Cleanup failed:", error.message);
  process.exitCode = 1;
});
