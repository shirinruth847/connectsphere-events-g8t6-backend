const { Pool } = require("pg");

require("dotenv").config();

// Least-privilege PostgreSQL connection for venue calendar writes (Master 2.7.2,
// 4.3, 7.4, T33). supabase-js cannot hold a transaction across a MongoDB call,
// so the venue lock is taken and held on one client from this pool. Every other
// business read and write stays on config/supabase.js.
const POOL_MAX = 5;
const CONNECTION_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30000;

let pool;

const getVenueLockPool = () => {
  const connectionString = process.env.VENUE_LOCK_DATABASE_URL;
  if (!connectionString) {
    const error = new Error("The venue lock database connection is not configured.");
    error.code = "VENUE_LOCK_NOT_CONFIGURED";
    throw error;
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      application_name: "connectsphere-venue-lock",
    });
    // An idle client dropped by the pooler must not crash the process; the next
    // checkout opens a new connection. Never log the connection string.
    pool.on("error", (error) => console.error("[venue-lock-db] idle client error", { code: error.code }));
  }
  return pool;
};

// Lets tests and scripts end the process cleanly.
const closeVenueLockPool = async () => {
  if (!pool) return;
  const pending = pool;
  pool = undefined;
  await pending.end();
};

module.exports = { getVenueLockPool, closeVenueLockPool };
