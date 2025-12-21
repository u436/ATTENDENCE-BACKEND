const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parseTimetable } = require('../utils/timetableParser');

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '_');
    cb(null, uniqueName);
  }
});

// Filter for image files only
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG and PNG images are allowed'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Dummy in-memory timetables array (organized by date-day)
let timetables = {};

// GET all timetables
const getAllTimetables = (req, res) => {
  res.status(200).json({ timetables });
};

// POST/upload timetable
const uploadTimetable = [
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { date, day } = req.body;
      
      if (!date || !day) {
        return res.status(400).json({ error: "Date and day are required" });
      }

      const fileData = {
        filename: req.file.filename,
        path: req.file.path,
        uploadedAt: new Date()
      };

      console.log(`Processing timetable for ${day} (${date})`);
      
      // Parse the timetable using OCR
      const { timetable, subjects, holiday, message, detectedDays, detectedDaysCount, detectedDate } = await parseTimetable(req.file.path, day);
      
      // Store by date-day key
      const key = `${date}-${day}`;
      timetables[key] = {
        date,
        day,
        file: fileData,
        schedule: timetable,
        subjects,
        holiday: !!holiday,
        message,
        detectedDays,
        detectedDaysCount,
        detectedDate,
      };

      res.status(200).json({ 
        message: message || "File uploaded and processed successfully", 
        file: fileData,
        timetable,
        subjects,
        date,
        day,
        holiday: !!holiday,
        detectedDays,
        detectedDaysCount,
        detectedDate,
      });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ 
        error: "Failed to process timetable",
        message: error.message 
      });
    }
  }
];

module.exports = {
  getAllTimetables,
  uploadTimetable
};
