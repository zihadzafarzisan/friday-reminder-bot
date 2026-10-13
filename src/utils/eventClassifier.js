/**
 * Centralized helper to dynamically classify class events (CLASS vs LAB)
 * based on room code suffix and course code.
 * - Room ending with 'L' OR Course code ending with 'L' -> kind: 'LAB', label: 'Lab', color: 0xF59E0B (Amber)
 * - Room ending with 'C' OR standard class -> kind: 'CLASS', label: 'Class', color: 0x3B82F6 (Blue)
 *
 * @param {string} [courseCode=''] - Course code string (e.g. 'CSE330L')
 * @param {string} [room=''] - Room code/name string (e.g. '12F-30L')
 * @returns {{ isLab: boolean, kind: 'LAB'|'CLASS', label: 'Lab'|'Class', color: number }}
 */
export function classifyClassEvent(courseCode = '', room = '') {
  const cleanRoom = (room || '').toString().trim().toUpperCase();
  const cleanCourse = (courseCode || '').toString().trim().toUpperCase();

  const isLab = cleanRoom.endsWith('L') || cleanCourse.endsWith('L');

  return {
    isLab,
    kind: isLab ? 'LAB' : 'CLASS',
    label: isLab ? 'Lab' : 'Class',
    color: isLab ? 0xF59E0B : 0x3B82F6
  };
}
