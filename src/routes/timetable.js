const express = require('express');
const router = express.Router();
const timetableController = require('../controllers/timetableController');

// Example route: GET all timetables
router.get('/', timetableController.getAllTimetables);

// Example route: POST a timetable (upload file)
router.post('/upload', timetableController.uploadTimetable);

module.exports = router;
