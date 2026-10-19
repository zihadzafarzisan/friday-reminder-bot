import { createRequire } from 'module';
import { resolveEventType, classifyClassEvent } from '../utils/room.js';

const require = createRequire(import.meta.url);

export { resolveEventType, classifyClassEvent };

export const DAYS_ORDER = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

export const DAY_MAP = {
  SUNDAY: 'SUNDAY', SUN: 'SUNDAY',
  MONDAY: 'MONDAY', MON: 'MONDAY',
  TUESDAY: 'TUESDAY', TUE: 'TUESDAY',
  WEDNESDAY: 'WEDNESDAY', WED: 'WEDNESDAY',
  THURSDAY: 'THURSDAY', THU: 'THURSDAY',
  FRIDAY: 'FRIDAY', FRI: 'FRIDAY',
  SATURDAY: 'SATURDAY', SAT: 'SATURDAY'
};

export const DAY_CODE_MAP = {
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
 * Reconstructs room numbers that were split across line breaks
 * (e.g., joining broken segments like "12A" and "11C" into "12A-11C")
 * and extracts faculty initials and room code from trailing characters.
 *
 * @param {string[]} tokens - Array of string tokens adjacent to course cell
 * @returns {{ faculty: string|null, room: string, combined: string }}
 */
export function reconstructFacultyAndRoom(tokens = []) {
  if (typeof tokens === 'string') {
    tokens = [tokens];
  }
  const cleanTokens = (tokens || []).map(t => String(t || '').trim()).filter(Boolean);
  if (cleanTokens.length === 0) {
    return { faculty: null, room: 'TBA', combined: '' };
  }

  let combined = cleanTokens[0];
  for (let i = 1; i < cleanTokens.length; i++) {
    const next = cleanTokens[i];
    if (/\d{1,2}[A-Za-z]-?$/.test(combined) && /^[-_]?\d{1,2}[A-Za-z]/.test(next)) {
      // Joining broken segments like "12A" and "11C" into "12A-11C"
      combined = combined.replace(/-+$/, '') + '-' + next.replace(/^-+/, '');
    } else if (combined.endsWith('-') || next.startsWith('-')) {
      combined = combined.replace(/-+$/, '') + '-' + next.replace(/^-+/, '');
    } else {
      combined = combined + '-' + next;
    }
  }

  let room = 'TBA';
  let faculty = null;

  // Extract room code from trailing characters of the faculty-room string
  const roomPattern = /(\d{1,2}[A-Za-z]-\d{1,2}[A-Za-z]|[A-Za-z]{2,4}\d?-\d{1,2}[A-Za-z]|UB\s*\d{3,4}[A-Za-z]?|[A-Za-z0-9]+-[A-Za-z0-9]+[CL]|[A-Za-z0-9]+[CL])$/i;
  const match = combined.match(roomPattern);
  if (match) {
    room = match[1].replace(/\s+/g, '').toUpperCase();
    const prefix = combined.substring(0, match.index).replace(/[-_\s]+$/, '');
    const facMatch = prefix.match(/([A-Za-z]{2,5})$/);
    if (facMatch) {
      faculty = facMatch[1].toUpperCase();
    }
  } else {
    // Fallback: split by hyphens / whitespace
    const parts = combined.split(/[-_\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      faculty = parts[0].toUpperCase();
      room = parts.slice(1).join('-').toUpperCase();
    } else if (parts.length === 1) {
      room = parts[0].toUpperCase();
    }
  }

  return { faculty, room, combined };
}

/**
 * Custom pagerender function for pdf-parse v1 compatibility and custom render pipelines.
 * Inspects horizontal (X) and vertical (Y) coordinates of all text elements.
 */
export async function customPageRender(pageData) {
  const textContent = await pageData.getTextContent();
  let lastY, text = '';
  for (const item of textContent.items) {
    if (!item || typeof item.str !== 'string') continue;
    if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 5) {
      text += '\n';
    } else if (text.length > 0 && !text.endsWith('\n') && !text.endsWith(' ')) {
      text += ' ';
    }
    text += item.str;
    lastY = item.transform[5];
  }
  return text;
}

/**
 * Extracts plain text and coordinate-aware text elements from a PDF Buffer or string.
 * Supports both pdf-parse v1 (function with pagerender) and v2 (PDFParse class).
 */
export async function extractPdfElements(bufferOrData, options = {}) {
  if (typeof bufferOrData === 'string') {
    return {
      elements: [],
      rawText: bufferOrData
    };
  }

  let pdfModule;
  try {
    pdfModule = require('pdf-parse');
  } catch (err) {
    throw new Error(`Failed to load pdf-parse library: ${err.message}`);
  }

  const elements = [];
  let rawText = '';

  // 1. pdf-parse v1 style (function)
  if (typeof pdfModule === 'function') {
    const pageRenderHook = async function(pageData) {
      const textContent = await pageData.getTextContent();
      for (const item of textContent.items) {
        if (!item || typeof item.str !== 'string') continue;
        const x = item.transform ? item.transform[4] : 0;
        const y = item.transform ? item.transform[5] : 0;
        elements.push({
          str: item.str,
          x,
          y,
          width: item.width || 0,
          height: item.height || 0,
          page: pageData.pageNumber || 1
        });
      }
      return customPageRender(pageData);
    };

    const res = await pdfModule(bufferOrData, {
      pagerender: options.pagerender || pageRenderHook,
      ...options
    });
    rawText = res?.text || '';
    return { elements, rawText };
  }

  // 2. pdf-parse v2 style (PDFParse class)
  if (pdfModule?.PDFParse) {
    const parser = new pdfModule.PDFParse({ data: bufferOrData });
    try {
      const doc = await parser.load();
      const numPages = doc.numPages || 1;
      for (let p = 1; p <= numPages; p++) {
        const page = await doc.getPage(p);
        const textContent = await page.getTextContent();
        for (const item of textContent.items) {
          if (!item || typeof item.str !== 'string') continue;
          const x = item.transform ? item.transform[4] : 0;
          const y = item.transform ? item.transform[5] : 0;
          elements.push({
            str: item.str,
            x,
            y,
            width: item.width || 0,
            height: item.height || 0,
            page: p
          });
        }
        if (typeof page.cleanup === 'function') {
          page.cleanup();
        }
      }
      const textRes = await parser.getText();
      rawText = textRes?.text || '';
      return { elements, rawText };
    } finally {
      if (typeof parser.destroy === 'function') {
        try { await parser.destroy(); } catch {}
      }
    }
  }

  // 3. Fallback to default export if present
  if (typeof pdfModule?.default === 'function') {
    const res = await pdfModule.default(bufferOrData, options);
    return { elements: [], rawText: res?.text || '' };
  }

  throw new Error('Unsupported pdf-parse module format');
}

/**
 * Extracts plain text from a PDF Buffer using pdf-parse.
 */
export async function extractPdfText(bufferOrData, options = {}) {
  const { rawText } = await extractPdfElements(bufferOrData, options);
  return rawText;
}

/**
 * Parses the Exam section following the header "DAY TIME EXAM COURSE"
 * from the raw extracted text.
 *
 * @param {string} text - Raw extracted text of the document
 * @param {Map} [coursesMap] - Optional map of courses to resolve default rooms
 * @returns {Array<object>} - Array of parsed exam events
 */
export function parseExamScheduleText(text, coursesMap = new Map()) {
  if (!text || typeof text !== 'string') return [];

  const events = [];
  const headerMatch = text.match(/\bDAY\s+TIME\s+EXAM\s+COURSE\b/i);
  if (!headerMatch) return [];

  const examSection = text.substring(headerMatch.index + headerMatch[0].length);

  // Match each row containing day name, parenthesized ISO date (YYYY-MM-DD),
  // start and end times, exam type (MID or FINAL), and course code.
  // Optional room code on the same line.
  const examRowRegex = /(?:^|\n|\r)\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*\(\s*(\d{4}-\d{2}-\d{2})\s*\)\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s+(MID(?:TERM)?|FINAL)\s+([A-Za-z]{3,4}\s*\d{3}[A-Za-z]?)(?:[^\S\r\n]+([A-Za-z0-9\-]+))?/gi;

  let match;
  while ((match = examRowRegex.exec(examSection)) !== null) {
    const dayName = match[1];
    const dateStr = match[2];
    const rawStart = match[3];
    const rawEnd = match[4];
    const rawExam = match[5];
    const rawCourse = match[6];
    const inlineRoom = match[7] ? match[7].trim() : null;

    const courseCode = rawCourse.replace(/\s+/g, '').toUpperCase();
    const examType = rawExam.toUpperCase().startsWith('MID') ? 'MIDTERM' : 'FINAL';
    const startTime = normalizeTimeTo24h(rawStart);
    const endTime = normalizeTimeTo24h(rawEnd);
    const startIso = parseDateToIsoDhaka(dateStr, startTime);
    const endIso = parseDateToIsoDhaka(dateStr, endTime);

    let room = inlineRoom || (coursesMap.has(courseCode) ? coursesMap.get(courseCode).room : 'TBA');
    if (!room || room === 'TBA') {
      const foundInMap = coursesMap.get(courseCode);
      if (foundInMap?.room) room = foundInMap.room;
    }

    if (startIso && endIso) {
      events.push({
        course_code: courseCode,
        type: examType,
        kind: examType,
        event_type: examType,
        title: `${courseCode} ${examType === 'MIDTERM' ? 'Midterm Exam' : 'Final Exam'}`,
        start_time: startIso,
        end_time: endIso,
        event_time: startIso,
        room: room || 'TBA',
        is_custom: 0
      });
    }
  }

  return events;
}

/**
 * Parses the 2D visual schedule grid using horizontal (X) and vertical (Y) coordinates.
 *
 * 1. Column Boundaries: Scans day headers (SUNDAY, MONDAY, etc.) to define column start/end boundaries.
 * 2. Time Rows: Scans time pattern strings (H:MM AM/PM - H:MM AM/PM) and associates each with Y range.
 * 3. Extract Course Cells: Locates course blocks (e.g. CSE260-05), adjacent faculty/room, reconstructs split rooms,
 *    and matches X to closest day column and Y to closest time row.
 * 4. Classify Event Types: Runs classifyClassEvent (ending in L -> LAB, ending in C -> CLASS).
 *
 * @param {Array<object>} elements - Text items with { str, x, y, width, height }
 * @param {string} rawText - Full raw text of the PDF
 * @returns {{ schedules: Array<object>, courses: Array<object> }}
 */
export function parseBracuGridElements(elements = [], rawText = '') {
  if (!elements || elements.length === 0) {
    return { schedules: [], courses: [] };
  }

  // Find exam header boundary to avoid conflating exam table elements with grid cells
  const examHeaderEl = elements.find(el => /DAY\s+TIME\s+EXAM\s+COURSE/i.test(el.str));
  const examHeaderY = examHeaderEl ? examHeaderEl.y : -Infinity;

  // 1. Determine Column Boundaries
  // Scan page elements for day headers: SUNDAY, MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY
  const dayElements = elements.filter(el => {
    if (el.y <= examHeaderY) return false;
    const clean = el.str.trim().toUpperCase();
    return DAYS_ORDER.includes(clean);
  });

  if (dayElements.length === 0) {
    return { schedules: [], courses: [] };
  }

  // Find the header row: group by Y within 15 units tolerance
  const yGroups = [];
  for (const el of dayElements) {
    let group = yGroups.find(g => Math.abs(g.y - el.y) <= 15);
    if (!group) {
      group = { y: el.y, elements: [] };
      yGroups.push(group);
    }
    group.elements.push(el);
  }
  yGroups.sort((a, b) => b.elements.length - a.elements.length || b.y - a.y);
  const bestDayRow = yGroups[0]?.elements || dayElements;

  // Record horizontal X coordinate of each day header
  const dayColumns = [];
  const seenDays = new Set();
  for (const el of bestDayRow) {
    const dayName = el.str.trim().toUpperCase();
    if (!seenDays.has(dayName)) {
      seenDays.add(dayName);
      dayColumns.push({
        day: dayName,
        x: el.x,
        y: el.y
      });
    }
  }
  dayColumns.sort((a, b) => a.x - b.x);

  if (dayColumns.length === 0) {
    return { schedules: [], courses: [] };
  }

  // Define column boundaries
  for (let i = 0; i < dayColumns.length; i++) {
    const col = dayColumns[i];
    col.startX = i === 0 ? 0 : (dayColumns[i - 1].x + col.x) / 2;
    col.endX = i === dayColumns.length - 1 ? Infinity : (col.x + dayColumns[i + 1].x) / 2;
  }

  // 2. Determine Time Rows
  // Scan for time pattern strings: H:MM AM/PM - H:MM AM/PM
  const timeRegex = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*[-–—]\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i;
  const timeRows = [];

  for (const el of elements) {
    if (el.y <= examHeaderY) continue;
    const match = el.str.trim().match(timeRegex);
    if (match) {
      const startTime = normalizeTimeTo24h(match[1]);
      const endTime = normalizeTimeTo24h(match[2]);
      if (startTime && endTime) {
        // Prevent duplicate time rows at essentially identical Y
        const exists = timeRows.find(t => Math.abs(t.y - el.y) < 8);
        if (!exists) {
          timeRows.push({
            startTime,
            endTime,
            y: el.y,
            raw: el.str.trim()
          });
        }
      }
    }
  }

  if (timeRows.length === 0) {
    return { schedules: [], courses: [] };
  }

  timeRows.sort((a, b) => b.y - a.y);

  // 3. Extract Course Cells
  // Course block matching: three letters followed by three digits, optional 'L', hyphen, section number
  // e.g. CSE260-05, CSE260L-05
  const courseCellRegex = /\b([A-Za-z]{3}\d{3}L?)-(\d{1,3})\b/i;
  const schedules = [];
  const coursesMap = new Map();
  const dedupKey = new Set();

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.y <= examHeaderY) continue;
    const match = el.str.trim().match(courseCellRegex);
    if (!match) continue;

    const courseCode = match[1].toUpperCase();
    const section = match[2].padStart(2, '0');
    const cellX = el.x;
    const cellY = el.y;

    // Collect adjacent text tokens representing faculty and room
    const adjacentTokens = [];

    // Check if faculty and room were appended in the exact same element
    const remainingInCell = el.str.substring(match.index + match[0].length).trim();
    if (remainingInCell) {
      adjacentTokens.push(remainingInCell);
    }

    // Look at following adjacent elements within reasonable spatial bounds
    for (let j = i + 1; j < elements.length && j <= i + 4; j++) {
      const adj = elements[j];
      const adjStr = adj.str.trim();
      if (!adjStr) continue;
      if (courseCellRegex.test(adjStr)) break;
      if (timeRegex.test(adjStr)) break;
      if (DAYS_ORDER.includes(adjStr.toUpperCase())) break;
      if (/DAY\s+TIME\s+EXAM\s+COURSE/i.test(adjStr)) break;

      // Coordinate proximity: must be in same column horizontally and immediately below vertically
      if (Math.abs(adj.x - cellX) > 80) break;
      if (cellY - adj.y > 60 || adj.y - cellY > 15) break;

      adjacentTokens.push(adjStr);
    }

    // Reconstruct room numbers split across line breaks (e.g. "12A" and "11C" -> "12A-11C")
    const { faculty, room } = reconstructFacultyAndRoom(adjacentTokens);

    // Match cell's X coordinate to closest day column boundary
    const closestCol = dayColumns.reduce((prev, curr) =>
      Math.abs(curr.x - cellX) < Math.abs(prev.x - cellX) ? curr : prev
    );
    const dayOfWeek = closestCol.day;

    // Match cell's Y coordinate to corresponding time window row
    const closestRow = timeRows.reduce((prev, curr) =>
      Math.abs(curr.y - cellY) < Math.abs(prev.y - cellY) ? curr : prev
    );
    const startTime = closestRow.startTime;
    const endTime = closestRow.endTime;

    // 4. Classify Event Types
    // Run extracted course code and room through classifyClassEvent
    // Rooms ending with 'L' or courses ending with 'L' must be classified as 'LAB'
    // Rooms ending with 'C' must be classified as 'CLASS'
    const { kind } = classifyClassEvent(courseCode, room);

    const slotKey = `${courseCode}-${section}-${dayOfWeek}-${startTime}`;
    if (!dedupKey.has(slotKey)) {
      dedupKey.add(slotKey);
      schedules.push({
        course_code: courseCode,
        section,
        day_of_week: dayOfWeek,
        start_time: startTime,
        end_time: endTime,
        room: room || 'TBA',
        event_type: kind
      });

      if (!coursesMap.has(courseCode)) {
        coursesMap.set(courseCode, {
          code: courseCode,
          name: courseCode,
          section,
          faculty: faculty || null,
          room: room || 'TBA'
        });
      } else {
        const c = coursesMap.get(courseCode);
        if ((!c.faculty || c.faculty === 'TBA') && faculty) c.faculty = faculty;
        if ((!c.room || c.room === 'TBA') && room && room !== 'TBA') c.room = room;
      }
    }
  }

  return {
    schedules,
    courses: Array.from(coursesMap.values())
  };
}

/**
 * Parses BRACU advising slip text into normalized schedule slots, events, and courses.
 * Maintained for backward compatibility with plain text exports and non-grid advising slips.
 */
export function parseBracuPdfText(text) {
  if (!text || typeof text !== 'string') {
    return { schedules: [], events: [], courses: [] };
  }

  // First check if the text contains the "DAY TIME EXAM COURSE" exam table
  const examEvents = parseExamScheduleText(text);

  // Normalize line endings and characters
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/[\u2013\u2014]/g, '-') // en-dash / em-dash to standard hyphen
    .replace(/[|]/g, ' ') // tables with pipe separators
    .replace(/\t+/g, '\n') // Split on tab stops
    .replace(/(?:\s{2,}|\t+)(?=(?:Midterm|Final|Mid\s*Exam|Final\s*Exam)\b)/gi, '\n'); // Split inline exam columns

  const lines = cleanText.split('\n').map(l => l.trim()).filter(Boolean);

  const schedules = [];
  const events = [...examEvents];
  const coursesMap = new Map();

  let currentCourseCode = null;
  let currentSection = '01';
  let currentFaculty = null;
  let currentRoom = 'TBA';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if line introduces a Course Code
    const explicitCourseMatch = line.match(/(?:Course(?:\s+Code)?[:\s]+)?\b([A-Z]{3,4}\s*\d{3}[A-Z]?)\b/i);
    const isKeyword = explicitCourseMatch && /^(?:MIDTERM|FINAL|EXAM|SL|TIME|ROOM|DATE|DAY|SECTION|SEC|COURSE|THEORY|LAB)/i.test(explicitCourseMatch[1]);

    if (explicitCourseMatch && !isKeyword) {
      const matchedCode = explicitCourseMatch[1].replace(/\s+/g, '').toUpperCase();
      if (/^[A-Z]{3,4}\d{3}[A-Z]?$/.test(matchedCode)) {
        currentCourseCode = matchedCode;
        currentSection = '01';
        currentRoom = 'TBA';

        const secMatch = line.match(/(?:Sec(?:tion)?[:\s]*|\[|\b(?:Sec|Section)\b\s*)(\d{1,3})\b/i);
        if (secMatch) {
          currentSection = secMatch[1].padStart(2, '0');
        } else {
          const afterCodeMatch = line.match(new RegExp(matchedCode + '[\\s,:]+(\\d{1,3})\\b', 'i'));
          if (afterCodeMatch) {
            currentSection = afterCodeMatch[1].padStart(2, '0');
          }
        }

        const facMatch = line.match(/(?:Faculty|Instructor)[:\s]*([A-Z]{3,4})\b/i);
        if (facMatch) {
          currentFaculty = facMatch[1].toUpperCase();
        }

        const headerRoomMatch = line.match(/\b(\d{2}[A-Z]-\d{2}[A-Z]|UB\s*\d{3,4})\b/i);
        if (headerRoomMatch) {
          currentRoom = headerRoomMatch[1].replace(/\s+/g, '').toUpperCase();
        }

        if (!coursesMap.has(currentCourseCode)) {
          coursesMap.set(currentCourseCode, {
            code: currentCourseCode,
            name: currentCourseCode,
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

      if (room && room !== 'TBA' && coursesMap.has(currentCourseCode)) {
        coursesMap.get(currentCourseCode).room = room;
      }

      const daysFound = [];

      for (const [key, fullDay] of Object.entries(DAY_MAP)) {
        const regex = new RegExp(`\\b${key}\\b`, 'i');
        if (regex.test(line)) {
          if (!daysFound.includes(fullDay)) {
            daysFound.push(fullDay);
          }
        }
      }

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

      for (const day of daysFound) {
        const { kind } = classifyClassEvent(currentCourseCode, room);
        schedules.push({
          course_code: currentCourseCode,
          section: currentSection,
          day_of_week: day,
          start_time: startTime,
          end_time: endTime,
          room,
          event_type: kind
        });
      }
    }

    // 2. Detect Midterm or Final Exam from legacy formats
    if (isExamLine && examEvents.length === 0) {
      const examType = /\b(?:MIDTERM|MID\s*EXAM)\b/i.test(line) ? 'MIDTERM' : 'FINAL';
      const examTimeMatch = line.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
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
            kind: examType,
            event_type: examType,
            title: `${currentCourseCode} ${examType === 'MIDTERM' ? 'Midterm Exam' : 'Final Exam'}`,
            start_time: startIso,
            end_time: endIso,
            event_time: startIso,
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
 * Main routine PDF parser for BRACU Connect schedules & routines.
 * Coordinates between 2D visual schedule grid and exam date table.
 *
 * @param {Buffer|Uint8Array|string} bufferOrText - Binary PDF buffer or raw text
 * @param {object} [options] - Optional parsing options (e.g. custom pagerender)
 * @returns {Promise<{ schedules: Array<object>, events: Array<object>, courses: Array<object>, rawText: string }>}
 */
export async function parseBracuPdf(bufferOrText, options = {}) {
  const { elements, rawText } = await extractPdfElements(bufferOrText, options);

  // 1. Try 2D Grid parser if coordinate elements exist
  let gridResult = { schedules: [], courses: [] };
  if (elements && elements.length > 0) {
    try {
      gridResult = parseBracuGridElements(elements, rawText);
    } catch (err) {
      gridResult = { schedules: [], courses: [] };
    }
  }

  // 2. Parse exam dates from "DAY TIME EXAM COURSE" section
  let examEvents = parseExamScheduleText(rawText);

  // 3. Fallback to text parser if 2D grid found no schedules or no exams found
  if (gridResult.schedules.length === 0 || examEvents.length === 0) {
    const textParsed = parseBracuPdfText(rawText);
    if (gridResult.schedules.length === 0) {
      gridResult.schedules = textParsed.schedules;
      gridResult.courses = textParsed.courses;
    }
    if (examEvents.length === 0) {
      examEvents = textParsed.events;
    }
  }

  // Populate coursesMap from resolved courses
  const coursesMap = new Map();
  for (const c of gridResult.courses) {
    coursesMap.set(c.code, c);
  }

  // Merge any courses discovered from exams into courses list
  for (const ev of examEvents) {
    if (!coursesMap.has(ev.course_code)) {
      const newCourse = {
        code: ev.course_code,
        name: ev.course_code,
        section: '01',
        faculty: null,
        room: ev.room || 'TBA'
      };
      coursesMap.set(ev.course_code, newCourse);
      gridResult.courses.push(newCourse);
    }
  }

  return {
    schedules: gridResult.schedules,
    events: examEvents,
    courses: gridResult.courses,
    rawText
  };
}
