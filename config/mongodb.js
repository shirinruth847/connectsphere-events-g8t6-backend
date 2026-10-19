const { MongoClient } = require("mongodb");

require("dotenv").config();

// Fail fast when Atlas is unreachable: callers fall back to PostgreSQL-only
// results (Master M4) instead of waiting the driver's default 30 seconds.
const SERVER_SELECTION_TIMEOUT_MS = 3000;

let clientPromise;

const getMongoDb = async () => {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB_NAME || "connectsphere_dev";
  if (!uri) {
    const error = new Error("MongoDB is not configured.");
    error.code = "MONGODB_NOT_CONFIGURED";
    throw error;
  }

  if (!clientPromise) {
    const client = new MongoClient(uri, { appName: "SPM", serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
    // A failed connection is not cached, so the next request retries.
    clientPromise = client.connect().then(() => client).catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }

  const client = await clientPromise;
  return client.db(databaseName);
};

// Lets tests and scripts end the process cleanly.
const closeMongoDb = async () => {
  if (!clientPromise) return;
  const pending = clientPromise;
  clientPromise = undefined;
  const client = await pending.catch(() => null);
  if (client) await client.close();
};

module.exports = { getMongoDb, closeMongoDb, SERVER_SELECTION_TIMEOUT_MS };
