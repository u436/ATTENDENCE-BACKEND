const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const timetableRoutes = require('./src/routes/timetable');
const pushRoutes = require('./src/routes/push');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/timetable', timetableRoutes);
app.use('/api/push', pushRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Backend is running!' });
});

// Root route
app.get('/', (req, res) => {
  res.send('Backend running successfully');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
