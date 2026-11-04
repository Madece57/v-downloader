/**
 * Promise-based wrappers around chrome.storage plus the extension's data model.
 * All reads are defensive: a missing or corrupt value falls back to a default.
 */

import {
  DEFAULT_SETTINGS,
  MAX_HISTORY_DEFAULT,
  MAX_HISTORY_HARD_LIMIT,
  STORAGE_KEYS,
  AD_SETTINGS
} from './constants.js';
import { cloneJson, mergeDefined } from './helpers.js';

const localArea = () => chrome.storage.local;
const sessionArea = () => chrome.storage.session || chrome.storage.local;

function normalizeSupportUrl(value) {
  const supportUrl = String(value || DEFAULT_SETTINGS.supportUrl).trim();
  try {
    const parsedSupportUrl = new URL(supportUrl);
    return parsedSupportUrl.protocol === 'http:' || parsedSupportUrl.protocol === 'https:'
      ? parsedSupportUrl.href
      : DEFAULT_SETTINGS.supportUrl;
  } catch {
    return DEFAULT_SETTINGS.supportUrl;
  }
}

function normalizeApiUrl(value) {
  const apiUrl = String(value || '').trim();
  if (!apiUrl) return '';
  try {
    const parsed = new URL(apiUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

/** Read a single key with a fallback value. */
export async function getValue(key, fallback = null, area = 'local') {
  try {
    const store = area === 'session' ? sessionArea() : localArea();
    const result = await store.get(key);
    if (!result || result[key] === undefined) return cloneJson(fallback);
    return result[key];
  } catch (error) {
    console.warn('[Video Downloader] storage read failed', error);
    return cloneJson(fallback);
  }
}

/** Write one or more keys. */
export async function setValue(keys, area = 'local') {
  const store = area === 'session' ? sessionArea() : localArea();
  await store.set(keys);
}

/** Remove keys. */
export async function removeValue(keys, area = 'local') {
  const store = area === 'session' ? sessionArea() : localArea();
  await store.remove(keys);
}

/** Load settings merged with defaults and clamped to valid ranges. */
export async function getSettings() {
  const stored = await getValue(STORAGE_KEYS.SETTINGS, {});
  const settings = mergeDefined(DEFAULT_SETTINGS, stored || {});

  settings.historyLimit = Math.min(
    MAX_HISTORY_HARD_LIMIT,
    Math.max(20, Number(settings.historyLimit) || MAX_HISTORY_DEFAULT)
  );
  settings.downloadFolder = String(settings.downloadFolder || '').trim();
  settings.filenameTemplate = String(
    settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate
  ).slice(0, 140);
  settings.supportUrl = normalizeSupportUrl(settings.supportUrl);
  settings.adApiUrl = normalizeApiUrl(settings.adApiUrl);

  return settings;
}

/** Persist a partial settings patch and return the merged result. */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeDefined(current, patch || {});
  next.supportUrl = normalizeSupportUrl(next.supportUrl);
  next.adApiUrl = normalizeApiUrl(next.adApiUrl);
  await setValue({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

/** Reset all settings to defaults. */
export async function resetSettings() {
  await setValue({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

let historyQueue = Promise.resolve();

/**
 * Serialize history mutations. Download progress updates can arrive in bursts
 * and must not clobber each other.
 */
function withHistoryLock(task) {
  const run = historyQueue.catch(() => {}).then(task);
  historyQueue = run.catch(() => {});
  return run;
}

/** Load history, newest first. */
export async function getHistory(limit = 0) {
  const history = await getValue(STORAGE_KEYS.HISTORY, []);
  if (!Array.isArray(history)) return [];
  const sorted = history
    .filter((entry) => entry && typeof entry === 'object')
    .sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

/** Add or replace a history entry. */
export async function addHistoryEntry(entry) {
  return withHistoryLock(async () => {
    const history = await getHistory();
    const settings = await getSettings();
    const limit = settings.historyLimit;
    const withoutDuplicate = history.filter((item) => item.id !== entry.id);
    const next = [entry, ...withoutDuplicate].slice(0, limit);
    await setValue({ [STORAGE_KEYS.HISTORY]: next });
    return entry;
  });
}

/** Patch an entry by its internal id. */
export async function updateHistoryEntry(id, patch) {
  return withHistoryLock(async () => {
    const history = await getHistory();
    const index = history.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const next = { ...history[index], ...patch, updatedAt: Date.now() };
    history[index] = next;
    await setValue({ [STORAGE_KEYS.HISTORY]: history });
    return next;
  });
}

/** Patch an entry using the chrome.downloads download id. */
export async function updateHistoryEntryByDownloadId(downloadId, patch) {
  const numericId = Number(downloadId);
  return withHistoryLock(async () => {
    const history = await getHistory();
    const index = history.findIndex(
      (entry) => Number(entry.downloadId) === numericId
    );
    if (index === -1) return null;
    const next = { ...history[index], ...patch, updatedAt: Date.now() };
    history[index] = next;
    await setValue({ [STORAGE_KEYS.HISTORY]: history });
    return next;
  });
}

/** Remove one entry. */
export async function removeHistoryEntry(id) {
  return withHistoryLock(async () => {
    const history = await getHistory();
    const next = history.filter((entry) => entry.id !== id);
    await setValue({ [STORAGE_KEYS.HISTORY]: next });
    return next.length !== history.length;
  });
}

/** Remove every history entry (downloads on disk are untouched). */
export async function clearHistory() {
  return withHistoryLock(async () => {
    await setValue({ [STORAGE_KEYS.HISTORY]: [] });
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Download id -> history id map                                              */
/* -------------------------------------------------------------------------- */

/** Store the mapping between a chrome.downloads id and a history entry id. */
export async function mapDownload(downloadId, historyId) {
  const map = await getValue(STORAGE_KEYS.DOWNLOAD_MAP, {}, 'session');
  map[String(downloadId)] = historyId;
  await setValue({ [STORAGE_KEYS.DOWNLOAD_MAP]: map }, 'session');
}

/** Resolve the history id for a chrome.downloads id. */
export async function getMappedHistoryId(downloadId) {
  const map = await getValue(STORAGE_KEYS.DOWNLOAD_MAP, {}, 'session');
  return map[String(downloadId)] || '';
}

/** Forget a download mapping. */
export async function unmapDownload(downloadId) {
  const map = await getValue(STORAGE_KEYS.DOWNLOAD_MAP, {}, 'session');
  if (!(String(downloadId) in map)) return;
  delete map[String(downloadId)];
  await setValue({ [STORAGE_KEYS.DOWNLOAD_MAP]: map }, 'session');
}

/* -------------------------------------------------------------------------- */
/* Session tab media cache                                                    */
/* -------------------------------------------------------------------------- */

/** Load the whole tab->media cache used by the service worker. */
export async function getTabMediaCache() {
  const cache = await getValue(STORAGE_KEYS.TAB_MEDIA, {}, 'session');
  return cache && typeof cache === 'object' ? cache : {};
}

/** Persist the tab->media cache. */
export async function saveTabMediaCache(cache) {
  await setValue({ [STORAGE_KEYS.TAB_MEDIA]: cache }, 'session');
}

/** Clear cached media for a single tab. */
export async function clearTabMedia(tabId) {
  const cache = await getTabMediaCache();
  if (!(String(tabId) in cache)) return;
  delete cache[String(tabId)];
  await saveTabMediaCache(cache);
}

/** Remove cache entries for tabs that no longer exist. */
export async function pruneTabMedia(validTabIds) {
  const cache = await getTabMediaCache();
  const valid = new Set(validTabIds.map(String));
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (!valid.has(key)) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) await saveTabMediaCache(cache);
  return changed;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export async function isOnboarded() {
  return Boolean(await getValue(STORAGE_KEYS.ONBOARDED, false));
}

export async function setOnboarded(value = true) {
  await setValue({ [STORAGE_KEYS.ONBOARDED]: value });
}

/** Subscribe to settings/history changes made by other extension contexts. */
export function onStorageChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    callback(changes);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function getAdUnlocks() {
  const unlocks = await getValue(STORAGE_KEYS.AD_UNLOCKS, {});
  return unlocks && typeof unlocks === 'object' ? unlocks : {};
}

export async function grantAdUnlock(duration = AD_SETTINGS.adUnlockDuration) {
  const unlocks = await getAdUnlocks();
  const now = Date.now();
  unlocks.session = {
    grantedAt: now,
    expiresAt: now + duration,
    downloadsRemaining: AD_SETTINGS.downloadsPerAd || 10,
    downloadsUsed: 0
  };
  await setValue({ [STORAGE_KEYS.AD_UNLOCKS]: unlocks });
  return unlocks.session;
}

export async function checkAdUnlock() {
  if (!AD_SETTINGS.requireAdForDownload) return { unlocked: true, downloadsRemaining: null };
  const unlocks = await getAdUnlocks();
  const session = unlocks.session;
  if (!session) return { unlocked: false, downloadsRemaining: 0 };
  const now = Date.now();
  if (session.expiresAt && session.expiresAt < now) {
    return { unlocked: false, expired: true, downloadsRemaining: 0 };
  }
  const downloadsRemaining = typeof session.downloadsRemaining === 'number' 
    ? session.downloadsRemaining 
    : (session.downloadsUsed !== undefined ? Math.max(0, (AD_SETTINGS.downloadsPerAd || 10) - session.downloadsUsed) : 0);
  
  if (downloadsRemaining <= 0) {
    return { unlocked: false, noDownloadsLeft: true, downloadsRemaining: 0 };
  }
  return { unlocked: true, expiresAt: session.expiresAt, downloadsRemaining };
}

export async function consumeDownload() {
  const unlocks = await getAdUnlocks();
  const session = unlocks.session;
  if (!session) return false;
  const now = Date.now();
  if (session.expiresAt && session.expiresAt < now) {
    return false;
  }
  if (typeof session.downloadsRemaining === 'number') {
    if (session.downloadsRemaining <= 0) return false;
    session.downloadsRemaining -= 1;
    session.downloadsUsed = (session.downloadsUsed || 0) + 1;
  } else if (session.downloadsUsed !== undefined) {
    const used = session.downloadsUsed + 1;
    const limit = AD_SETTINGS.downloadsPerAd || 10;
    if (used > limit) return false;
    session.downloadsUsed = used;
  } else {
    session.downloadsUsed = 1;
  }
  unlocks.session = session;
  await setValue({ [STORAGE_KEYS.AD_UNLOCKS]: unlocks });
  return true;
}
