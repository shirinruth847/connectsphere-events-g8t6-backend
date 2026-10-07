require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8000;
// Only the ConnectSphere frontend may call the API from a browser (Master 4.3).
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const routes = require("./routes/routers");
const errorHandler = require("./middleware/errorHandler");

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get('/', (req, res) => {
  res.send('Server is working!');
});

// Use your routes under "/api"
app.use("/api", routes);
app.use(errorHandler);

// Tests import the app without opening a port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

module.exports = app;
