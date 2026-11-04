/**
 * Shared constants for the Video Downloader extension.
 * This module is safe to import from the service worker and extension pages.
 */

export const EXTENSION_NAME = 'Video Downloader';
export const EXTENSION_VERSION = '1.1.0';
export const BUY_ME_A_COFFEE_URL = 'https://www.buymeacoffee.com/';

/** Message types used for runtime / tab communication. */
export const MSG = Object.freeze({
  // Content script -> background
  DETECTED_MEDIA: 'vd:detected-media',
  OPEN_POPUP: 'vd:open-popup',

  // Background -> content script
  GET_PAGE_MEDIA: 'vd:get-page-media',
  RESCAN_PAGE: 'vd:rescan-page',
  SET_OVERLAY: 'vd:set-overlay',

  // Popup / pages -> background
  GET_TAB_MEDIA: 'vd:get-tab-media',
  REFRESH_TAB_MEDIA: 'vd:refresh-tab-media',
  START_DOWNLOAD: 'vd:start-download',
  CANCEL_DOWNLOAD: 'vd:cancel-download',
  OPEN_DOWNLOAD: 'vd:open-download',
  SHOW_IN_FOLDER: 'vd:show-in-folder',
  REMOVE_HISTORY_ITEM: 'vd:remove-history-item',
  CLEAR_HISTORY: 'vd:clear-history',
  GET_HISTORY: 'vd:get-history',

  // Ad system
  CHECK_AD_UNLOCK: 'vd:check-ad-unlock',
  GET_AD_CREDITS: 'vd:get-ad-credits',
  REQUEST_AD: 'vd:request-ad',
  AD_WATCHED: 'vd:ad-watched',

  // Background -> extension pages
  DOWNLOAD_UPDATE: 'vd:download-update',

  // Misc
  PING: 'vd:ping'
});

/** Keys used with chrome.storage. */
export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'vd_settings',
  HISTORY: 'vd_history',
  TAB_MEDIA: 'vd_tab_media',
  DOWNLOAD_MAP: 'vd_download_map',
  ONBOARDED: 'vd_onboarded',
  ACTIVITY: 'vd_activity',
  AD_UNLOCKS: 'vd_ad_unlocks'
});

export const DEFAULT_SETTINGS = Object.freeze({
  autoDetect: true,
  showOverlay: true,
  showBadge: true,
  notifyOnComplete: true,

  downloadFolder: 'Video Downloader',
  filenameTemplate: '{title} - {quality}',
  askWhereToSave: false,
  defaultQuality: 'best',
  preferredFormat: 'any',

  theme: 'system',
  historyLimit: 300,
  supportUrl: BUY_ME_A_COFFEE_URL,
  adApiUrl: ''
});

export const SETTINGS_LIMITS = Object.freeze({
  historyLimit: { min: 20, max: 1000 },
  filenameTemplateLength: 140
});

/** Progressive video containers we can hand straight to chrome.downloads. */
export const VIDEO_EXTENSIONS = Object.freeze([
  'mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', '3gp'
]);

/** Audio containers. */
export const AUDIO_EXTENSIONS = Object.freeze([
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'oga', 'weba'
]);

/** Adaptive streaming manifests (cannot be saved as a single file natively). */
export const STREAM_EXTENSIONS = Object.freeze(['m3u8', 'mpd']);

export const MEDIA_EXTENSIONS = Object.freeze([
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...STREAM_EXTENSIONS
]);

/** Extension -> canonical MIME type. Used when a server omits Content-Type. */
export const MIME_TYPES = Object.freeze({
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  weba: 'audio/webm',
  m3u8: 'application/vnd.apple.mpegurl',
  mpd: 'application/dash+xml'
});

/**
 * URL patterns handed to chrome.webRequest. Query strings and fragments are
 * covered by the trailing wildcard. `.ts` is deliberately excluded because it
 * collides with TypeScript files; MPEG-TS requests are caught by type instead.
 */
export const MEDIA_URL_PATTERNS = Object.freeze([
  '*://*/*.mp4*',
  '*://*/*.webm*',
  '*://*/*.ogv*',
  '*://*/*.mov*',
  '*://*/*.m4v*',
  '*://*/*.mkv*',
  '*://*/*.flv*',
  '*://*/*.m3u8*',
  '*://*/*.mpd*',
  '*://*/*.m4s*',
  '*://*/*.mp3*',
  '*://*/*.m4a*',
  '*://*/*.aac*',
  '*://*/*.wav*',
  '*://*/*.flac*',
  '*://*/*.opus*',
  // YouTube patterns
  '*://*.googlevideo.com/*',
  '*://*.youtube.com/api/*',
  '*://*.ytimg.com/*',
  // TikTok patterns
  '*://*.tiktokcdn.com/*',
  '*://*.tiktokcdn-us.com/*',
  '*://*.tiktokcdn-eu.com/*',
  '*://*.tiktokv.com/*',
  '*://*.muscdn.com/*',
  '*://*.ibyteimg.com/*',
  '*://*.ibytedtos.com/*',
  '*://*.byteoversea.com/*',
  '*://*.tiktok.com/*'
]);

export const MEDIA_REQUEST_TYPES = Object.freeze([
  'media',
  'xmlhttprequest',
  'other',
  'object'
]);

export const DOWNLOAD_STATES = Object.freeze({
  DOWNLOADING: 'downloading',
  COMPLETE: 'complete',
  INTERRUPTED: 'interrupted',
  CANCELLED: 'cancelled'
});

export const HISTORY_STATUS = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const QUALITY_PRESETS = Object.freeze([
  { value: 'best', label: 'Best available' },
  { value: '2160', label: '2160p / 4K' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: 'smallest', label: 'Smallest file' }
]);

export const FORMAT_PRESETS = Object.freeze([
  { value: 'any', label: 'Any format' },
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'audio', label: 'Audio only' }
]);

export const BADGE_COLOR = '#6c5ce7';
export const BADGE_TEXT_COLOR = '#ffffff';
export const MAX_HISTORY_DEFAULT = 300;
export const MAX_HISTORY_HARD_LIMIT = 1000;
export const MAX_ACTIVITY_ENTRIES = 500;
export const MAX_TAB_MEDIA = 120;
export const MAX_NETWORK_ENTRIES_PER_TAB = 80;

/** Pages where content scripts cannot run and downloads cannot be sniffed. */
export const RESTRICTED_URL_PREFIXES = Object.freeze([
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'devtools://',
  'edge://',
  'about:',
  'moz-extension://',
  'view-source:',
  'file://'
]);

export const MEDIA_KIND = Object.freeze({
  VIDEO: 'video',
  AUDIO: 'audio',
  STREAM: 'stream'
});

export const MEDIA_SOURCE = Object.freeze({
  DOM: 'dom',
  PAGE: 'page',
  NETWORK: 'network',
  PERFORMANCE: 'performance'
});

/** Limits for network enrichment (HLS/DASH manifest fetching). */
export const ENRICHMENT = Object.freeze({
  maxManifests: 6,
  timeoutMs: 5000,
  maxManifestBytes: 2 * 1024 * 1024
});

export const AD_SETTINGS = Object.freeze({
  requireAdForDownload: true,
  adUnlockDuration: 30 * 60 * 1000, // 30 minutes
  downloadsPerAd: 10,
  maxAdsPerSession: 3
});
