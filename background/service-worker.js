/**
 * Video Downloader service worker (MV3).
 *
 * Responsibilities:
 *  - Observe network requests for media URLs and remember them per tab.
 *  - Merge network findings with DOM detections from content scripts.
 *  - Enrich HLS/DASH streams by reading their manifests.
 *  - Route download requests to the download manager and keep the badge fresh.
 */

import {
  BADGE_COLOR,
  DEFAULT_SETTINGS,
  MAX_NETWORK_ENTRIES_PER_TAB,
  MAX_TAB_MEDIA,
  MEDIA_KIND,
  MEDIA_REQUEST_TYPES,
  MEDIA_URL_PATTERNS,
  MSG,
  STORAGE_KEYS,
  AD_SETTINGS
} from '../utils/constants.js';
import {
  clearHistory,
  clearTabMedia,
  getHistory,
  getSettings,
  getTabMediaCache,
  removeHistoryEntry,
  saveTabMediaCache,
  setValue,
  checkAdUnlock,
  grantAdUnlock,
  consumeDownload
} from '../utils/storage.js';
import {
  broadcastToPages,
  onMessage,
  requestPageMedia
} from '../utils/messaging.js';
import {
  debounce,
  getDomain,
  stripHash
} from '../utils/helpers.js';
import { logActivity } from '../utils/activity.js';
import {
  getExtension,
  getUnsupportedPageReason,
  isHttpUrl,
  isInjectableUrl
} from '../scripts/url-validator.js';
import {
  buildFormats,
  isHlsMasterPlaylist,
  parseDashManifest,
  parseHlsMaster,
  parseHlsMedia
} from '../scripts/format-detector.js';
import {
  mergeMediaLists,
  normalizeMedia,
  parseIncomingMedia,
  summarizeMedia
} from '../scripts/video-parser.js';
import {
  cancelDownload,
  fetchManifestText,
  initDownloadTracking,
  openDownload,
  showInFolder,
  startDownload,
  startPlaylistDownload
} from '../scripts/download-manager.js';

/* -------------------------------------------------------------------------- */
/* In-memory state                                                            */
/* -------------------------------------------------------------------------- */

/**
 * tabId -> { media: Map<url, media>, pageUrl, pageTitle, updatedAt }
 * Backed by chrome.storage.session so the state survives service worker restarts.
 */
const tabMedia = new Map();
const inflightRequests = new Map();
const badgeTimers = new Map();

let cacheReady = false;
let cacheLoading = null;

async function loadCache() {
  if (cacheLoading) return cacheLoading;
  cacheLoading = (async () => {
    try {
      const cached = await getTabMediaCache();
      let validTabs = null;
      try {
        const tabs = await chrome.tabs.query({});
        validTabs = new Set(tabs.map((tab) => String(tab.id)));
      } catch {
        // Tab access is not essential for cache loading.
      }

      for (const [tabId, data] of Object.entries(cached || {})) {
        if (validTabs && !validTabs.has(String(tabId))) continue;
        if (!data || !Array.isArray(data.media)) continue;
        const media = new Map();
        for (const item of data.media) {
          if (item && item.url) media.set(stripHash(item.url), item);
        }
        tabMedia.set(Number(tabId), {
          media,
          pageUrl: data.pageUrl || '',
          pageTitle: data.pageTitle || '',
          updatedAt: Number(data.updatedAt) || 0
        });
      }
    } catch (error) {
      console.warn('[Video Downloader] Could not restore tab media cache', error);
    } finally {
      cacheReady = true;
    }
  })();
  return cacheLoading;
}

function serializeCache() {
  const result = {};
  for (const [tabId, store] of tabMedia.entries()) {
    result[String(tabId)] = {
      pageUrl: store.pageUrl,
      pageTitle: store.pageTitle,
      updatedAt: store.updatedAt,
      media: [...store.media.values()].slice(0, MAX_TAB_MEDIA)
    };
  }
  return result;
}

const flushCache = debounce(async () => {
  if (!cacheReady) return;
  try {
    await saveTabMediaCache(serializeCache());
  } catch (error) {
    console.warn('[Video Downloader] Could not persist tab media', error);
  }
}, 500);

function scheduleCacheFlush() {
  if (cacheReady) flushCache();
}

function ensureStore(tabId) {
  const id = Number(tabId);
  let store = tabMedia.get(id);
  if (!store) {
    store = { media: new Map(), pageUrl: '', pageTitle: '', updatedAt: 0 };
    tabMedia.set(id, store);
  }
  return store;
}

function clearTab(tabId) {
  const id = Number(tabId);
  if (!tabMedia.has(id)) return;
  tabMedia.delete(id);
  inflightRequests.forEach((entry, requestId) => {
    if (entry.tabId === id) inflightRequests.delete(requestId);
  });
  scheduleCacheFlush();
  scheduleBadge(id);
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

function scheduleBadge(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  if (badgeTimers.has(id)) return;

  const timer = setTimeout(async () => {
    badgeTimers.delete(id);
    try {
      const settings = await getSettings();
      if (!settings.showBadge) {
        await chrome.action.setBadgeText({ tabId: id, text: '' });
        return;
      }
      const store = tabMedia.get(id);
      const count = store ? store.media.size : 0;
      await chrome.action.setBadgeText({
        tabId: id,
        text: count > 0 ? (count > 99 ? '99+' : String(count)) : ''
      });
      if (count > 0) {
        await chrome.action.setBadgeBackgroundColor({ tabId: id, color: BADGE_COLOR });
      }
    } catch {
      // The tab may have closed while the timer was pending.
    }
  }, 250);

  badgeTimers.set(id, timer);
}

async function refreshAllBadges() {
  if (!cacheReady) await loadCache();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    // Fall back to tabs known to the in-memory cache.
    tabs = Array.from(tabMedia.keys(), (id) => ({ id }));
  }
  for (const tab of tabs) {
    if (tab.id != null) scheduleBadge(tab.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Network detection                                                          */
/* -------------------------------------------------------------------------- */

function isLikelySegment(url) {
  const extension = getExtension(url);
  if (extension === 'ts' || extension === 'm4s') return true;
  try {
    const path = new URL(url).pathname;
    if (/\/init(?:[-_][\w-]+)?\.(?:mp4|m4s|m4v)$/i.test(path)) return true;
    if (/(?:seg|segment|chunk|fragment|frag)[-_]?\d+\.(?:mp4|m4v)$/i.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

function readHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (String(header.name || '').toLowerCase() === lower) {
      return String(header.value || '');
    }
  }
  return '';
}

function parseTotalSize(headers, statusCode) {
  const contentRange = readHeader(headers, 'content-range');
  const match = contentRange.match(/\/(\d+)\s*$/);
  if (match) return Number(match[1]) || 0;
  if (Number(statusCode) === 206) return 0;
  const contentLength = Number(readHeader(headers, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > 0) return contentLength;
  return 0;
}

function isHtmlResponse(contentType) {
  return /^(text\/html|application\/json|text\/javascript|application\/javascript|image\/)/i.test(
    contentType
  );
}

/**
 * Capture a network request. Only media-looking requests are stored, which keeps
 * the per-tab list focused and avoids noise from analytics endpoints.
 */
async function handleRequest(details) {
  if (!details || details.tabId < 0) return;
  const url = details.url;
  if (!isHttpUrl(url) || isLikelySegment(url)) return;

  const extension = getExtension(url);
  const isMediaType = details.type === 'media';
  if (!isMediaType && !extension) return;

  await loadCache();
  const pageUrl = details.documentUrl || details.initiator || '';
  const media = normalizeMedia(
    {
      url,
      mime: '',
      kind: extension === 'm3u8' || extension === 'mpd' ? MEDIA_KIND.STREAM : '',
      pageUrl,
      source: 'network'
    },
    { pageUrl, source: 'network' }
  );
  if (!media) return;

  const key = stripHash(url);
  const store = ensureStore(details.tabId);
  const existing = store.media.get(key);

  // A request without an extension is only trusted when the browser labels it
  // as media or a response header later confirms its type.
  if (existing) {
    existing.foundAt = Date.now();
  } else {
    store.media.set(key, media);
    void logActivity('media-detected', {
      domain: pageUrl,
      count: 1
    });
    if (store.media.size > MAX_NETWORK_ENTRIES_PER_TAB) {
      const oldest = [...store.media.entries()]
        .sort((a, b) => (a[1].foundAt || 0) - (b[1].foundAt || 0))
        .slice(0, store.media.size - MAX_NETWORK_ENTRIES_PER_TAB);
      for (const [oldKey] of oldest) store.media.delete(oldKey);
    }
  }
  if (!store.pageUrl && pageUrl) store.pageUrl = pageUrl;
  store.updatedAt = Date.now();

  inflightRequests.set(details.requestId, {
    tabId: details.tabId,
    url,
    pageUrl,
    at: Date.now()
  });
  if (inflightRequests.size > 400) {
    const cutoff = Date.now() - 60000;
    for (const [requestId, entry] of inflightRequests) {
      if (entry.at < cutoff) inflightRequests.delete(requestId);
    }
  }

  scheduleCacheFlush();
  scheduleBadge(details.tabId);
}

async function handleResponseHeaders(details) {
  const tracked = inflightRequests.get(details.requestId);
  if (!tracked) return;
  inflightRequests.delete(details.requestId);

  const contentType = readHeader(details.responseHeaders, 'content-type')
    .split(';')[0]
    .trim()
    .toLowerCase();

  await loadCache();
  const store = tabMedia.get(tracked.tabId);
  if (!store) return;
  const key = stripHash(tracked.url);
  const existing = store.media.get(key);
  if (!existing) return;

  if (contentType && isHtmlResponse(contentType)) {
    store.media.delete(key);
    store.updatedAt = Date.now();
    scheduleCacheFlush();
    scheduleBadge(tracked.tabId);
    return;
  }

  const size = parseTotalSize(details.responseHeaders, details.statusCode);
  const extension = getExtension(tracked.url);
  const isStream = extension === 'm3u8' || extension === 'mpd';

  const enriched = normalizeMedia(
    {
      ...existing,
      mime: contentType || existing.mime,
      size: size || existing.size,
      kind: isStream ? MEDIA_KIND.STREAM : existing.kind,
      pageUrl: existing.pageUrl || tracked.pageUrl,
      source: existing.source || 'network'
    },
    { pageUrl: existing.pageUrl || tracked.pageUrl }
  );

  if (enriched) {
    enriched.title = existing.title;
    enriched.poster = enriched.poster || existing.poster;
    store.media.set(key, enriched);
    store.updatedAt = Date.now();
    scheduleCacheFlush();
    scheduleBadge(tracked.tabId);
  }
}

const onRequest = (details) => {
  void handleRequest(details);
};

const onResponseHeaders = (details) => {
  void handleResponseHeaders(details);
};

// URL-based detection. Types keep the listener limited to interesting traffic.
chrome.webRequest.onBeforeRequest.addListener(onRequest, {
  urls: MEDIA_URL_PATTERNS,
  types: MEDIA_REQUEST_TYPES
});

// Extensionless streams are still labeled `media` by the browser.
chrome.webRequest.onBeforeRequest.addListener(onRequest, {
  urls: ['<all_urls>'],
  types: ['media']
});

chrome.webRequest.onHeadersReceived.addListener(onResponseHeaders, {
  urls: MEDIA_URL_PATTERNS,
  types: MEDIA_REQUEST_TYPES
});

chrome.webRequest.onHeadersReceived.addListener(onResponseHeaders, {
  urls: ['<all_urls>'],
  types: ['media']
});

/* -------------------------------------------------------------------------- */
/* Detection merging                                                          */
/* -------------------------------------------------------------------------- */

function storeMedia(tabId, mediaList, page = {}) {
  if (!Number.isFinite(Number(tabId))) return 0;
  const store = ensureStore(tabId);
  let added = 0;

  for (const media of mediaList) {
    if (!media || !media.url) continue;
    const key = stripHash(media.url);
    const existing = store.media.get(key);
    if (!existing) {
      store.media.set(key, media);
      added += 1;
    } else {
      const merged = mergeMediaLists([existing], [media]);
      store.media.set(key, merged[0] || existing);
    }
    if (store.media.size > MAX_TAB_MEDIA) {
      const oldest = [...store.media.entries()]
        .sort((a, b) => (a[1].foundAt || 0) - (b[1].foundAt || 0))
        .slice(0, store.media.size - MAX_TAB_MEDIA);
      for (const [oldKey] of oldest) store.media.delete(oldKey);
    }
  }

  if (page.url) store.pageUrl = page.url;
  if (page.title) store.pageTitle = page.title;
  store.updatedAt = Date.now();

  if (added > 0) {
    void logActivity('media-detected', {
      domain: page.url || store.pageUrl,
      count: added
    });
    scheduleCacheFlush();
    scheduleBadge(tabId);
  }
  return added;
}

async function handleDetectedMedia(message, sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isFinite(tabId)) {
    return { ok: false, error: 'No tab associated with this detection.' };
  }

  const rawList = Array.isArray(message.videos) ? message.videos.slice(0, MAX_TAB_MEDIA) : [];
  const pageUrl = message.pageUrl || sender.tab.url || '';
  const pageTitle = message.pageTitle || sender.tab.title || '';

  const normalized = rawList
    .map((raw) =>
      normalizeMedia(raw, {
        pageUrl,
        pageTitle,
        source: 'dom'
      })
    )
    .filter(Boolean);

  const added = storeMedia(tabId, normalized, { url: pageUrl, title: pageTitle });
  return {
    ok: true,
    count: ensureStore(tabId).media.size,
    added
  };
}

/* -------------------------------------------------------------------------- */
/* Stream enrichment                                                          */
/* -------------------------------------------------------------------------- */

async function enrichStreams(videos, tabId) {
  const targets = videos
    .filter(
      (media) =>
        media.kind === MEDIA_KIND.STREAM &&
        (!Array.isArray(media.variants) || media.variants.length === 0)
    )
    .slice(0, 6);

  await Promise.all(
    targets.map(async (media) => {
      try {
        const text = await fetchManifestText(media.url, 4500);
        if (media.type === 'hls') {
          if (isHlsMasterPlaylist(text)) {
            media.variants = parseHlsMaster(text, media.url);
          } else {
            const info = parseHlsMedia(text);
            media.encrypted = info.encrypted;
            media.segmentCount = info.segmentCount;
            media.live = !info.ended;
            if (!media.duration && info.duration) media.duration = info.duration;
          }
        } else if (media.type === 'dash') {
          const info = parseDashManifest(text, media.url);
          media.encrypted = info.encrypted;
          media.dashRepresentations = info.representations;
        }
        media.requiresExternal = true;
        media.formats = buildFormats(media);
      } catch (error) {
        media.enrichError = error?.message || String(error);
      }
    })
  );

  // Persist enriched variants so reopening the popup is instant.
  if (Number.isFinite(Number(tabId))) {
    const store = tabMedia.get(Number(tabId));
    if (store) {
      for (const media of videos) {
        if (media.kind !== MEDIA_KIND.STREAM) continue;
        const existing = store.media.get(stripHash(media.url));
        if (existing && media.variants && media.variants.length) {
          existing.variants = media.variants;
          existing.encrypted = media.encrypted;
          existing.formats = media.formats;
          existing.requiresExternal = true;
        }
      }
      scheduleCacheFlush();
    }
  }

  return videos;
}

/* -------------------------------------------------------------------------- */
/* Tab media request                                                          */
/* -------------------------------------------------------------------------- */

async function resolveTabId(message, sender) {
  const requested = Number(message?.tabId);
  if (Number.isFinite(requested) && requested > 0) return requested;
  if (sender?.tab?.id) return sender.tab.id;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return null;
  }
}

async function handleGetTabMedia(message, sender) {
  await loadCache();
  const tabId = await resolveTabId(message, sender);
  if (!Number.isFinite(tabId)) {
    return { ok: false, error: 'No active tab was found.', videos: [] };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: 'This tab is no longer available.', videos: [] };
  }

  const page = {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    domain: getDomain(tab.url || '')
  };

  const unsupported = getUnsupportedPageReason(tab.url);
  if (unsupported) {
    return { ok: true, unsupported: true, reason: unsupported, videos: [], page, tabId };
  }

  const shouldRescan = message?.type === MSG.REFRESH_TAB_MEDIA;
  if (shouldRescan) {
    const store = ensureStore(tabId);
    if (store.pageUrl && store.pageUrl !== tab.url) {
      store.media.clear();
    }
    store.pageUrl = tab.url || '';
    store.pageTitle = tab.title || '';
    store.updatedAt = Date.now();
    scheduleCacheFlush();
    scheduleBadge(tabId);
  }

  const contentResponse = await requestPageMedia(tabId, { rescan: shouldRescan });
  const pageVideos = Array.isArray(contentResponse?.videos)
    ? contentResponse.videos
        .map((raw) =>
          normalizeMedia(raw, {
            pageUrl: tab.url,
            pageTitle: tab.title,
            source: 'dom'
          })
        )
        .filter(Boolean)
    : [];

  if (pageVideos.length) {
    storeMedia(tabId, pageVideos, {
      url: contentResponse?.pageUrl || tab.url,
      title: contentResponse?.pageTitle || tab.title
    });
  }

  const store = tabMedia.get(tabId);
  const networkVideos = store ? [...store.media.values()] : [];
  let videos = mergeMediaLists(pageVideos, networkVideos);

  videos = await enrichStreams(videos, tabId);
  videos = videos.map((media) => ({ ...media, formats: buildFormats(media) }));

  return {
    ok: true,
    tabId,
    page,
    videos,
    summary: summarizeMedia(videos),
    warning: contentResponse?.ok
      ? ''
      : contentResponse?.error || 'The page could not be scanned, showing network detections only.',
    restricted: !isInjectableUrl(tab.url)
  };
}

async function requestAdApi(action, options = {}) {
  const settings = await getSettings();
  if (!settings.adApiUrl) {
    throw new Error('Configure the website Ad API URL in extension Settings first.');
  }

  const url = new URL(settings.adApiUrl);
  url.searchParams.set('action', action);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url.href, {
      method: options.method || 'GET',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `Website API returned HTTP ${response.status}.`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('The website API request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Download handling                                                          */
/* -------------------------------------------------------------------------- */

function findMatchingFormat(media, incoming) {
  if (!incoming) return null;
  const formats = Array.isArray(media.formats) ? media.formats : [];
  if (incoming.id) {
    const byId = formats.find((format) => format.id === incoming.id);
    if (byId) return byId;
  }
  if (incoming.url) {
    const byUrl = formats.find((format) => stripHash(format.url) === stripHash(incoming.url));
    if (byUrl) return byUrl;
  }
  // Redownloads from history may reference a URL that has no current formats.
  if (incoming.url) {
    return {
      ...incoming,
      requiresExternal: Boolean(incoming.requiresExternal)
    };
  }
  return null;
}

async function handleStartDownload(message, sender) {
  const parsed = parseIncomingMedia(message.media);
  if (!parsed.ok) return parsed;
  const media = parsed.media;
  const format = findMatchingFormat(media, message.format);
  const settings = await getSettings();
  const tabId = Number(message.tabId) || sender?.tab?.id || null;

  if (message.playlist) {
    return startPlaylistDownload(media, format, { settings, tabId });
  }
  return startDownload(media, format, { settings, tabId });
}

/* -------------------------------------------------------------------------- */
/* Message router                                                             */
/* -------------------------------------------------------------------------- */

onMessage(async (message, sender) => {
  const type = message?.type;
  if (!type) return { ok: false, error: 'Unknown message.' };

  switch (type) {
    case MSG.PING:
      return { ok: true, alive: true, version: chrome.runtime.getManifest().version };

    case MSG.DETECTED_MEDIA:
      return handleDetectedMedia(message, sender);

    case MSG.GET_TAB_MEDIA:
    case MSG.REFRESH_TAB_MEDIA:
      return handleGetTabMedia(message, sender);

    case MSG.CHECK_AD_UNLOCK: {
      const unlock = await checkAdUnlock();
      return { ok: true, ...unlock };
    }

    case MSG.GET_AD_CREDITS: {
      const unlock = await checkAdUnlock();
      return {
        ok: true,
        unlocked: Boolean(unlock.unlocked),
        downloadsRemaining: Number(unlock.downloadsRemaining) || 0,
        expired: Boolean(unlock.expired),
        noDownloadsLeft: Boolean(unlock.noDownloadsLeft)
      };
    }

    case MSG.REQUEST_AD: {
      const { ads } = await requestAdApi('ads');
      const activeAds = (Array.isArray(ads) ? ads : []).filter((ad) => ad.active !== false);
      if (!activeAds.length) {
        return { ok: false, error: 'No ads available' };
      }
      const ad = activeAds[Math.floor(Math.random() * activeAds.length)];
      try {
        await requestAdApi('event', { method: 'POST', body: { type: 'impression' } });
      } catch (error) {
        console.warn('[Video Downloader] Could not record ad impression', error);
      }
      return { ok: true, ad };
    }

    case MSG.AD_WATCHED: {
      if (message.completed) {
        try {
          await requestAdApi('event', { method: 'POST', body: { type: 'completion' } });
        } catch (error) {
          console.warn('[Video Downloader] Could not record ad completion', error);
        }
        const unlock = await grantAdUnlock();
        return { ok: true, unlocked: true, unlock };
      }
      if (message.clicked) {
        try {
          await requestAdApi('event', { method: 'POST', body: { type: 'click' } });
        } catch (error) {
          console.warn('[Video Downloader] Could not record ad click', error);
        }
      }
      return { ok: true };
    }

    case MSG.START_DOWNLOAD: {
      const adCheck = await checkAdUnlock();
      if (AD_SETTINGS.requireAdForDownload && !adCheck.unlocked) {
        return { ok: false, code: 'AD_REQUIRED', error: 'Please watch an ad to download this video.' };
      }
      const result = await handleStartDownload(message, sender);
      if (result && result.ok && AD_SETTINGS.requireAdForDownload) {
        const consumed = await consumeDownload();
        if (consumed) {
          try {
            await requestAdApi('event', {
              method: 'POST',
              body: { type: 'credit' }
            });
          } catch (error) {
            console.warn('[Video Downloader] Could not record credit usage', error);
          }
        }
      }
      return result;
    }

    case MSG.CANCEL_DOWNLOAD:
      return cancelDownload(message.downloadId);

    case MSG.OPEN_DOWNLOAD:
      return openDownload(message.downloadId);

    case MSG.SHOW_IN_FOLDER:
      return showInFolder(message.downloadId);

    case MSG.GET_HISTORY: {
      const history = await getHistory(Number(message.limit) || 0);
      return { ok: true, history };
    }

    case MSG.REMOVE_HISTORY_ITEM: {
      if (!message.id) return { ok: false, error: 'Missing history id.' };
      const removed = await removeHistoryEntry(message.id);
      if (removed) void logActivity('history-entry-removed');
      return { ok: removed };
    }

    case MSG.CLEAR_HISTORY:
      await clearHistory();
      void logActivity('history-cleared');
      return { ok: true };

    case MSG.OPEN_POPUP: {
      const tabId = sender?.tab?.id;
      try {
        await chrome.action.openPopup(
          sender?.tab?.windowId ? { windowId: sender.tab.windowId } : undefined
        );
        return { ok: true };
      } catch {
        if (!tabId) return { ok: false };
        await chrome.tabs.create({
          url: chrome.runtime.getURL(`popup/popup.html?tabId=${tabId}`)
        });
        return { ok: true, fallback: true };
      }
    }

    default:
      return { ok: false, error: `Unsupported message: ${type}` };
  }
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const settings = await getSettings();
    await setValue({ [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...settings } });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });

    if (details.reason === 'install') {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('options/options.html?welcome=1')
      });
    }
  } catch (error) {
    console.warn('[Video Downloader] Install initialization failed', error);
  }
});

chrome.runtime.onStartup.addListener(() => {
  void loadCache().then(refreshAllBadges);
});

// Settings changes can toggle badge visibility or highlight behaviour.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.SETTINGS]) return;
  void logActivity('settings-changed');
  void loadCache().then(refreshAllBadges);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  const timer = badgeTimers.get(tabId);
  if (timer) clearTimeout(timer);
  badgeTimers.delete(tabId);
  void clearTabMedia(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    clearTab(tabId);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('vd-done-')) return;
  void chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
  chrome.notifications.clear(notificationId);
});

chrome.runtime.onSuspend.addListener(() => {
  void saveTabMediaCache(serializeCache()).catch(() => {});
});

// Keep the callback-based listeners above and initialize at module scope.
initDownloadTracking();
void loadCache()
  .then(() => {
    Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR })).catch(() => {});
  })
  .catch((error) => console.warn('[Video Downloader] Initialization failed', error));
