const app = require("./app");
const { startEventReminderJob } = require("./jobs/eventReminderJob");

const PORT = process.env.PORT || 8000;

// Tests import the app without opening a port or starting background jobs.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`Server is running on http://localhost:${port}`);
  });
  const stopEventReminderJob = startEventReminderJob();

  // Stop scheduling new job runs, then let open requests finish before exiting.
  const shutDown = () => {
    if (stopEventReminderJob) stopEventReminderJob();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutDown);
  process.once("SIGINT", shutDown);
}

module.exports = app;
