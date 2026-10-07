require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const routes = require("./routes/routers");
const errorHandler = require("./middleware/errorHandler");

const app = express();
// Only the ConnectSphere frontend may call the API from a browser (Master 4.3).
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

// Idempotent-Replayed tells the browser a create request was answered from a stored result.
app.use(cors({ origin: FRONTEND_ORIGIN, exposedHeaders: ["Idempotent-Replayed"] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("Server is working!");
});

app.use("/api", routes);
app.use((req, res) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" }));
app.use(errorHandler);

module.exports = app;
