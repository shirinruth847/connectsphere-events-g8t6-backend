// Applies the numbered scripts in mongodb/migrations in order and records each
// one in _schema_migrations, so a script never runs twice (Master M8).
// Usage: npm run mongo:migrate  (uses MONGODB_URI and MONGODB_DB_NAME from .env)
const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

const loadMigrations = () =>
  fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{4}_.+\.js$/.test(file))
    .sort()
    .map((file) => require(path.join(MIGRATIONS_DIR, file)));

const applyMigrations = async (db) => {
  const history = db.collection("_schema_migrations");
  const applied = [];
  for (const migration of loadMigrations()) {
    if (await history.findOne({ _id: migration.id })) continue;
    await migration.up(db);
    await history.insertOne({ _id: migration.id, appliedAt: new Date() });
    applied.push(migration.id);
  }
  return applied;
};

if (require.main === module) {
  const { getMongoDb, closeMongoDb } = require("../config/mongodb");
  getMongoDb()
    .then(async (db) => {
      const applied = await applyMigrations(db);
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Nothing to apply.");
    })
    .catch((error) => {
      console.error("MongoDB migration failed:", error.message);
      process.exitCode = 1;
    })
    .finally(closeMongoDb);
}

module.exports = { applyMigrations };
