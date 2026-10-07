require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const routes = require('./routes/routers');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

app.use(cors({ origin: frontendOrigin }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('Server is working!');
});

app.use('/api', routes);
app.use((req, res) => res.status(404).json({ message: 'Not found.' }));
app.use(errorHandler);

module.exports = app;