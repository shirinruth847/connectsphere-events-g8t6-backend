const app = require("./app");

const PORT = process.env.PORT || 8000;

// Tests import the app without opening a port.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : PORT;
    console.log(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;
