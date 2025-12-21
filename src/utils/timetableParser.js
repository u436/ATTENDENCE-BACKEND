const Tesseract = require('tesseract.js');

const DAY_NAMES = [
  'monday', 'mon',
  'tuesday', 'tue', 'tues',
  'wednesday', 'wed',
  'thursday', 'thu', 'thur', 'thurs',
  'friday', 'fri',
  'saturday', 'sat',
  'sunday', 'sun',
];

// Simple date detectors
const DATE_REGEXES = [
  /\b\d{4}-\d{2}-\d{2}\b/,          // 2024-05-21
  /\b\d{2}[\/.-]\d{2}[\/.-]\d{4}\b/, // 21/05/2024 or 21-05-2024
  /\b\d{2}[\/.-]\d{2}[\/.-]\d{2}\b/,   // 21/05/24
];

// Parse timetable image with OCR
const parseTimetable = async (filePath, day) => {
  try {
    const result = await Tesseract.recognize(filePath, 'eng', {
      logger: (m) => console.log(m),
    });

    const text = result.data.text || '';
    console.log('OCR Text:', text);

    const lower = text.toLowerCase();
    const normalizedRequestedDay = normalizeDay((day || '').trim());
    const detectedDays = uniqueDayListFromWords(result, lower);
    const detectedDate = DATE_REGEXES.map((r) => (text.match(r) || [null])[0]).find(Boolean) || null;
    
    console.log('Detected days:', detectedDays);
    console.log('Requested day (normalized):', normalizedRequestedDay);
    console.log('Full OCR text for day detection:', lower);

    // Prefer layout-aware extraction using bounding boxes (column-based)
    const layoutExtraction = extractByLayout(result, normalizedRequestedDay);
    const layoutFoundHeader = !!layoutExtraction.foundHeader;

    let timetable = layoutExtraction.timetable || [];
    let subjects = layoutExtraction.subjects || [];
    let extractionMode = layoutFoundHeader ? 'column' : '';

    // Fallback: row-based layout (days listed per row)
    if (normalizedRequestedDay && timetable.length === 0) {
      const rowExtraction = extractByRowLayout(result, normalizedRequestedDay);
      if (rowExtraction.timetable.length > 0) {
        timetable = rowExtraction.timetable;
        subjects = rowExtraction.subjects;
        extractionMode = 'row';
      }
    }

    // Last-resort text-only fallback if the requested day is present in text but both layout modes failed
    if (normalizedRequestedDay && timetable.length === 0 && detectedDays.includes(normalizedRequestedDay)) {
      const textOnly = extractTimetableData(text, normalizedRequestedDay);
      if (textOnly.timetable.length > 0) {
        timetable = textOnly.timetable;
        subjects = textOnly.subjects;
        extractionMode = 'text';
      }
    }

    // If a specific day is requested but not detected anywhere in the image text, treat as holiday immediately
    if (normalizedRequestedDay && !detectedDays.includes(normalizedRequestedDay)) {
      return {
        timetable: [],
        subjects: [],
        holiday: true,
        message: `No classes for ${day}. Detected days: ${dedupeFullDays(detectedDays).join(', ')}`,
        detectedDays: dedupeFullDays(detectedDays),
        detectedDaysCount: dedupeFullDays(detectedDays).length,
        detectedDate,
      };
    }

    // If no rows were extracted for the requested day and we did not detect that day name, treat as holiday
    if (normalizedRequestedDay && timetable.length === 0 && !detectedDays.includes(normalizedRequestedDay)) {
      return {
        timetable: [],
        subjects: [],
        holiday: true,
        message: `No classes for ${day} in uploaded timetable`,
        detectedDays: dedupeFullDays(detectedDays),
        detectedDaysCount: dedupeFullDays(detectedDays).length,
        detectedDate,
      };
    }

    // If we could not find a day header/column and the requested day was not detected anywhere, do NOT fall back to text-only rows: mark holiday.
    if (normalizedRequestedDay && !layoutFoundHeader && !detectedDays.includes(normalizedRequestedDay)) {
      return {
        timetable: [],
        subjects: [],
        holiday: true,
        message: `No classes for ${day} in uploaded timetable`,
        detectedDays: dedupeFullDays(detectedDays),
        detectedDaysCount: dedupeFullDays(detectedDays).length,
        detectedDate,
      };
    }

    return {
      timetable,
      subjects,
      holiday: false,
      detectedDays: dedupeFullDays(detectedDays),
      detectedDaysCount: dedupeFullDays(detectedDays).length,
      detectedDate,
      extractionMode,
    };
  } catch (error) {
    console.error('OCR Error:', error);
    return {
      error: 'Failed to parse timetable',
      message: error.message,
      timetable: [],
      subjects: [],
      holiday: true,
    };
  }
};

// Extract structured data from OCR text (text-only fallback)
function extractTimetableData(text, day) {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const timetable = [];
  let sno = 1;

  const timePattern = buildTimeRangeRegex();
  const roomPattern = /\b\d{3,4}\b/; // simple room number pattern
  const requested = normalizeDay(day || '');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();
    if (requested) {
      // Skip lines that mention other day names to avoid mixing columns when layout failed
      const otherDayPresent = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
        .filter(d => d !== requested)
        .some(d => lowerLine.includes(d));
      if (otherDayPresent) continue;
    }
    const timeMatches = [...line.matchAll(timePattern)];
    if (timeMatches.length === 0) continue;

    const timeMatch = timeMatches[0];
    const { timeLabel } = normalizeTimeMatch(timeMatch);

    const timePart = timeMatch[0];
    let subject = line.replace(timePart, '').trim();

    // Clean up subject (remove room numbers, parentheses, extra separators)
    subject = subject.replace(roomPattern, ' ').trim();
    subject = subject.replace(/\([^)]*\)/g, ' ').trim();
    subject = subject.split(/[\t,;\-|]/)[0].trim();
    subject = subject.replace(/\b(a\.?m\.?|p\.?m\.?)\b/gi, ' ');
    subject = subject.replace(/[^A-Za-z+&\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Reject noisy/gibberish subjects
    const lowerSubj = subject.toLowerCase();
    const normalized = lowerSubj.replace(/\s+/g, '');
    const noiseWords = ['period', 'time', 'duration', 'day', 'date', 'am', 'pm', 'name', ...DAY_NAMES];
    const hasLetters = /[a-zA-Z]{3,}/.test(subject); // require at least 3 letters
    const isPureAmPm = /^(am|pm|ampm|a m|p m|am pm|pm am)$/i.test(normalized);
    if (!hasLetters) continue;
    if (subject.length < 3) continue;
    if (noiseWords.includes(lowerSubj)) continue;
    if (isPureAmPm) continue;

    if (subject.length > 1) {
      timetable.push({
        sno: sno++,
        subject,
        time: timeLabel,
        status: ''
      });
    }
  }

  // Collect unique subjects for display/analysis
  const subjects = Array.from(new Set(timetable.map((t) => t.subject))).filter(Boolean);

  return { timetable, subjects };
}

// Layout-aware extraction using OCR word bounding boxes
function extractByLayout(result, requestedDay) {
  const words = Array.isArray(result?.data?.words) ? result.data.words : [];
  const lines = Array.isArray(result?.data?.lines) ? result.data.lines : [];
  if (!words.length && !lines.length) return { timetable: [], subjects: [], foundHeader: false };

  // Find day header words and their bounding boxes
  const dayWords = words.filter((w) => {
    const txt = (w.text || '').toLowerCase().replace(/[^a-z]/g, '');
    return DAY_NAMES.includes(txt);
  });

  if (!dayWords.length) return { timetable: [], subjects: [], foundHeader: false };

  // Determine the header row (top-most band of day names) with adaptive tolerance
  const minY = Math.min(...dayWords.map(w => w.bbox?.y0 ?? Infinity));
  const headerHeights = dayWords.map(w => (w.bbox?.y1 ?? 0) - (w.bbox?.y0 ?? 0)).filter(Boolean);
  const avgHeaderH = headerHeights.length ? headerHeights.reduce((a,b)=>a+b,0) / headerHeights.length : 20;
  const bandTol = Math.max(60, avgHeaderH * 3);
  const headerBand = dayWords.filter(w => (w.bbox?.y0 ?? Infinity) - minY <= bandTol && w.bbox);
  // Sort by x center
  let headersSorted = headerBand.map(w => ({
    day: normalizeDay(w.text),
    bbox: w.bbox,
    xCenter: (w.bbox.x0 + w.bbox.x1) / 2,
  })).filter(h => !!h.day).sort((a,b) => a.xCenter - b.xCenter);
  if (!headersSorted.length) {
    headersSorted = dayWords.map(w => ({
      day: normalizeDay(w.text),
      bbox: w.bbox,
      xCenter: (w.bbox.x0 + w.bbox.x1) / 2,
    })).filter(h=>!!h.day).sort((a,b)=>a.xCenter-b.xCenter);
  }

  let headerIdx = headersSorted.findIndex(h => h.day === requestedDay);
  if (headerIdx === -1) {
    // If not in header band, try any occurrence of the requested day and rebuild neighbor list around it
    const anyDayOcc = dayWords.filter(w => normalizeDay(w.text) === requestedDay && w.bbox);
    if (anyDayOcc.length) {
      const chosen = anyDayOcc.reduce((best, w) => {
        if (!best) return w;
        return (w.bbox.y0 < best.bbox.y0) ? w : best;
      }, null);
      const bandY0 = chosen.bbox.y0;
      const altBand = dayWords.filter(w => w.bbox && Math.abs((w.bbox.y0 ?? 0) - bandY0) <= Math.max(80, avgHeaderH * 3));
      headersSorted = altBand.map(w => ({
        day: normalizeDay(w.text),
        bbox: w.bbox,
        xCenter: (w.bbox.x0 + w.bbox.x1) / 2,
      })).filter(h=>!!h.day).sort((a,b)=>a.xCenter-b.xCenter);
      headerIdx = headersSorted.findIndex(h => h.day === requestedDay);
    }
  }
  if (headerIdx === -1) return { timetable: [], subjects: [], foundHeader: false };

  const header = headersSorted[headerIdx];
  const prev = headersSorted[headerIdx - 1] || null;
  const next = headersSorted[headerIdx + 1] || null;
  const headerWidth = header.bbox.x1 - header.bbox.x0;
  let leftBoundary = prev ? (prev.xCenter + header.xCenter) / 2 : Math.max(0, header.bbox.x0 - headerWidth * 0.8);
  let rightBoundary = next ? (header.xCenter + next.xCenter) / 2 : header.bbox.x1 + headerWidth * 0.8;
  const headerBottomY = header.bbox.y1;

  // Group words below header within the column into line-like buckets by y
  const colWords = words.filter((w) => {
    if (!w?.bbox) return false;
    const xCenter = (w.bbox.x0 + w.bbox.x1) / 2;
    const inColumn = xCenter >= leftBoundary && xCenter <= rightBoundary;
    const belowHeader = w.bbox.y0 >= headerBottomY + 2;
    return inColumn && belowHeader;
  }).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  // Bucket by row using y proximity
  const rows = [];
  const rowTolerance = 18; // pixels tolerance; heuristic
  for (const w of colWords) {
    const txt = (w.text || '').trim();
    if (!txt) continue;
    let placed = false;
    for (const row of rows) {
      const last = row[row.length - 1];
      if (Math.abs(w.bbox.y0 - last.bbox.y0) <= rowTolerance) {
        row.push(w);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([w]);
  }

  // Merge adjacent rows that belong to the same cell (e.g., "Social" + "Studies") using bbox overlap
  const mergedRows = [];
  const hasTimeInText = (txt) => ((txt || '').match(buildTimeRangeRegex()) || []).length > 0;
  const getSpan = (row) => {
    const x0 = Math.min(...row.map(w => w.bbox.x0));
    const x1 = Math.max(...row.map(w => w.bbox.x1));
    const y0 = Math.min(...row.map(w => w.bbox.y0));
    const y1 = Math.max(...row.map(w => w.bbox.y1));
    const text = row.map(w=>w.text).join(' ').trim();
    return { x0, x1, y0, y1, text };
  };

  for (let i = 0; i < rows.length; i++) {
    let curr = rows[i];
    let currSpan = getSpan(curr);
    const currShort = currSpan.text.length <= 20 && !hasTimeInText(currSpan.text);

    if (currShort) {
      // Merge chain of following short rows with high x-overlap and small y gap
      while (i + 1 < rows.length) {
        const next = rows[i + 1];
        const nextSpan = getSpan(next);
        const yGap = Math.abs(nextSpan.y0 - currSpan.y1);
        const xOverlap = Math.max(0, Math.min(currSpan.x1, nextSpan.x1) - Math.max(currSpan.x0, nextSpan.x0));
        const xUnion = Math.max(currSpan.x1, nextSpan.x1) - Math.min(currSpan.x0, nextSpan.x0);
        const overlapRatio = xUnion > 0 ? (xOverlap / xUnion) : 0;
        const nextShort = nextSpan.text.length <= 20 && !hasTimeInText(nextSpan.text);
        if (nextShort && yGap <= rowTolerance * 2 && overlapRatio >= 0.5) {
          curr = [...curr, ...next];
          currSpan = getSpan(curr);
          i++;
        } else {
          break;
        }
      }
    }
    mergedRows.push(curr);
  }

  // Build lines and parse time + subject
  const timePattern = buildTimeRangeRegex();
  const roomPattern = /\b\d{3,4}\b/;
  const timetable = [];
  let sno = 1;

  for (const row of mergedRows) {
    const lineTextCol = row.map((w) => w.text).join(' ').trim();
    if (!lineTextCol) continue;
    // Find corresponding words across full row by y-overlap to detect time anywhere in the row
    const rowY0 = Math.min(...row.map(w => w.bbox.y0));
    const rowY1 = Math.max(...row.map(w => w.bbox.y1));
    const allRowWords = words.filter(w => w?.bbox && !(row.indexOf(w) >= 0) && overlapY(w.bbox.y0, w.bbox.y1, rowY0, rowY1, 16));
    const lineTextAll = [...row, ...allRowWords].sort((a,b)=>a.bbox.x0-b.bbox.x0).map(w=>w.text).join(' ').trim();
    const timeMatches = [...lineTextAll.matchAll(timePattern)];
    const timeLabel = timeMatches.length ? normalizeTimeMatch(timeMatches[0]).timeLabel : '';
    let subject = lineTextCol;
    if (timeMatches.length) subject = subject.replace(timeMatches[0][0], '').trim();
    subject = subject.replace(roomPattern, ' ').trim();
    subject = subject.replace(/\([^)]*\)/g, ' ').trim();
    subject = subject.replace(/\b(a\.?m\.?|p\.?m\.?)\b/gi, ' ');
    subject = subject.replace(/[^A-Za-z+&\s]/g, ' ').replace(/\s+/g, ' ').trim();

    const lowerSubj = subject.toLowerCase();
    const normalized = lowerSubj.replace(/\s+/g, '');
    const noiseWords = ['period', 'time', 'duration', 'day', 'date', 'am', 'pm', 'name', ...DAY_NAMES];
    const hasLetters = /[a-zA-Z]{3,}/.test(subject);
    const isPureAmPm = /^(am|pm|ampm|a m|p m|am pm|pm am)$/i.test(normalized);
    if (!hasLetters || subject.length < 3 || noiseWords.includes(lowerSubj) || isPureAmPm) continue;

    timetable.push({ sno: sno++, subject, time: timeLabel, status: '' });
  }

  const subjects = Array.from(new Set(timetable.map((t) => t.subject))).filter(Boolean);
  // If column extraction failed to find rows, attempt a widened boundary retry
  if (!timetable.length) {
    const widenFactor = headerWidth || 40;
    const altLeft = Math.max(0, leftBoundary - widenFactor);
    const altRight = rightBoundary + widenFactor;
    const colWordsWide = words.filter((w) => {
      if (!w?.bbox) return false;
      const xCenter = (w.bbox.x0 + w.bbox.x1) / 2;
      const inColumn = xCenter >= altLeft && xCenter <= altRight;
      const belowHeader = w.bbox.y0 >= headerBottomY + 2;
      return inColumn && belowHeader;
    }).sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

    const rowsWide = [];
    for (const w of colWordsWide) {
      if (!rowsWide.length) {
        rowsWide.push([w]);
        continue;
      }
      const lastRow = rowsWide[rowsWide.length - 1];
      if (Math.abs(w.bbox.y0 - lastRow[lastRow.length - 1].bbox.y0) <= rowTolerance) {
        lastRow.push(w);
      } else {
        rowsWide.push([w]);
      }
    }

    let sno2 = 1;
    for (const row of rowsWide) {
      const lineTextCol = row.map((w) => w.text).join(' ').trim();
      if (!lineTextCol) continue;
      const rowY0 = Math.min(...row.map(w => w.bbox.y0));
      const rowY1 = Math.max(...row.map(w => w.bbox.y1));
      const allRowWords = words.filter(w => w?.bbox && !(row.indexOf(w) >= 0) && overlapY(w.bbox.y0, w.bbox.y1, rowY0, rowY1, 16));
      const lineTextAll = [...row, ...allRowWords].sort((a,b)=>a.bbox.x0-b.bbox.x0).map(w=>w.text).join(' ').trim();
      const timeMatches = [...lineTextAll.matchAll(timePattern)];
      const timeLabel = timeMatches.length ? normalizeTimeMatch(timeMatches[0]).timeLabel : '';
      let subject = lineTextCol;
      if (timeMatches.length) subject = subject.replace(timeMatches[0][0], '').trim();
      subject = subject.replace(roomPattern, ' ').trim();
      subject = subject.replace(/\([^)]*\)/g, ' ').trim();
      subject = subject.split(/[\t,;\-|]/)[0].trim();
      subject = subject.replace(/\b(a\.?m\.?|p\.?m\.?)\b/gi, ' ');
      subject = subject.replace(/[^A-Za-z+&\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const lowerSubj = subject.toLowerCase();
      const normalized = lowerSubj.replace(/\s+/g, '');
      const noiseWords = ['period', 'time', 'duration', 'day', 'date', 'am', 'pm', 'name', ...DAY_NAMES];
      const hasLetters = /[a-zA-Z]{3,}/.test(subject);
      const isPureAmPm = /^(am|pm|ampm|a m|p m|am pm|pm am)$/i.test(normalized);
      if (!hasLetters || subject.length < 3 || noiseWords.includes(lowerSubj) || isPureAmPm) continue;
      timetable.push({ sno: sno2++, subject, time: timeLabel, status: '' });
    }
  }

  return { timetable, subjects: Array.from(new Set(timetable.map(t=>t.subject))).filter(Boolean), foundHeader: true };
}

// Row-based layout: find the row that contains the requested day and split by time segments
function extractByRowLayout(result, requestedDay) {
  const words = Array.isArray(result?.data?.words) ? result.data.words : [];
  if (!words.length) return { timetable: [], subjects: [] };

  // Group words into rows by y proximity
  const sorted = words.filter(w=>w?.bbox).sort((a,b)=> a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows = [];
  const tolY = 12;
  for (const w of sorted) {
    const txt = (w.text || '').trim();
    if (!txt) continue;
    let placed = false;
    for (const row of rows) {
      const last = row[row.length - 1];
      if (Math.abs((w.bbox?.y0 ?? 0) - (last.bbox?.y0 ?? 0)) <= tolY) {
        row.push(w);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([w]);
  }

  const normalized = normalizeDay(requestedDay || '');
  const timePattern = buildTimeRangeRegex();
  const roomPattern = /\b\d{3,4}\b/;
  const timetable = [];
  let sno = 1;

  for (const row of rows) {
    const rowText = row.map(w=>w.text).join(' ').toLowerCase();
    if (!rowText.includes(normalized)) continue;
    // Build full row text
    const lineText = row.map(w=>w.text).join(' ').trim();
    const matches = [...lineText.matchAll(timePattern)];
    if (matches.length === 0) {
      // No explicit times, treat entire row as one subject block
      let subject = lineText.replace(new RegExp(normalized, 'i'), ' ').trim();
      subject = subject.replace(roomPattern, ' ').replace(/\([^)]*\)/g, ' ').replace(/\b(a\.?m\.?|p\.?m\.?)\b/gi, ' ');
      subject = subject.replace(/[^A-Za-z+&\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (subject && /[a-zA-Z]{3,}/.test(subject)) {
        timetable.push({ sno: sno++, subject, time: '', status: '' });
      }
      break; // Use the first matching row only
    }
    // Split by time segments: subject text between matches
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const { timeLabel } = normalizeTimeMatch(m);
      const startIdx = m.index + m[0].length;
      const endIdx = i + 1 < matches.length ? matches[i+1].index : lineText.length;
      let subject = lineText.substring(startIdx, endIdx).trim();
      subject = subject.replace(roomPattern, ' ').replace(/\([^)]*\)/g, ' ').replace(/\b(a\.?m\.?|p\.?m\.?)\b/gi, ' ');
      subject = subject.replace(/[^A-Za-z+&\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const lowerSubj = subject.toLowerCase();
      const normalizedNoSpace = lowerSubj.replace(/\s+/g, '');
      const noiseWords = ['period', 'time', 'duration', 'day', 'date', 'am', 'pm', 'name'];
      const hasLetters = /[a-zA-Z]{3,}/.test(subject);
      const isPureAmPm = /^(am|pm|ampm|a m|p m|am pm|pm am)$/i.test(normalizedNoSpace);
      if (!hasLetters || subject.length < 3 || noiseWords.includes(lowerSubj) || isPureAmPm) continue;
      timetable.push({ sno: sno++, subject, time: timeLabel, status: '' });
    }

    break; // Only use the first matching row
  }

  const subjects = Array.from(new Set(timetable.map(t=>t.subject))).filter(Boolean);
  return { timetable, subjects };
}

function buildTimeRangeRegex() {
  // Matches: 9:00 - 10:00, 09:00 AM - 10:00 PM, 9.00–10.00, etc.
  return /(\d{1,2})[:\.](\d{2})\s*(?:am|pm|a\.?m\.?|p\.?m\.?)?\s*[-–—]\s*(\d{1,2})[:\.](\d{2})\s*(?:am|pm|a\.?m\.?|p\.?m\.?)?/gi;
}

function normalizeTimeMatch(m) {
  const startHour = parseInt(m[1]);
  const startMin = m[2];
  const endHour = parseInt(m[3]);
  const endMin = m[4];
  const timeLabel = `${startHour}:${startMin} - ${endHour}:${endMin}`;
  return { timeLabel };
}

function normalizeDay(d) {
  const t = (d || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return '';
  if (['mon', 'monday'].includes(t)) return 'monday';
  if (['tue', 'tues', 'tuesday'].includes(t)) return 'tuesday';
  if (['wed', 'wednesday'].includes(t)) return 'wednesday';
  if (['thu', 'thur', 'thurs', 'thursday'].includes(t)) return 'thursday';
  if (['fri', 'friday'].includes(t)) return 'friday';
  if (['sat', 'saturday'].includes(t)) return 'saturday';
  if (['sun', 'sunday'].includes(t)) return 'sunday';
  return t; // fallback
}

function overlapY(a0,a1,b0,b1, tol=0){
  const top = Math.max(a0, b0 - tol);
  const bot = Math.min(a1, b1 + tol);
  return bot >= top;
}

function uniqueDayListFromWords(result, lowerText) {
  const words = Array.isArray(result?.data?.words) ? result.data.words : [];
  const list = [];
  
  // Check OCR word objects
  for (const w of words) {
    const full = normalizeDay(w.text);
    if (full && ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].includes(full)) {
      list.push(full);
    }
  }
  
  // Lenient patterns to catch OCR errors and variations
  const dayPatterns = [
    // Full names with OCR error tolerance (allow 1-2 char differences)
    { re: /m[o0]nday|m[o0]nd[a@]y|m[o0][nm]day/gi, day: 'monday' },
    { re: /tu[e3]sday|tu[e3]sd[a@]y|t[uv][e3]sday/gi, day: 'tuesday' },
    { re: /w[e3]dn[e3]sday|w[e3]dn[e3]sd[a@]y|wedn[e3]sday/gi, day: 'wednesday' },
    { re: /thursday|thursd[a@]y|th[uv]rsday/gi, day: 'thursday' },
    { re: /friday|frid[a@]y|fr[i1l]day|fr[i1]d[a@]y/gi, day: 'friday' },
    { re: /saturday|saturd[a@]y|s[a@]turday/gi, day: 'saturday' },
    { re: /sunday|sund[a@]y|s[uv]nday/gi, day: 'sunday' },
    // Common abbreviations
    { re: /\bm[o0]n\b/gi, day: 'monday' },
    { re: /\btu[e3]\b/gi, day: 'tuesday' },
    { re: /\btu[e3]s\b/gi, day: 'tuesday' },
    { re: /\bw[e3]d\b/gi, day: 'wednesday' },
    { re: /\bth[uv]\b/gi, day: 'thursday' },
    { re: /\bthur\b/gi, day: 'thursday' },
    { re: /\bthurs\b/gi, day: 'thursday' },
    { re: /\bfr[i1l]\b/gi, day: 'friday' },
    { re: /\bs[a@]t\b/gi, day: 'saturday' },
    { re: /\bs[uv]n\b/gi, day: 'sunday' },
  ];
  
  dayPatterns.forEach(({ re, day }) => {
    if (re.test(lowerText)) {
      console.log(`  Pattern matched: ${re} -> ${day}`);
      list.push(day);
    }
  });
  
  console.log('Final detected day list before deduplication:', list);
  return dedupeFullDays(list);
}

function dedupeFullDays(arr) {
  const order = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  const set = new Set();
  for (const a of arr) {
    const n = normalizeDay(a);
    if (order.includes(n)) set.add(n);
  }
  return Array.from(set);
}

module.exports = { parseTimetable };
