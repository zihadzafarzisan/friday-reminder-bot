import { createRequire } from 'module';
import { resolveEventType } from '../utils/room.js';

const require = createRequire(import.meta.url);

const DAYS_ORDER = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

const DAY_MAP = {
  SUNDAY: 'SUNDAY', SUN: 'SUNDAY',
  MONDAY: 'MONDAY', MON: 'MONDAY',
  TUESDAY: 'TUESDAY', TUE: 'TUESDAY',
  WEDNESDAY: 'WEDNESDAY', WED: 'WEDNESDAY',
  THURSDAY: 'THURSDAY', THU: 'THURSDAY',
  FRIDAY: 'FRIDAY', FRI: 'FRIDAY',
  SATURDAY: 'SATURDAY', SAT: 'SATURDAY'
};

const DAY_CODE_MAP = {
  ST: ['SUNDAY', 'TUESDAY'],
  MW: ['MONDAY', 'WEDNESDAY'],
  RA: ['THURSDAY', 'SATURDAY'],
  SR: ['SUNDAY', 'THURSDAY'],
  TR: ['TUESDAY', 'THURSDAY'],
  UT: ['SUNDAY', 'TUESDAY']
};

/**
 * Normalizes 12h or 24h time strings to standard 24h 'HH:MM' (e.g. '10:00 AM' -> '10:00', '02:00 PM' -> '14:00')
 */
export function normalizeTimeTo24h(timeStr) {
  if (!timeStr) return '';
  const trimmed = String(timeStr).trim();
  const match12 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = match12[2];
    const meridiem = match12[3].toUpperCase();
    if (meridiem === 'PM' && h < 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match24) {
    const h = String(match24[1]).padStart(2, '0');
    const m = match24[2];
    return `${h}:${m}`;
  }
  return trimmed;
}

/**
 * Converts date and time strings into ISO-8601 string with Asia/Dhaka (+06:00) offset
 */
export function parseDateToIsoDhaka(dateStr, timeStr) {
  if (!dateStr) return null;
  const cleanDate = dateStr.trim();
  let year, month, day;

  // 1. YYYY-MM-DD
  const isoMatch = cleanDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    year = isoMatch[1];
    month = isoMatch[2].padStart(2, '0');
    day = isoMatch[3].padStart(2, '0');
  }

  // 2. DD-MM-YYYY
  const dmyMatch = cleanDate.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyMatch) {
    day = dmyMatch[1].padStart(2, '0');
    month = dmyMatch[2].padStart(2, '0');
    year = dmyMatch[3];
  }

  // 3. MonthName DD, YYYY or DayName, MonthName DD, YYYY
  const monthNames = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12'
  };

  const wordMatch = cleanDate.match(/(?:[a-zA-Z]+,?\s+)?([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (wordMatch) {
    const mStr = wordMatch[1].toLowerCase();
    if (monthNames[mStr]) {
      month = monthNames[mStr];
      day = wordMatch[2].padStart(2, '0');
      year = wordMatch[3];
    }
  }

  if (!year || !month || !day) return null;

  const normTime = normalizeTimeTo24h(timeStr) || '00:00';
  const [hh, mm] = normTime.split(':');
  return `${year}-${month}-${day}T${hh || '00'}:${mm || '00'}:00+06:00`;
}

/**
 * Extracts plain text from a PDF Buffer using pdf-parse (supports both v1 function and v2 class).
 */
export async function extractPdfText(bufferOrData) {
  if (typeof bufferOrData === 'string') {
    return bufferOrData;
  }

  let pdfModule;
  try {
    pdfModule = require('pdf-parse');
  } catch (err) {
    throw new Error(`Failed to load pdf-parse library: ${err.message}`);
  }

  if (typeof pdfModule === 'function') {
    const res = await pdfModule(bufferOrData);
    return res?.text || '';
  } else if (pdfModule?.PDFParse) {
    const parser = new pdfModule.PDFParse({ data: bufferOrData });
    try {
      const res = await parser.getText();
      return res?.text || '';
    } finally {
      if (typeof parser.destroy === 'function') {
        try { await parser.destroy(); } catch {}
      }
    }
  } else if (typeof pdfModule?.default === 'function') {
    const res = await pdfModule.default(bufferOrData);
    return res?.text || '';
  }

  throw new Error('Unsupported pdf-parse module format');
}

/**
 * Parses BRACU advising slip text into normalized schedule slots, events, and courses.
 */
export function parseBracuPdfText(text) {
  if (!text || typeof text !== 'string') {
    return { schedules: [], events: [], courses: [] };
  }

  // Normalize line endings and characters
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/[\u2013\u2014]/g, '-') // en-dash / em-dash to standard hyphen
    .replace(/[|]/g, ' ') // tables with pipe separators
    .replace(/\t+/g, '\n') // Split on tab stops
    .replace(/(?:\s{2,}|\t+)(?=(?:Midterm|Final|Mid\s*Exam|Final\s*Exam)\b)/gi, '\n'); // Split inline exam columns

  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

  const schedules = [];
  const events = [];
  const coursesMap = new Map();

  let currentCourseCode = null;
  let currentSection = '01';
  let currentFaculty = null;
  let currentRoom = 'TBA';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if line introduces a Course Code
    // e.g. "Course: CSE110 Section: 01" or "CSE110 01 Sunday..." or "HUM101 14"
    const explicitCourseMatch = line.match(/(?:Course(?:\s+Code)?[:\s]+)?\b([A-Z]{3,4}\s*\d{3}[A-Z]?)\b/i);
    const isKeyword = explicitCourseMatch && /^(?:MIDTERM|FINAL|EXAM|SL|TIME|ROOM|DATE|DAY|SECTION|SEC|COURSE|THEORY|LAB)/i.test(explicitCourseMatch[1]);

    if (explicitCourseMatch && !isKeyword) {
      const matchedCode = explicitCourseMatch[1].replace(/\s+/g, '').toUpperCase();
      if (/^[A-Z]{3,4}\d{3}[A-Z]?$/.test(matchedCode)) {
        currentCourseCode = matchedCode;
        currentSection = '01';
        currentRoom = 'TBA';

        // Check if section is specified in this line
        const secMatch = line.match(/(?:Sec(?:tion)?[:\s]*|\[|\b(?:Sec|Section)\b\s*)(\d{1,3})\b/i);
        if (secMatch) {
          currentSection = secMatch[1].padStart(2, '0');
        } else {
          // If the word immediately following course code is 1-3 digits
          const afterCodeMatch = line.match(new RegExp(matchedCode + '[\\s,:]+(\\d{1,3})\\b', 'i'));
          if (afterCodeMatch) {
            currentSection = afterCodeMatch[1].padStart(2, '0');
          }
        }

        // Check faculty
        const facMatch = line.match(/(?:Faculty|Instructor)[:\s]*([A-Z]{3,4})\b/i);
        if (facMatch) {
          currentFaculty = facMatch[1].toUpperCase();
        }

        // Extract room if present in the course header line
        const headerRoomMatch = line.match(/\b(\d{2}[A-Z]-\d{2}[A-Z]|UB\s*\d{3,4})\b/i);
        if (headerRoomMatch) {
          currentRoom = headerRoomMatch[1].replace(/\s+/g, '').toUpperCase();
        }

        if (!coursesMap.has(currentCourseCode)) {
          coursesMap.set(currentCourseCode, {
            code: currentCourseCode,
            section: currentSection,
            faculty: currentFaculty,
            room: currentRoom
          });
        }
      }
    }

    if (!currentCourseCode) continue;

    // 1. Detect Class Routine slot in this line
    const timeMatch = line.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
    const isExamLine = /\b(?:MIDTERM|FINAL|MID\s*EXAM|FINAL\s*EXAM)\b/i.test(line);

    if (timeMatch && !isExamLine) {
      const rawStart = timeMatch[1];
      const rawEnd = timeMatch[2];
      const startTime = normalizeTimeTo24h(rawStart);
      const endTime = normalizeTimeTo24h(rawEnd);

      // Extract room
      let room = currentRoom || 'TBA';
      const roomMatch = line.match(/\b(\d{2}[A-Z]-\d{2}[A-Z]|UB\s*\d{3,4}|TBA)\b/i);
      if (roomMatch) {
        room = roomMatch[1].replace(/\s+/g, '').toUpperCase();
      } else {
        const altRoomMatch = line.match(/(?:Room|Rm)[:\s]*([A-Za-z0-9\-]+)/i);
        if (altRoomMatch) {
          room = altRoomMatch[1].trim().toUpperCase();
        }
      }

      // Update room in coursesMap if found
      if (room && room !== 'TBA' && coursesMap.has(currentCourseCode)) {
        coursesMap.get(currentCourseCode).room = room;
      }

      // Extract days
      const daysFound = [];

      // Check full / 3-letter day names
      for (const [key, fullDay] of Object.entries(DAY_MAP)) {
        const regex = new RegExp(`\\b${key}\\b`, 'i');
        if (regex.test(line)) {
          if (!daysFound.includes(fullDay)) {
            daysFound.push(fullDay);
          }
        }
      }

      // Check day codes like ST, MW, RA
      if (daysFound.length === 0) {
        for (const [code, pairDays] of Object.entries(DAY_CODE_MAP)) {
          const regex = new RegExp(`\\b${code}\\b`, 'i');
          if (regex.test(line)) {
            for (const d of pairDays) {
              if (!daysFound.includes(d)) daysFound.push(d);
            }
          }
        }
      }

      // For each day found, push a routine slot
      for (const day of daysFound) {
        const eventType = resolveEventType(room, currentCourseCode);
        schedules.push({
          course_code: currentCourseCode,
          section: currentSection,
          day_of_week: day,
          start_time: startTime,
          end_time: endTime,
          room,
          event_type: eventType
        });
      }
    }

    // 2. Detect Midterm or Final Exam
    if (isExamLine) {
      const examType = /\b(?:MIDTERM|MID\s*EXAM)\b/i.test(line) ? 'MIDTERM' : 'FINAL';
      const examTimeMatch = line.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
      
      // Look for date in line: YYYY-MM-DD or Month DD, YYYY or DD-MM-YYYY
      const dateMatch = line.match(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{4}|(?:[a-zA-Z]+,?\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i);

      if (dateMatch && examTimeMatch) {
        const rawDate = dateMatch[1];
        const rawStartTime = examTimeMatch[1];
        const rawEndTime = examTimeMatch[2];

        const startIso = parseDateToIsoDhaka(rawDate, rawStartTime);
        const endIso = parseDateToIsoDhaka(rawDate, rawEndTime);

        let examRoom = currentRoom || 'TBA';
        const examRoomMatch = line.match(/\b(\d{2}[A-Z]-\d{2}[A-Z]|UB\s*\d{3,4})\b/i);
        if (examRoomMatch) {
          examRoom = examRoomMatch[1].replace(/\s+/g, '').toUpperCase();
        }

        if (startIso && endIso) {
          events.push({
            course_code: currentCourseCode,
            type: examType,
            title: `${currentCourseCode} ${examType === 'MIDTERM' ? 'Midterm Exam' : 'Final Exam'}`,
            start_time: startIso,
            end_time: endIso,
            room: examRoom,
            is_custom: 0
          });
        }
      }
    }
  }

  return {
    schedules,
    events,
    courses: Array.from(coursesMap.values())
  };
}

/**
 * Main routine PDF parser for BRACU advising slips & routines.
 * Takes a Buffer or text string and returns parsed schedules, exams, and courses.
 */
export async function parseBracuPdf(bufferOrText) {
  const text = await extractPdfText(bufferOrText);
  const parsed = parseBracuPdfText(text);
  return {
    ...parsed,
    rawText: text
  };
}
