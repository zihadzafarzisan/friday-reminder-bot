/**
 * Helper to dynamically determine event type (CLASS vs LAB) based on room code suffix.
 * - Suffix 'L' (case-insensitive, e.g. "12F-30L") -> 'LAB'
 * - Suffix 'C' (case-insensitive, e.g. "09A-06C") -> 'CLASS'
 * - Missing or ends with any other character -> defaultType ('CLASS')
 *
 * @param {string|null|undefined} room - Room code/name string
 * @param {string} [defaultType='CLASS'] - Fallback event type
 * @returns {string} - 'CLASS' or 'LAB' (or defaultType)
 */
export function resolveEventType(room, defaultType = 'CLASS') {
  if (!room || typeof room !== 'string') return defaultType;
  const cleaned = room.trim().toUpperCase();
  if (cleaned.endsWith('L')) return 'LAB';
  if (cleaned.endsWith('C')) return 'CLASS';
  return defaultType;
}

export { classifyClassEvent } from './eventClassifier.js';
