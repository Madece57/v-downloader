/**
 * Normalizes media discovered by content scripts and the network sniffer.
 * Every media object in the extension flows through normalizeMedia() so the UI
 * can rely on a single, predictable shape.
 */

import { MEDIA_KIND, MEDIA_SOURCE } from '../utils/constants.js';
import {
  detectMediaKind,
  getExtension as getUrlExtension,
  inferMimeType,
  isDash,
  isHls,
  isHttpUrl
} from './url-validator.js';
import { buildFormats } from './format-detector.js';
import {
  getDomain,
  hashString,
  resolveUrl,
  stripHash,
  truncate
} from '../utils/helpers.js';

const KIND_RANK = {
  [MEDIA_KIND.VIDEO]: 0,
  [MEDIA_KIND.STREAM]: 1,
  [MEDIA_KIND.AUDIO]: 2
};

/** Build a deterministic id from a media URL. */
export function createMediaId(url) {
  return `m_${hashString(stripHash(url))}`;
}

/** Derive a readable title from a file name in a URL. */
export function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const decoded = decodeURIComponent(last);
    const withoutExtension = decoded.replace(/\.[a-z0-9]{2,6}$/i, '');
    return withoutExtension.replace(/[_-]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function isFallbackTitle(title, media) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized || normalized === 'untitled media') return true;
  return [media.pageTitle, titleFromUrl(media.url)].some(
    (fallback) => fallback && normalized === String(fallback).trim().toLowerCase()
  );
}

/** Normalize an HLS/DASH variant list. */
function normalizeVariants(variants, baseUrl) {
  if (!Array.isArray(variants)) return [];
  const result = [];
  const seen = new Set();
  for (const variant of variants) {
    const url = resolveUrl(variant?.url, baseUrl);
    if (!url || !isHttpUrl(url)) continue;
    const key = stripHash(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      url,
      width: Number(variant.width) || 0,
      height: Number(variant.height) || 0,
      bandwidth: Number(variant.bandwidth) || 0,
      frameRate: Number(variant.frameRate) || 0,
      codecs: String(variant.codecs || ''),
      name: String(variant.name || '')
    });
  }
  return result;
}

/**
 * Convert a loose detection payload into the canonical media shape.
 * Invalid URLs are dropped (returns null).
 */
export function normalizeMedia(raw, context = {}) {
  if (!raw) return null;

  const pageUrl = raw.pageUrl || context.pageUrl || '';
  const url = resolveUrl(raw.url, pageUrl || context.baseUrl);
  if (!url || !isHttpUrl(url)) return null;

  const mime = inferMimeType(url, raw.mime || '');
  const detectedKind = detectMediaKind(url, mime);
  const kind =
    raw.kind && Object.values(MEDIA_KIND).includes(raw.kind)
      ? raw.kind
      : detectedKind || MEDIA_KIND.VIDEO;

  const hls = isHls(url, mime);
  const dash = isDash(url, mime);
  const streaming = kind === MEDIA_KIND.STREAM || hls || dash;

  const variants = normalizeVariants(raw.variants, url);
  const width = Math.max(0, Number(raw.width) || 0);
  const height = Math.max(0, Number(raw.height) || 0);
  const duration = Math.max(0, Number(raw.duration) || 0);
  const size = Math.max(0, Number(raw.size) || 0);

  const title =
    truncate(raw.title || context.pageTitle || titleFromUrl(url) || 'Untitled media', 180);

  const media = {
    id: createMediaId(url),
    url: stripHash(url),
    kind,
    type: hls ? 'hls' : dash ? 'dash' : 'file',
    extension: getUrlExtension(url) || '',
    mime,
    title,
    pageTitle: truncate(raw.pageTitle || context.pageTitle || '', 180),
    pageUrl: pageUrl || '',
    domain: getDomain(pageUrl || url),
    poster: resolveUrl(raw.poster || '', pageUrl || url),
    duration,
    width,
    height,
    size,
    isPlaying: Boolean(raw.isPlaying),
    variants,
    encrypted: Boolean(raw.encrypted),
    requiresExternal: streaming,
    source: raw.source || context.source || MEDIA_SOURCE.DOM,
    sources: Array.isArray(raw.sources) ? raw.sources.slice(0, 5) : undefined,
    foundAt: Number(raw.foundAt) || Date.now()
  };

  if (!media.extension) {
    media.extension = hls ? 'm3u8' : dash ? 'mpd' : 'mp4';
  }
  if (!media.sources) media.sources = [media.source];

  media.formats = buildFormats(media);
  return media;
}

/** Merge metadata from `incoming` into `existing` without losing data. */
function mergeTwo(existing, incoming) {
  const merged = { ...existing };
  if (incoming.source !== MEDIA_SOURCE.NETWORK) {
    merged.isPlaying = Boolean(incoming.isPlaying);
  }

  if (
    incoming.title &&
    isFallbackTitle(merged.title, merged) &&
    !isFallbackTitle(incoming.title, incoming)
  ) {
    merged.title = incoming.title;
  }
  if (!merged.poster && incoming.poster) merged.poster = incoming.poster;
  if (!merged.duration && incoming.duration) merged.duration = incoming.duration;
  if (!merged.width && incoming.width) merged.width = incoming.width;
  if (!merged.height && incoming.height) merged.height = incoming.height;
  if (!merged.size && incoming.size) merged.size = incoming.size;
  if (!merged.mime && incoming.mime) merged.mime = incoming.mime;
  if (!merged.pageTitle && incoming.pageTitle) merged.pageTitle = incoming.pageTitle;
  if (!merged.pageUrl && incoming.pageUrl) merged.pageUrl = incoming.pageUrl;
  if (!merged.domain && incoming.domain) merged.domain = incoming.domain;
  merged.encrypted = Boolean(merged.encrypted || incoming.encrypted);

  const variants = normalizeVariants(
    [...(existing.variants || []), ...(incoming.variants || [])],
    merged.url
  );
  merged.variants = variants;

  const sources = new Set([
    ...(Array.isArray(existing.sources) ? existing.sources : [existing.source]),
    incoming.source
  ]);
  merged.sources = [...sources].filter(Boolean);

  // Prefer the richer page/DOM record as the primary source.
  if (existing.source === MEDIA_SOURCE.NETWORK && incoming.source !== MEDIA_SOURCE.NETWORK) {
    merged.source = incoming.source;
  }

  merged.formats = buildFormats(merged);
  return merged;
}

/**
 * Merge multiple detection lists into one deduplicated list.
 * Later lists fill in missing metadata from earlier ones.
 */
export function mergeMediaLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const media = item && item.id && item.formats ? item : normalizeMedia(item);
      if (!media) continue;
      const key = stripHash(media.url);
      const existing = map.get(key);
      map.set(key, existing ? mergeTwo(existing, media) : media);
    }
  }
  return sortMedia([...map.values()]);
}

/** Sort videos first, then streams, then audio; best quality first inside groups. */
export function sortMedia(list) {
  return (Array.isArray(list) ? list : []).sort((a, b) => {
    if (Boolean(a.isPlaying) !== Boolean(b.isPlaying)) {
      return a.isPlaying ? -1 : 1;
    }
    const rankDiff =
      (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    const heightDiff = (b.height || 0) - (a.height || 0);
    if (heightDiff !== 0) return heightDiff;
    const sizeDiff = (b.size || 0) - (a.size || 0);
    if (sizeDiff !== 0) return sizeDiff;
    return String(a.title).localeCompare(String(b.title));
  });
}

/** Keep only media whose URL belongs to the tab that reported it. */
export function filterPlayableMedia(list) {
  return (Array.isArray(list) ? list : []).filter(
    (media) => media && isHttpUrl(media.url) && media.kind
  );
}

/** Build a light-weight snapshot for the download history. */
export function toHistoryMedia(media) {
  return {
    url: media.url,
    title: media.title,
    pageUrl: media.pageUrl,
    pageTitle: media.pageTitle,
    poster: media.poster,
    domain: media.domain || getDomain(media.url),
    kind: media.kind,
    type: media.type,
    extension: media.extension,
    duration: media.duration,
    width: media.width,
    height: media.height,
    size: media.size
  };
}

/** Summarize a list for badges/UI headers. */
export function summarizeMedia(list) {
  const videos = list.filter((media) => media.kind === MEDIA_KIND.VIDEO).length;
  const audio = list.filter((media) => media.kind === MEDIA_KIND.AUDIO).length;
  const streams = list.filter((media) => media.kind === MEDIA_KIND.STREAM).length;
  return { total: list.length, videos, audio, streams };
}

/**
 * Validate a raw media payload arriving from a UI message.
 * @returns {{ok:boolean, media?:object, error?:string}}
 */
export function parseIncomingMedia(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Missing media information.' };
  }
  const media = normalizeMedia(payload);
  if (!media) {
    return { ok: false, error: 'This media URL is not valid.' };
  }
  return { ok: true, media };
}
