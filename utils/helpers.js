/**
 * Small, dependency-free helpers shared by the service worker and UI pages.
 * Nothing in this file touches the DOM or Node APIs.
 */

/** Format a byte count for display. */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(size)} ${units[unit]}`;
  if (Math.abs(size - Math.round(size)) < 1e-9) {
    return `${Math.round(size)} ${units[unit]}`;
  }
  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  let formatted = size.toFixed(precision);
  // Trim trailing zeros after decimal point
  formatted = formatted.replace(/\.?0+$/, '');
  return `${formatted} ${units[unit]}`;
}

/** Format seconds as H:MM:SS or M:SS. */
export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Format a timestamp as a short, locale-aware date/time. */
export function formatDateTime(timestamp, locale) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** Human-friendly relative time, e.g. "5 minutes ago". */
export function timeAgo(timestamp, locale) {
  const then = Number(timestamp);
  if (!Number.isFinite(then)) return '—';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const units = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['week', 604800000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000]
  ];
  try {
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, ms] of units) {
      if (abs >= ms) {
        return formatter.format(-Math.round(diff / ms), unit);
      }
    }
    return formatter.format(0, 'second');
  } catch {
    return formatDateTime(then, locale);
  }
}

/** Escape text for safe insertion into innerHTML templates. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Clamp a number between min and max. */
export function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

/** Debounce a function. */
export function debounce(fn, wait = 250) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

/** Throttle a function (trailing call is kept). */
export function throttle(fn, wait = 250) {
  let last = 0;
  let timer = null;
  return function throttled(...args) {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

/** Truncate a string without breaking the middle of a word. */
export function truncate(value, maxLength = 80) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Sanitize a string so it can be used as a file or folder name. */
export function sanitizeFilename(name, maxLength = 120) {
  let safe = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!safe) safe = 'download';
  if (safe.length > maxLength) {
    safe = safe.slice(0, maxLength).trim();
  }
  // Windows reserved device names.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safe)) {
    safe = `_${safe}`;
  }
  return safe;
}

/** Return the hostname of a URL, or a fallback label. */
export function getDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return 'unknown source';
  }
}

/** Resolve a possibly-relative URL against a base URL. Returns '' on failure. */
export function resolveUrl(url, baseUrl) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, baseUrl || undefined).href;
  } catch {
    return '';
  }
}

/** Remove the fragment from a URL for deduplication purposes. */
export function stripHash(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url ?? '');
  }
}

/** Stable, short hash used to build deterministic media ids. */
export function hashString(input) {
  let hash = 5381;
  const text = String(input ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Create a unique id with an optional prefix. */
export function createId(prefix = 'id') {
  let random = '';
  try {
    random = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  } catch {
    random = Math.random().toString(36).slice(2, 14);
  }
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/** Build a label such as "1080p" from a height. */
export function qualityLabelFromHeight(height) {
  const value = Number(height);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 2000) return '4K';
  if (value >= 1400) return '1440p';
  return `${Math.round(value)}p`;
}

/** Replace {token} placeholders in a template. Unknown tokens are kept. */
export function applyTemplate(template, variables) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      const value = variables[key];
      return value === undefined || value === null ? '' : String(value);
    }
    return match;
  });
}

/** Shallow merge that ignores undefined values. */
export function mergeDefined(base, patch) {
  const result = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Deep-ish clone for plain JSON data. */
export function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/** Read the first non-empty string from a list of candidates. */
export function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Promise that resolves after the given number of milliseconds. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a promise with a timeout. Rejects with a descriptive error. */
export function withTimeout(promise, ms, label = 'Operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Format a numeric value as a percentage between 0 and 100. */
export function percent(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return clamp(Math.round((p / t) * 100), 0, 100);
}
