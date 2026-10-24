jest.mock("mongodb", () => ({ MongoClient: jest.fn() }));

const { MongoClient } = require("mongodb");

const ORIGINAL_ENV = { ...process.env };

// A fresh module per test, so no cached connection carries over.
const loadConfig = () => {
  let config;
  jest.isolateModules(() => {
    config = require("../../config/mongodb");
  });
  return config;
};

const fakeClient = (connect) => {
  const client = { connect: jest.fn(connect), db: jest.fn((name) => ({ name })), close: jest.fn() };
  return client;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MONGODB_URI = "mongodb://example.invalid:27017";
  process.env.MONGODB_DB_NAME = "spm72_unit";
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("config/mongodb getMongoDb", () => {
  test("should_refuse_without_connecting_when_mongodb_uri_is_empty", async () => {
    process.env.MONGODB_URI = "";
    const { getMongoDb } = loadConfig();

    await expect(getMongoDb()).rejects.toMatchObject({ code: "MONGODB_NOT_CONFIGURED" });
    expect(MongoClient).not.toHaveBeenCalled();
  });

  test("should_fail_fast_with_a_short_server_selection_timeout", async () => {
    MongoClient.mockImplementation(() => fakeClient(async () => {}));
    const { getMongoDb, SERVER_SELECTION_TIMEOUT_MS } = loadConfig();

    await getMongoDb();

    expect(SERVER_SELECTION_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    expect(MongoClient).toHaveBeenCalledWith("mongodb://example.invalid:27017", {
      appName: "SPM",
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    });
  });

  test("should_retry_on_the_next_request_when_a_connection_attempt_failed", async () => {
    const failing = fakeClient(async () => {
      throw Object.assign(new Error("Server selection timed out"), { name: "MongoServerSelectionError" });
    });
    const working = fakeClient(async () => {});
    MongoClient.mockImplementationOnce(() => failing).mockImplementationOnce(() => working);
    const { getMongoDb } = loadConfig();

    await expect(getMongoDb()).rejects.toThrow("Server selection timed out");
    await expect(getMongoDb()).resolves.toEqual({ name: "spm72_unit" });

    expect(MongoClient).toHaveBeenCalledTimes(2);
    expect(working.db).toHaveBeenCalledWith("spm72_unit");
  });

  test("should_reuse_one_client_once_connected", async () => {
    MongoClient.mockImplementation(() => fakeClient(async () => {}));
    const { getMongoDb } = loadConfig();

    await getMongoDb();
    await getMongoDb();

    expect(MongoClient).toHaveBeenCalledTimes(1);
  });
});
