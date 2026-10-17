const { MongoClient } = require("mongodb");

const MIGRATION_ID = "0001_venue_details";
const DB_NAME = process.env.MONGODB_DB_NAME || "connectsphere_dev";

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const migrations = db.collection("_schema_migrations");
  const existing = await migrations.findOne({ _id: MIGRATION_ID });
  if (existing) { console.log("already applied"); await client.close(); return; }
  const fs = require("fs");
  const path = require("path");
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", "venue_details.json"), "utf8"));
  await db.createCollection("venue_details", { validator: { $jsonSchema: schema.$jsonSchema }, validationAction: "error" });
  await db.collection("venue_details").createIndex({ name: "text" });
  await migrations.insertOne({ _id: MIGRATION_ID, appliedAt: new Date() });
  await client.close();
  console.log("applied");
}

run().catch((e) => { console.error(e); process.exit(1); });
