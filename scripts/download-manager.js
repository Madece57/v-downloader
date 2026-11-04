/**
 * Download orchestration.
 *
 * Progressive files (MP4/WebM/MOV/audio) are handed to chrome.downloads.
 * HLS/DASH manifests are explicitly marked as requiring an external media tool;
 * the only thing this module will save for them is the playlist itself, on
 * explicit request, so users can feed it to VLC or ffmpeg.
 */

import {
  DOWNLOAD_STATES,
  ENRICHMENT,
  HISTORY_STATUS,
  MSG
} from '../utils/constants.js';
import {
  addHistoryEntry,
  getHistory,
  getMappedHistoryId,
  getSettings,
  mapDownload,
  unmapDownload,
  updateHistoryEntryByDownloadId
} from '../utils/storage.js';
import { broadcastToPages } from '../utils/messaging.js';
import {
  applyTemplate,
  createId,
  getDomain,
  sanitizeFilename,
  truncate
} from '../utils/helpers.js';
import {
  buildFormats,
  externalFormatReason,
  pickDefaultFormat,
  absolutizeHlsPlaylist
} from './format-detector.js';
import {
  getExtension,
  isYouTubeUrl,
  validateMediaUrl
} from './url-validator.js';
import { titleFromUrl } from './video-parser.js';
import { logActivity } from '../utils/activity.js';

const downloadProgressWrites = new Map();

/** Build a YYYY-MM-DD string in local time. */
function datePart(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Build a HH-MM-SS string in local time. */
function timePart(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** Sanitize a folder setting that may contain nested folders. */
export function buildFolderPath(folder) {
  return String(folder ?? '')
    .split(/[\\/]+/)
    .map((part) => sanitizeFilename(part, 60))
    .filter(Boolean)
    .join('/');
}

/** Pick the best extension for a media/format pair. */
export function resolveExtension(media, format) {
  const candidates = [
    format?.extension,
    getExtension(format?.url || ''),
    media?.extension,
    getExtension(media?.url || '')
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').toLowerCase();
    if (/^[a-z0-9]{2,6}$/.test(value)) return value;
  }
  if (media?.kind === 'audio') return 'm4a';
  if (media?.type === 'hls') return 'm3u8';
  if (media?.type === 'dash') return 'mpd';
  return 'mp4';
}

/**
 * Build a safe relative download path, including the user's folder.
 * Supports the {title}, {quality}, {format}, {ext}, {domain}, {date},
 * {time} and {timestamp} template tokens.
 */
export function buildFilename(media, format, settings = {}) {
  const extension = resolveExtension(media, format);
  const now = new Date();
  const quality =
    Number(format?.height) > 0
      ? `${Number(format.height)}p`
      : sanitizeFilename(format?.label || '', 24) || 'original';

  const variables = {
    title: sanitizeFilename(
      media?.title || titleFromUrl(media?.url || '') || 'video',
      90
    ),
    quality: sanitizeFilename(quality, 24),
    format: extension.toUpperCase(),
    ext: extension,
    domain: sanitizeFilename(getDomain(media?.pageUrl || media?.url || ''), 40),
    date: datePart(now),
    time: timePart(now),
    timestamp: now.getTime()
  };

  let template = String(settings.filenameTemplate || '{title} - {quality}').trim();
  if (!template) template = '{title} - {quality}';

  let name = applyTemplate(template, variables);
  name = name.replace(/\s+/g, ' ').trim();
  name = sanitizeFilename(name, 130);

  if (!name.toLowerCase().endsWith(`.${extension}`)) {
    name = `${name}.${extension}`;
  }

  const folder = buildFolderPath(settings.downloadFolder);
  return folder ? `${folder}/${name}` : name;
}

/** Create the standard history entry for a download. */
function createHistoryEntry({ media, format, filename, downloadId, tabId, status, error }) {
  const extension = resolveExtension(media, format);
  return {
    id: createId('dl'),
    downloadId: Number(downloadId) || null,
    url: media?.url || format?.url || '',
    title: truncate(media?.title || titleFromUrl(media?.url || '') || 'Media', 180),
    filename,
    requestedFilename: filename,
    domain: media?.domain || getDomain(media?.pageUrl || media?.url || ''),
    pageUrl: media?.pageUrl || '',
    pageTitle: media?.pageTitle || '',
    poster: media?.poster || '',
    kind: media?.kind || 'video',
    mediaType: media?.type || 'file',
    extension,
    formatLabel: format?.label || '',
    height: Number(format?.height) || 0,
    size: Number(media?.size) || 0,
    status,
    error: error || '',
    bytesReceived: 0,
    totalBytes: Number(media?.size) || 0,
    fileSize: 0,
    startedAt: Date.now(),
    completedAt: status === HISTORY_STATUS.IN_PROGRESS ? null : Date.now(),
    tabId: Number(tabId) || null
  };
}

/** Normalize chrome.downloads errors into something a user can understand. */
export function friendlyDownloadError(error) {
  const message = String(error?.message || error || 'Download failed.');
  if (/invalid filename/i.test(message)) {
    return 'The file name contains unsupported characters. Check your filename template in Settings.';
  }
  if (/network/i.test(message)) {
    return 'The download failed because the server could not be reached.';
  }
  if (/forbidden|403/i.test(message)) {
    return 'The server refused the download. The media may be protected or require a logged-in session.';
  }
  return message;
}

/**
 * Start a progressive download.
 * @returns {Promise<{ok:boolean, downloadId?:number, historyId?:string, filename?:string, code?:string, error?:string}>}
 */
export async function startDownload(media, formatInput, options = {}) {
  const settings = options.settings || (await getSettings());
  const formats =
    Array.isArray(media?.formats) && media.formats.length
      ? media.formats
      : buildFormats(media);
  const format = formatInput || pickDefaultFormat(formats, settings);

  if (!media || !media.url) {
    return { ok: false, code: 'NO_MEDIA', error: 'No media was selected.' };
  }
  if (!format || !format.url) {
    return { ok: false, code: 'NO_FORMAT', error: 'No downloadable format is available.' };
  }

  if ([media.url, media.pageUrl, format.url].some(isYouTubeUrl)) {
    return {
      ok: false,
      code: 'YOUTUBE_UNSUPPORTED',
      error:
        'YouTube uses separate audio/video streams and partial requests. Direct downloads are disabled to avoid incomplete or incorrect files.'
    };
  }

  if (format.requiresExternal) {
    return {
      ok: false,
      code: 'STREAM_REQUIRES_EXTERNAL',
      error: externalFormatReason(format)
    };
  }

  const validation = validateMediaUrl(format.url, {
    allowStreams: false,
    mime: format.mime || media.mime || '',
    kind: format.kind || media.kind || ''
  });
  if (!validation.valid) {
    return { ok: false, code: 'INVALID_URL', error: validation.reason };
  }
  // Avoid downloading HTML pages
  if (/\.html?(\?|$)/i.test(format.url) || /\/watch\?|youtube\.com\/watch/i.test(format.url)) {
    return { ok: false, code: 'INVALID_URL', error: 'Invalid media URL. Try a different format or refresh the page.' };
  }

  const filename = buildFilename(media, format, settings);
  let downloadId;
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      downloadId = await chrome.downloads.download({
        url: format.url,
        filename: attempt === 0 ? filename : `video-downloader-${Date.now()}.${resolveExtension(media, format)}`,
        conflictAction: 'uniquify',
        saveAs: Boolean(settings.askWhereToSave)
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      // Retry only when the filename itself was rejected.
      if (!/invalid filename/i.test(String(error?.message || ''))) break;
    }
  }

  if (!downloadId) {
    const message = friendlyDownloadError(lastError);
    await addHistoryEntry(
      createHistoryEntry({
        media,
        format,
        filename,
        downloadId: null,
        tabId: options.tabId,
        status: HISTORY_STATUS.FAILED,
        error: message
      })
    );
    void logActivity('download-failed', {
      domain: media?.pageUrl || media?.url,
      status: HISTORY_STATUS.FAILED
    });
    return { ok: false, code: 'DOWNLOAD_FAILED', error: message };
  }

  const entry = createHistoryEntry({
    media,
    format,
    filename,
    downloadId,
    tabId: options.tabId,
    status: HISTORY_STATUS.IN_PROGRESS
  });

  await addHistoryEntry(entry);
  await mapDownload(downloadId, entry.id);
  void logActivity('download-started', {
    domain: media?.pageUrl || media?.url,
    status: HISTORY_STATUS.IN_PROGRESS
  });
  startProgressPolling();

  return {
    ok: true,
    downloadId,
    historyId: entry.id,
    filename,
    format: format.label
  };
}

/** Fetch a manifest with a timeout and a hard size cap. */
export async function fetchManifestText(url, timeout = ENRICHMENT.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept:
          'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, text/plain, */*'
      }
    });
    if (!response.ok) {
      throw new Error(`The playlist returned HTTP ${response.status}.`);
    }
    const text = await response.text();
    if (text.length > ENRICHMENT.maxManifestBytes) {
      throw new Error('The playlist is too large to save.');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save an HLS/DASH manifest as a small text file. This is offered as a
 * convenience, not as a substitute for muxing the actual video.
 */
export async function startPlaylistDownload(media, formatInput, options = {}) {
  const settings = options.settings || (await getSettings());
  const format = formatInput || (media?.formats || [])[0] || null;
  const url = format?.url || media?.url;
  const isHlsPlaylist = (format?.type || media?.type) === 'hls' || format?.extension === 'm3u8';
  const extension = isHlsPlaylist ? 'm3u8' : 'mpd';

  if ([media?.url, media?.pageUrl, url].some(isYouTubeUrl)) {
    return {
      ok: false,
      error:
        'YouTube uses separate audio/video streams and partial requests. Direct downloads are disabled to avoid incomplete or incorrect files.'
    };
  }

  if (!url) {
    return { ok: false, error: 'No stream URL is available.' };
  }

  let text;
  try {
    text = await fetchManifestText(url);
  } catch (error) {
    void logActivity('download-failed', {
      domain: media?.pageUrl || media?.url,
      status: HISTORY_STATUS.FAILED
    });
    return {
      ok: false,
      error: `Could not read the playlist: ${error?.message || error}`
    };
  }

  if (isHlsPlaylist) {
    text = absolutizeHlsPlaylist(text, url);
  }

  const dataUrl = `data:${
    isHlsPlaylist ? 'application/vnd.apple.mpegurl' : 'application/dash+xml'
  };charset=utf-8,${encodeURIComponent(text)}`;

  if (dataUrl.length > 2_000_000) {
    return { ok: false, error: 'The playlist is too large to save from the browser.' };
  }

  const folder = buildFolderPath(settings.downloadFolder);
  const baseName = sanitizeFilename(
    `${media?.title || titleFromUrl(url) || 'stream'} - playlist`,
    100
  );
  const filename = `${folder ? `${folder}/` : ''}${baseName}.${extension}`;

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: Boolean(settings.askWhereToSave)
    });
  } catch (error) {
    void logActivity('download-failed', {
      domain: media?.pageUrl || media?.url,
      status: HISTORY_STATUS.FAILED
    });
    return { ok: false, error: friendlyDownloadError(error) };
  }

  const entry = createHistoryEntry({
    media: { ...media, type: extension === 'm3u8' ? 'hls' : 'dash', extension },
    format: { ...(format || {}), extension, label: 'Playlist' },
    filename,
    downloadId,
    tabId: options.tabId,
    status: HISTORY_STATUS.IN_PROGRESS
  });
  entry.extension = extension;
  entry.formatLabel = 'Playlist';
  entry.size = 0;

  await addHistoryEntry(entry);
  await mapDownload(downloadId, entry.id);
  void logActivity('download-started', {
    domain: media?.pageUrl || media?.url,
    status: HISTORY_STATUS.IN_PROGRESS
  });
  startProgressPolling();

  return { ok: true, downloadId, historyId: entry.id, filename, playlist: true };
}

/** Cancel an active download. */
export async function cancelDownload(downloadId) {
  try {
    await chrome.downloads.cancel(Number(downloadId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyDownloadError(error) };
  }
}

/** Resume a paused/interrupted download. */
export async function resumeDownload(downloadId) {
  try {
    await chrome.downloads.resume(Number(downloadId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyDownloadError(error) };
  }
}

/** Open the downloaded file with the OS default application. */
export async function openDownload(downloadId) {
  try {
    await chrome.downloads.open(Number(downloadId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyDownloadError(error) };
  }
}

/** Reveal the downloaded file in the OS file manager. */
export async function showInFolder(downloadId) {
  try {
    await chrome.downloads.show(Number(downloadId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyDownloadError(error) };
  }
}

/** Remove the file from disk (chrome.downloads.removeFile). */
export async function removeDownloadedFile(downloadId) {
  try {
    await chrome.downloads.removeFile(Number(downloadId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyDownloadError(error) };
  }
}

/** Tell the browser to forget a download entry. */
export async function eraseDownload(downloadId) {
  try {
    await chrome.downloads.erase({ id: Number(downloadId) });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: friendlyDownloadError(error) };
  }
}

function notifyComplete(entry) {
  try {
    chrome.notifications.create(`vd-done-${entry.downloadId}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
      title: 'Download complete',
      message: truncate(entry.title || entry.filename || 'Your video was saved.', 120),
      priority: 1
    });
  } catch (error) {
    console.warn('[Video Downloader] Notification failed', error);
  }
}

/** Persist and broadcast a download state change. */
async function applyDownloadDelta(delta) {
  const downloadId = Number(delta.id);
  if (!Number.isFinite(downloadId)) return;

  const historyId = await getMappedHistoryId(downloadId);
  if (!historyId) return;

  const patch = {};
  const currentState = delta.state?.current;
  const error = delta.error?.current || '';

  if (delta.bytesReceived) patch.bytesReceived = Number(delta.bytesReceived.current) || 0;
  if (delta.totalBytes) patch.totalBytes = Number(delta.totalBytes.current) || 0;
  if (delta.filename) patch.filename = delta.filename.current;
  if (error) patch.error = error;

  if (currentState === DOWNLOAD_STATES.COMPLETE) {
    patch.status = HISTORY_STATUS.COMPLETE;
    patch.completedAt = Date.now();
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item) {
        patch.filename = item.filename || patch.filename;
        patch.fileSize = Number(item.fileSize) || Number(item.totalBytes) || 0;
        patch.totalBytes = patch.fileSize || patch.totalBytes || 0;
        patch.bytesReceived = patch.totalBytes;
        patch.mime = item.mime || '';
      }
    } catch {
      // The file is already complete; metadata is nice-to-have.
    }
  } else if (currentState === DOWNLOAD_STATES.INTERRUPTED) {
    patch.status =
      error === 'USER_CANCELED' ? HISTORY_STATUS.CANCELLED : HISTORY_STATUS.FAILED;
    patch.completedAt = Date.now();
    if (!patch.error) patch.error = 'The download was interrupted.';
  } else if (currentState === DOWNLOAD_STATES.DOWNLOADING) {
    patch.status = HISTORY_STATUS.IN_PROGRESS;
  }

  if (Object.keys(patch).length === 0) return;

  // Progress events can fire dozens of times per second. Broadcast them, but
  // only write to storage once per second unless this is a terminal state.
  const now = Date.now();
  const lastWrite = downloadProgressWrites.get(downloadId) || 0;
  const isTerminal =
    patch.status === HISTORY_STATUS.COMPLETE ||
    patch.status === HISTORY_STATUS.FAILED ||
    patch.status === HISTORY_STATUS.CANCELLED;

  broadcastToPages({
    type: MSG.DOWNLOAD_UPDATE,
    downloadId,
    historyId,
    patch
  });

  if (!isTerminal && now - lastWrite < 1000) return;
  downloadProgressWrites.set(downloadId, now);

  const updated = await updateHistoryEntryByDownloadId(downloadId, patch);
  if (isTerminal) {
    downloadProgressWrites.delete(downloadId);
    await unmapDownload(downloadId);
    if (updated) {
      const eventType =
        patch.status === HISTORY_STATUS.COMPLETE
          ? 'download-completed'
          : patch.status === HISTORY_STATUS.CANCELLED
            ? 'download-cancelled'
            : 'download-failed';
      void logActivity(eventType, {
        domain: updated.pageUrl || updated.url,
        status: patch.status
      });
    }
    if (
      updated &&
      patch.status === HISTORY_STATUS.COMPLETE &&
      updated.downloadId &&
      (await getSettings()).notifyOnComplete
    ) {
      notifyComplete(updated);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Progress polling fallback                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Some Chromium builds (notably Edge) do not emit byte-level
 * chrome.downloads.onChanged events while a download is running. Poll active
 * downloads so the history page still shows live progress and the entry is
 * persisted correctly if the browser closes mid-download.
 */
let progressTimer = null;
let progressPollRunning = false;

function stopProgressPolling() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

async function pollActiveDownloads() {
  if (progressPollRunning) return;
  progressPollRunning = true;
  try {
    const history = await getHistory();
    const active = history.filter(
      (entry) =>
        entry.status === HISTORY_STATUS.IN_PROGRESS && Number(entry.downloadId) > 0
    );
    if (!active.length) {
      stopProgressPolling();
      return;
    }

    for (const entry of active) {
      const downloadId = Number(entry.downloadId);
      let item;
      try {
        [item] = await chrome.downloads.search({ id: downloadId });
      } catch {
        continue;
      }
      if (!item) {
        // The download vanished from the browser (for example the user erased
        // it). Close the stale history entry so polling can stop.
        await updateHistoryEntryByDownloadId(downloadId, {
          status: HISTORY_STATUS.FAILED,
          error: 'The download is no longer available in the browser.',
          completedAt: Date.now()
        });
        await unmapDownload(downloadId);
        void logActivity('download-failed', {
          domain: entry.pageUrl || entry.url,
          status: HISTORY_STATUS.FAILED
        });
        continue;
      }

      const unchanged =
        Number(item.bytesReceived) === Number(entry.bytesReceived || 0) &&
        Number(item.totalBytes) === Number(entry.totalBytes || 0) &&
        item.state === DOWNLOAD_STATES.DOWNLOADING;
      if (unchanged) continue;

      await applyDownloadDelta({
        id: downloadId,
        bytesReceived: { current: item.bytesReceived },
        totalBytes: { current: item.totalBytes },
        filename: { current: item.filename },
        state: { current: item.state },
        ...(item.error ? { error: { current: item.error } } : {})
      });
    }
  } catch (error) {
    console.warn('[Video Downloader] Progress polling failed', error);
  } finally {
    progressPollRunning = false;
  }
}

export function startProgressPolling() {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    void pollActiveDownloads();
  }, 1200);
  void pollActiveDownloads();
}

/** Resume polling after the service worker restarts mid-download. */
async function resumeProgressPolling() {
  try {
    const history = await getHistory();
    const active = history.filter(
      (entry) => entry.status === HISTORY_STATUS.IN_PROGRESS && Number(entry.downloadId) > 0
    );
    if (!active.length) return;

    // chrome.storage.session can be cleared by a browser restart while the
    // download itself resumes. Rebuild the id map before polling.
    for (const entry of active) {
      const downloadId = Number(entry.downloadId);
      if (!(await getMappedHistoryId(downloadId))) {
        await mapDownload(downloadId, entry.id);
      }
    }
    startProgressPolling();
  } catch {
    // Tracking will resume on the next download or state event.
  }
}

/** Register chrome.downloads listeners. Must be called from the service worker. */
export function initDownloadTracking() {
  chrome.downloads.onChanged.addListener((delta) => {
    void applyDownloadDelta(delta);
  });

  chrome.downloads.onErased.addListener((downloadId) => {
    void unmapDownload(downloadId);
  });

  void resumeProgressPolling();
}
