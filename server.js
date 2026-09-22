require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8000;
const routes = require("./routes/routers");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get('/', (req, res) => {
  res.send('Server is working!');
});

// Use your routes under "/api"
app.use("/api", routes);
app.use('/api/events', require('./routes/eventRoutes'));

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
