import { MAX_ACTIVITY_ENTRIES, STORAGE_KEYS } from './constants.js';
import { getDomain } from './helpers.js';
import { getValue, setValue } from './storage.js';

let activityQueue = Promise.resolve();

function serializeActivity(task) {
  const run = activityQueue.catch(() => {}).then(task);
  activityQueue = run.catch(() => {});
  return run;
}

function safeDomain(value) {
  if (!value) return '';
  const domain = getDomain(value);
  return domain === 'unknown source' ? '' : domain;
}

export async function getActivity(limit = 0) {
  const entries = await getValue(STORAGE_KEYS.ACTIVITY, []);
  if (!Array.isArray(entries)) return [];
  const sorted = entries
    .filter((entry) => entry && typeof entry === 'object')
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

export async function logActivity(type, details = {}) {
  return serializeActivity(async () => {
    try {
      const entries = await getActivity();
      const entry = {
        id: `${Date.now()}-${crypto.randomUUID()}`,
        timestamp: Date.now(),
        type: String(type || 'activity').slice(0, 48),
        domain: safeDomain(details.domain || details.pageUrl || ''),
        count: Math.max(0, Number(details.count) || 0),
        status: String(details.status || '').slice(0, 32)
      };
      await setValue({
        [STORAGE_KEYS.ACTIVITY]: [entry, ...entries].slice(0, MAX_ACTIVITY_ENTRIES)
      });
      return entry;
    } catch (error) {
      console.warn('[Video Downloader] Activity could not be recorded', error);
      return null;
    }
  });
}

export async function clearActivity() {
  return serializeActivity(async () => {
    try {
      await setValue({ [STORAGE_KEYS.ACTIVITY]: [] });
      return true;
    } catch (error) {
      console.warn('[Video Downloader] Activity could not be cleared', error);
      return false;
    }
  });
}
