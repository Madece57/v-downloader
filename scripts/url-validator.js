/**
 * URL validation and media classification.
 * Shared by the service worker, popup and options pages.
 */

import {
  AUDIO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MIME_TYPES,
  RESTRICTED_URL_PREFIXES,
  STREAM_EXTENSIONS,
  VIDEO_EXTENSIONS
} from '../utils/constants.js';
import { resolveUrl, stripHash } from '../utils/helpers.js';

const VIDEO_EXTENSION_SET = new Set(VIDEO_EXTENSIONS);
const AUDIO_EXTENSION_SET = new Set(AUDIO_EXTENSIONS);
const STREAM_EXTENSION_SET = new Set(STREAM_EXTENSIONS);
const MEDIA_EXTENSION_SET = new Set(MEDIA_EXTENSIONS);

const HLS_MIME_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
  'vnd.apple.mpegurl'
]);

const DASH_MIME_TYPES = new Set(['application/dash+xml', 'application/xml']);

/** True when the URL uses http: or https:. */
export function isHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when a URL belongs to YouTube or its video delivery CDN. */
export function isYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ['youtube.com', 'youtube-nocookie.com', 'youtu.be', 'googlevideo.com'].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/** True for about:, chrome:, data:, blob:, javascript: and friends. */
export function isRestrictedUrl(url) {
  const value = String(url ?? '').toLowerCase();
  if (!value) return true;
  return RESTRICTED_URL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** True when scripts can be injected into the page. */
export function isInjectableUrl(url) {
  return isHttpUrl(url) && !isRestrictedUrl(url);
}

/**
 * Extract a lowercase file extension from the pathname.
 * Query strings are ignored, so `.mp4?token=1` becomes `mp4`.
 */
export function getExtension(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const { pathname } = new URL(url, 'https://example.invalid');
    const match = pathname.match(/\.([a-z0-9]{2,6})$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    const clean = String(url).split(/[?#]/)[0];
    const match = clean.match(/\.([a-z0-9]{2,6})$/i);
    return match ? match[1].toLowerCase() : '';
  }
}

/** Normalize the extension (or path) of a MIME type. */
export function getExtensionFromMime(mime) {
  const type = String(mime ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!type) return '';
  if (type === 'video/mp2t') return 'ts';
  if (HLS_MIME_TYPES.has(type)) return 'm3u8';
  if (type === 'application/dash+xml') return 'mpd';
  for (const [extension, mimeType] of Object.entries(MIME_TYPES)) {
    if (mimeType === type) return extension;
  }
  return '';
}

/** Guess whether a URL/mime pair describes video, audio or a stream. */
export function detectMediaKind(url, mime = '') {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  const extension = getExtension(url) || getExtensionFromMime(type);

  if (STREAM_EXTENSION_SET.has(extension) || HLS_MIME_TYPES.has(type) || DASH_MIME_TYPES.has(type)) {
    return 'stream';
  }
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (AUDIO_EXTENSION_SET.has(extension)) return 'audio';
  if (VIDEO_EXTENSION_SET.has(extension)) return 'video';
  if (type.startsWith('application/ogg') || type === 'application/octet-stream') return '';
  return '';
}

/** Return the canonical MIME type inferred from a URL, if any. */
export function inferMimeType(url, mime = '') {
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (type) return type;
  const extension = getExtension(url);
  return MIME_TYPES[extension] || '';
}

/** True when the URL ends in a streaming manifest extension. */
export function isStreamUrl(url, mime = '') {
  return detectMediaKind(url, mime) === 'stream';
}

/** True when the URL looks like an HLS manifest. */
export function isHls(url, mime = '') {
  if (!url) return false;
  const extension = getExtension(url);
  if (extension === 'm3u8') return true;
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return HLS_MIME_TYPES.has(type);
}

/** True when the URL looks like a DASH manifest. */
export function isDash(url, mime = '') {
  if (!url) return false;
  if (getExtension(url) === 'mpd') return true;
  return String(mime ?? '').split(';')[0].trim().toLowerCase() === 'application/dash+xml';
}

/** True when the URL's extension or MIME type is a known media type. */
export function isMediaUrl(url, mime = '') {
  if (!isHttpUrl(url)) return false;
  if (getExtension(url) || mime) {
    return Boolean(detectMediaKind(url, mime));
  }
  return false;
}

/** True when the URL pathname ends in a known media extension. */
export function hasMediaExtension(url) {
  return MEDIA_EXTENSION_SET.has(getExtension(url));
}

/**
 * Validate that a URL can be downloaded.
 * @returns {{valid: boolean, reason?: string, url?: string, kind?: string, extension?: string, mime?: string}}
 */
export function validateMediaUrl(rawUrl, options = {}) {
  const { allowStreams = true, baseUrl, mime = '', kind: kindHint = '' } = options;
  const resolved = resolveUrl(rawUrl, baseUrl);

  if (!resolved) {
    return { valid: false, reason: 'This URL is not valid.' };
  }
  if (!isHttpUrl(resolved)) {
    return {
      valid: false,
      reason: 'Only http and https links can be downloaded.'
    };
  }

  const detectedKind = detectMediaKind(resolved, mime);
  const kind =
    detectedKind ||
    (['video', 'audio', 'stream'].includes(kindHint) ? kindHint : '');
  const extension = getExtension(resolved) || getExtensionFromMime(inferMimeType(resolved, mime));

  if (!kind) {
    return {
      valid: false,
      reason: 'The link does not point to a known media file.'
    };
  }
  if (kind === 'stream' && !allowStreams) {
    return {
      valid: false,
      reason: 'Streaming manifests cannot be saved as a single file.'
    };
  }

  return {
    valid: true,
    url: stripHash(resolved),
    kind,
    extension,
    mime: inferMimeType(resolved, mime)
  };
}

/** Human-readable reason why a page cannot be inspected. */
export function getUnsupportedPageReason(url) {
  const value = String(url ?? '');
  if (!value) return 'This tab does not expose a URL.';
  if (value.startsWith('chrome://') || value.startsWith('edge://')) {
    return 'Browser settings pages cannot be inspected. Open a regular website.';
  }
  if (value.startsWith('chrome-extension://')) {
    return 'Extension pages cannot be inspected.';
  }
  if (value.startsWith('file://')) {
    return 'Local files cannot be inspected. Enable file access for this extension first.';
  }
  if (value.startsWith('view-source:')) {
    return 'View-source pages cannot be inspected.';
  }
  if (value.startsWith('about:')) {
    return 'Browser pages cannot be inspected.';
  }
  return '';
}

/** Trim a URL for display, keeping the hostname and final path segment. */
export function prettyUrl(url, maxLength = 64) {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).split('/').filter(Boolean).pop() || '/';
    const text = `${parsed.hostname}/${path}${parsed.search ? '…' : ''}`;
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  } catch {
    return String(url ?? '');
  }
}
