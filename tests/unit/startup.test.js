const { spawn } = require("child_process");
const path = require("path");

jest.setTimeout(15000);

test("[EVT-START-001] should_start_and_return_json_errors_when_routes_are_missing_or_the_database_fails", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "server.js")], {
    env: {
      ...process.env,
      PORT: "0",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_ANON_KEY: "startup-smoke-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";

  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString();
  });

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start: ${errorOutput}`)), 10000);
      child.stdout.on("data", (chunk) => {
        const match = `${output}${chunk.toString()}`.match(/localhost:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited with code ${code}: ${errorOutput}`));
      });
    });

    const missingRoute = await fetch(`http://127.0.0.1:${port}/api/not-a-route`);
    expect(missingRoute.status).toBe(404);
    expect(await missingRoute.json()).toEqual({ error: "Not found.", code: "NOT_FOUND" });

    const eventRoute = await fetch(`http://127.0.0.1:${port}/api/events/mine`);
    expect(eventRoute.status).toBe(401);
    expect(await eventRoute.json()).toEqual({ error: "Please log in to continue.", code: "UNAUTHENTICATED" });

    const databaseFailure = await fetch(`http://127.0.0.1:${port}/api/healthcheck`);
    expect(databaseFailure.status).toBe(500);
    expect(await databaseFailure.json()).toEqual({
      error: "Internal Server Error",
      code: "INTERNAL_ERROR",
    });
    expect(errorOutput).not.toContain("startup-smoke-test-key");
  } finally {
    child.kill();
  }
});