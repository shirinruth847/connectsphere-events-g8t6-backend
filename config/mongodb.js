const { MongoClient } = require("mongodb");

require("dotenv").config();

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
    const client = new MongoClient(uri, { appName: "SPM" });
    clientPromise = client.connect().then(() => client);
  }

  const client = await clientPromise;
  return client.db(databaseName);
};

module.exports = { getMongoDb };
