/**
 * Format and quality detection.
 *
 * - Parses HLS master/media playlists (regex based, so it works in a service
 *   worker where DOMParser is unavailable).
 * - Extracts basic DASH representation metadata.
 * - Produces the format option list shown in the popup.
 *
 * Adaptive manifests are marked `requiresExternal`; the extension deliberately
 * does not pretend it can mux HLS/DASH segments without a media toolchain.
 */

import {
  MIME_TYPES,
  STREAM_EXTENSIONS
} from '../utils/constants.js';
import {
  getExtension,
  inferMimeType,
  isDash,
  isHls
} from './url-validator.js';
import {
  qualityLabelFromHeight,
  resolveUrl,
  stripHash
} from '../utils/helpers.js';

/** Parse an HLS attribute list, respecting quoted values. */
export function parseAttributeList(text) {
  const raw = String(text ?? '').trim();
  const attributes = {};
  let key = '';
  let value = '';
  let inQuotes = false;
  let readingKey = true;
  const flush = () => {
    if (key) attributes[key.trim().toUpperCase()] = value.trim();
    key = '';
    value = '';
    readingKey = true;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      value += char;
    } else if (char === '=' && readingKey && !inQuotes) {
      readingKey = false;
    } else if (char === ',' && !inQuotes) {
      flush();
    } else if (readingKey) {
      key += char;
    } else {
      value += char;
    }
  }
  flush();

  for (const [attrKey, attrValue] of Object.entries(attributes)) {
    attributes[attrKey] = attrValue.replace(/^"|"$/g, '');
  }
  return attributes;
}

/** Parse the RESOLUTION attribute (e.g. "1920x1080"). */
function parseResolution(value) {
  const match = String(value ?? '').match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) return { width: 0, height: 0 };
  return { width: Number(match[1]) || 0, height: Number(match[2]) || 0 };
}

/** Return true when the playlist declares a master/variant stream. */
export function isHlsMasterPlaylist(text) {
  return /^#EXT-X-STREAM-INF:/m.test(String(text ?? ''));
}

/**
 * Parse an HLS master playlist into variant descriptions.
 * @returns {Array<{url:string,width:number,height:number,bandwidth:number,codecs:string,frameRate:number,name:string}>}
 */
export function parseHlsMaster(text, baseUrl = '') {
  const lines = String(text ?? '').split(/\r?\n/);
  const variants = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      // Trick-play playlists are not useful as download options.
      continue;
    }
    if (line.startsWith('#')) continue;

    if (pending) {
      const url = resolveUrl(line, baseUrl);
      if (url) {
        const { width, height } = parseResolution(pending.RESOLUTION);
        const bandwidth = Number(pending.BANDWIDTH) || 0;
        const frameRate = Number(pending['FRAME-RATE']) || 0;
        variants.push({
          url,
          width,
          height,
          bandwidth,
          frameRate,
          codecs: pending.CODECS || '',
          name:
            qualityLabelFromHeight(height) ||
            (bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : 'Variant')
        });
      }
      pending = null;
    }
  }

  return dedupeVariants(variants);
}

/** Remove duplicate variant URLs and sort best-first. */
export function dedupeVariants(variants) {
  const seen = new Set();
  const unique = [];
  for (const variant of variants || []) {
    if (!variant || !variant.url) continue;
    const key = stripHash(variant.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(variant);
  }
  return unique.sort((a, b) => {
    const heightDiff = (Number(b.height) || 0) - (Number(a.height) || 0);
    if (heightDiff !== 0) return heightDiff;
    return (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0);
  });
}

/**
 * Inspect an HLS media playlist.
 * @returns {{segmentCount:number,duration:number,encrypted:boolean,ended:boolean,targetDuration:number,isMaster:boolean}}
 */
export function parseHlsMedia(text) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  let segmentCount = 0;
  let duration = 0;
  let encrypted = false;
  let ended = false;
  let targetDuration = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      segmentCount += 1;
      const value = Number.parseFloat(line.slice('#EXTINF:'.length));
      if (Number.isFinite(value)) duration += value;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
      if (attrs.METHOD && attrs.METHOD.toUpperCase() !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      ended = true;
    }
  }

  return {
    segmentCount,
    duration,
    encrypted,
    ended,
    targetDuration,
    isMaster: isHlsMasterPlaylist(source)
  };
}

/**
 * Parse a DASH manifest for representation metadata.
 * Only enough information for a sensible "stream detected" card is extracted.
 */
export function parseDashManifest(text, baseUrl = '') {
  const source = String(text ?? '');
  const representations = [];
  const representationRegex = /<Representation\b([^>]*)>/gi;
  let match;
  let guard = 0;

  while ((match = representationRegex.exec(source)) !== null && guard < 100) {
    guard += 1;
    const attrs = parseAttributeList(match[1].replace(/\/$/, ''));
    const bandwidth = Number(attrs.BANDWIDTH) || 0;
    const width = Number(attrs.WIDTH) || 0;
    const height = Number(attrs.HEIGHT) || 0;
    if (!height && !bandwidth) continue;
    representations.push({
      url: baseUrl,
      width,
      height,
      bandwidth,
      codecs: attrs.CODECS || '',
      mimeType: attrs.MIMETYPE || '',
      name: qualityLabelFromHeight(height) || (bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : 'Representation')
    });
  }

  return {
    representations: dedupeVariants(representations),
    encrypted: /<ContentProtection\b/i.test(source),
    isLive: /type\s*=\s*["']dynamic["']/i.test(source)
  };
}

/** Detect container label and MIME type for a media object. */
export function detectFormat(media) {
  const url = media?.url || '';
  const mime = inferMimeType(url, media?.mime || '');
  let extension = media?.extension || getExtension(url);

  if (!extension) {
    for (const [ext, type] of Object.entries(MIME_TYPES)) {
      if (type === mime) {
        extension = ext;
        break;
      }
    }
  }

  if (extension && STREAM_EXTENSIONS.includes(extension)) {
    return {
      extension,
      mime: mime || MIME_TYPES[extension] || '',
      container: extension === 'm3u8' ? 'HLS' : 'DASH',
      streaming: true
    };
  }

  return {
    extension: extension || 'mp4',
    mime: mime || MIME_TYPES[extension] || '',
    container: extension ? extension.toUpperCase() : 'MEDIA',
    streaming: false
  };
}

/** Extract a resolution hint from a URL or label ("..._1080p.mp4"). */
export function detectQualityHint(media) {
  const candidates = [media?.title, media?.url, media?.label].filter(Boolean).join(' ');
  const match = candidates.match(/(\d{3,4})p\b/i);
  if (match) {
    const height = Number(match[1]);
    if (height >= 144 && height <= 4320) return height;
  }
  return 0;
}

/** Build the list of selectable formats for a media object. */
export function buildFormats(media) {
  if (!media || !media.url) return [];
  const info = detectFormat(media);
  const streaming = info.streaming || media.kind === 'stream';
  const baseHeight =
    Number(media.height) ||
    detectQualityHint(media) ||
    0;

  const formats = [];

  if (Array.isArray(media.variants) && media.variants.length > 0) {
    for (const variant of media.variants) {
      const height = Number(variant.height) || 0;
      const bandwidth = Number(variant.bandwidth) || 0;
      formats.push({
        id: `${media.id || 'media'}:v:${stripHash(variant.url)}`,
        url: variant.url,
        label: qualityLabelFromHeight(height) || variant.name || 'Variant',
        height,
        width: Number(variant.width) || 0,
        bandwidth,
        codecs: variant.codecs || '',
        extension: info.extension,
        mime: info.mime,
        kind: media.kind,
        container: info.container,
        type: info.extension === 'm3u8' ? 'hls' : info.extension === 'mpd' ? 'dash' : 'file',
        requiresExternal: streaming,
        encrypted: Boolean(media.encrypted),
        isDefault: false
      });
    }
  }

  if (formats.length === 0) {
    formats.push({
      id: `${media.id || 'media'}:single`,
      url: media.url,
      label: qualityLabelFromHeight(baseHeight) || (media.size ? 'Original' : 'Original'),
      height: baseHeight,
      width: Number(media.width) || 0,
      bandwidth: 0,
      codecs: '',
      extension: info.extension,
      mime: info.mime,
      kind: media.kind,
      container: info.container,
      type: streaming ? (info.extension === 'm3u8' ? 'hls' : 'dash') : 'file',
      requiresExternal: streaming,
      encrypted: Boolean(media.encrypted),
      isDefault: false
    });
  }

  // Deduplicate by URL + quality and sort best first.
  const seen = new Set();
  const unique = formats.filter((format) => {
    const key = `${stripHash(format.url)}|${format.height}|${format.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => {
    const heightDiff = (b.height || 0) - (a.height || 0);
    if (heightDiff !== 0) return heightDiff;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });

  if (unique.length > 0) unique[0].isDefault = true;
  return unique;
}

/**
 * Choose a format based on the user's default-quality preference.
 * @param {Array} formats
 * @param {object} settings
 */
export function pickDefaultFormat(formats, settings = {}) {
  const list = Array.isArray(formats) ? formats.slice() : [];
  if (list.length === 0) return null;

  const prefer = settings.preferredFormat || 'any';
  let candidates = list;

  if (prefer === 'audio') {
    const audioOnly = list.filter((format) => format.kind === 'audio');
    if (audioOnly.length) candidates = audioOnly;
  } else if (prefer !== 'any') {
    const matching = list.filter(
      (format) => String(format.extension).toLowerCase() === prefer
    );
    if (matching.length) candidates = matching;
  }

  const quality = String(settings.defaultQuality || 'best');

  if (quality === 'smallest') {
    return candidates[candidates.length - 1] || list[list.length - 1];
  }

  if (/^\d{3,4}$/.test(quality)) {
    const target = Number(quality);
    const withHeight = candidates.filter((format) => Number(format.height) > 0);
    if (withHeight.length) {
      const atOrBelow = withHeight
        .filter((format) => Number(format.height) <= target)
        .sort((a, b) => Number(b.height) - Number(a.height));
      if (atOrBelow.length) return atOrBelow[0];
      return withHeight[withHeight.length - 1];
    }
  }

  return candidates[0] || list[0];
}

/**
 * Format an HLS manifest as a small downloadable text representation.
 * Relative segment URLs are rewritten to absolute ones so the file is portable.
 */
export function absolutizeHlsPlaylist(text, baseUrl) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      return resolveUrl(trimmed, baseUrl) || line;
    })
    .join('\n');
}

/** Return a short explanation for formats that cannot be downloaded directly. */
export function externalFormatReason(format) {
  if (!format || !format.requiresExternal) return '';
  if (format.type === 'dash') {
    return 'DASH streams must be downloaded with a media tool such as yt-dlp, VLC or ffmpeg.';
  }
  if (format.encrypted) {
    return 'This stream is encrypted (DRM/AES-128) and cannot be saved as a plain file.';
  }
  return 'HLS streams need a media tool (VLC, ffmpeg or yt-dlp) to combine the segments.';
}

export { isHls, isDash };
