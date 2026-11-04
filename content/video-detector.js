/**
 * DOM media detector (classic content script, no imports).
 *
 * Scans the page for <video>/<audio>, <source> elements, media links, OpenGraph
 * metadata, JSON-LD VideoObject entries and lazy-load data attributes. The
 * detector exposes itself as window.__VD_DETECTOR__ so content.js can use it.
 */
(() => {
  if (window.__VD_DETECTOR__) return;

  const MAX_ITEMS = 80;
  const MAX_JSONLD_NODES = 120;

  const VIDEO_EXTENSIONS = new Set([
    'mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', '3gp'
  ]);
  const AUDIO_EXTENSIONS = new Set([
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'oga', 'weba'
  ]);
  const STREAM_EXTENSIONS = new Set(['m3u8', 'mpd']);

  const DATA_ATTRIBUTES = [
    'data-video-url',
    'data-video-src',
    'data-mp4',
    'data-hls',
    'data-dash',
    'data-stream-url',
    'data-src',
    'data-video'
  ];

  function absoluteUrl(value, base) {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || /^(blob|data|javascript|about):/i.test(trimmed)) return '';
    try {
      const url = new URL(trimmed, base || location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      return url.href;
    } catch {
      return '';
    }
  }

  function extensionOf(url) {
    try {
      const match = new URL(url).pathname.match(/\.([a-z0-9]{2,6})$/i);
      return match ? match[1].toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function isLikelySegment(url) {
    const extension = extensionOf(url);
    if (extension === 'ts' || extension === 'm4s') return true;
    try {
      const path = new URL(url).pathname;
      return (
        /\/init(?:[-_][\w-]+)?\.(?:mp4|m4s|m4v)$/i.test(path) ||
        /(?:seg|segment|chunk|fragment|frag)[-_]?\d+\.(?:mp4|m4v)$/i.test(path)
      );
    } catch {
      return false;
    }
  }

  function classify(url, mime = '', fallback = '') {
    const extension = extensionOf(url);
    const type = String(mime || '').toLowerCase();
    if (STREAM_EXTENSIONS.has(extension) || type.includes('mpegurl') || type.includes('dash+xml')) {
      return 'stream';
    }
    if (type.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
    if (type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
    return fallback;
  }

  function cleanTitle(value, maxLength = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  class VideoDetector {
    constructor() {
      this.items = new Map();
      this.listeners = new Set();
      this.observer = null;
      this.scanTimer = null;
      this.started = false;
      this.pageTitle = '';
      this.thumbnail = '';
      this.lastSignature = '';
      this.eventHandler = () => this.scheduleScan();
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.scan();
      this.observe();
      document.addEventListener('loadedmetadata', this.eventHandler, true);
      document.addEventListener('durationchange', this.eventHandler, true);
      document.addEventListener('resize', this.eventHandler, true);
      document.addEventListener('play', this.eventHandler, true);
      window.addEventListener('hashchange', this.eventHandler);
      window.addEventListener('popstate', this.eventHandler);
      document.addEventListener('visibilitychange', this.eventHandler);
    }

    stop() {
      if (this.observer) this.observer.disconnect();
      this.observer = null;
      document.removeEventListener('loadedmetadata', this.eventHandler, true);
      document.removeEventListener('durationchange', this.eventHandler, true);
      document.removeEventListener('resize', this.eventHandler, true);
      document.removeEventListener('play', this.eventHandler, true);
      window.removeEventListener('hashchange', this.eventHandler);
      window.removeEventListener('popstate', this.eventHandler);
      document.removeEventListener('visibilitychange', this.eventHandler);
      this.started = false;
    }

    observe() {
      if (!document.documentElement) return;
      this.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            this.scheduleScan();
            return;
          }
          if (
            mutation.type === 'childList' &&
            (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
          ) {
            this.scheduleScan();
            return;
          }
        }
      });
      this.observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src', 'poster', ...DATA_ATTRIBUTES]
      });
    }

    scheduleScan() {
      if (this.scanTimer) return;
      this.scanTimer = setTimeout(() => {
        this.scanTimer = null;
        this.scan();
      }, 600);
    }

    onChange(callback) {
      if (typeof callback !== 'function') return () => {};
      this.listeners.add(callback);
      return () => this.listeners.delete(callback);
    }

    emit() {
      const videos = this.getVideos();
      const signature = videos
        .map(
          (item) =>
            `${item.url}|${item.height || 0}|${Math.round(item.duration || 0)}|${item.isPlaying ? 1 : 0}`
        )
        .sort()
        .join('~');
      if (signature === this.lastSignature) return;
      this.lastSignature = signature;
      for (const listener of this.listeners) {
        try {
          listener(videos);
        } catch (error) {
          console.warn('[Video Downloader] Detector listener failed', error);
        }
      }
    }

    add(candidate) {
      if (!candidate) return false;
      const url = absoluteUrl(candidate.url);
      if (!url || isLikelySegment(url)) return false;

      const kind = classify(url, candidate.mime, candidate.kind || '');
      if (!kind) return false;

      const existing = this.items.get(url);
      if (existing) {
        let changed = false;
        const isPlaying = Boolean(candidate.isPlaying);
        if (existing.isPlaying !== isPlaying) {
          existing.isPlaying = isPlaying;
          changed = true;
        }
        const numberFields = ['width', 'height', 'duration', 'size'];
        for (const field of numberFields) {
          const value = Number(candidate[field]) || 0;
          if (value > 0 && (!existing[field] || value > existing[field])) {
            existing[field] = value;
            changed = true;
          }
        }
        if (!existing.poster && candidate.poster) {
          existing.poster = absoluteUrl(candidate.poster);
          changed = true;
        }
        if ((!existing.title || existing.title === this.pageTitle) && candidate.title) {
          existing.title = cleanTitle(candidate.title);
          changed = true;
        }
        if (changed) existing.updatedAt = Date.now();
        return changed;
      }

      const item = {
        url,
        kind,
        type: STREAM_EXTENSIONS.has(extensionOf(url))
          ? extensionOf(url) === 'm3u8'
            ? 'hls'
            : 'dash'
          : 'file',
        extension: extensionOf(url),
        mime: String(candidate.mime || ''),
        title: cleanTitle(candidate.title || this.pageTitle || 'Untitled media'),
        pageTitle: this.pageTitle,
        pageUrl: location.href,
        poster: absoluteUrl(candidate.poster || this.thumbnail),
        duration: Number(candidate.duration) || 0,
        width: Number(candidate.width) || 0,
        height: Number(candidate.height) || 0,
        size: Number(candidate.size) || 0,
        isPlaying: Boolean(candidate.isPlaying),
        source: candidate.source || 'dom',
        foundAt: Date.now(),
        updatedAt: Date.now()
      };

      this.items.set(url, item);
      if (this.items.size > MAX_ITEMS) {
        const oldest = [...this.items.entries()]
          .sort((a, b) => (a[1].foundAt || 0) - (b[1].foundAt || 0))
          .slice(0, this.items.size - MAX_ITEMS);
        for (const [key] of oldest) this.items.delete(key);
      }
      return true;
    }

    scan() {
      if (!this.started || !document.documentElement) return;
      for (const item of this.items.values()) item.isPlaying = false;
      const previousTitle = this.pageTitle;
      this.pageTitle = cleanTitle(
        document.querySelector('meta[property="og:title"]')?.content ||
          document.title ||
          location.hostname,
        180
      );
      this.thumbnail = absoluteUrl(
        document.querySelector('meta[property="og:image"]')?.content || ''
      );

      if (previousTitle && previousTitle !== this.pageTitle) {
        // Keep page title in sync for items detected earlier (e.g. SPA routes).
        for (const item of this.items.values()) {
          if (!item.title || item.title === previousTitle) item.title = this.pageTitle;
          item.pageTitle = this.pageTitle;
          item.pageUrl = location.href;
        }
      }

      const scanSteps = [
        () => this.scanMediaElements(),
        () => this.scanSourceElements(),
        () => this.scanLinks(),
        () => this.scanMetaTags(),
        () => this.scanJsonLd(),
        () => this.scanTikTokEmbeddedData(),
        () => this.scanDataAttributes(),
        () => this.scanPerformanceEntries()
      ];

      for (const step of scanSteps) {
        try {
          step();
        } catch (error) {
          // A broken page should never break detection of the remaining sources.
          console.debug('[Video Downloader] scan step skipped', error);
        }
      }

      this.emit();
    }

    scanMediaElements() {
      const elements = document.querySelectorAll('video, audio');
      for (const element of elements) {
        const isAudio = element.tagName === 'AUDIO';
        const title =
          element.getAttribute('title') ||
          element.getAttribute('aria-label') ||
          '';
        const poster = element.getAttribute('poster') || '';
        const duration =
          Number.isFinite(element.duration) && element.duration > 0
            ? element.duration
            : 0;
        const width = isAudio ? 0 : Number(element.videoWidth) || 0;
        const height = isAudio ? 0 : Number(element.videoHeight) || 0;

        const candidates = [];
        if (element.currentSrc) candidates.push({ url: element.currentSrc, mime: '' });
        if (element.getAttribute('src')) {
          candidates.push({ url: element.getAttribute('src'), mime: '' });
        }
        for (const source of element.querySelectorAll('source[src]')) {
          candidates.push({
            url: source.getAttribute('src'),
            mime: source.getAttribute('type') || ''
          });
        }

        for (const candidate of candidates) {
          this.add({
            ...candidate,
            kind: isAudio ? 'audio' : 'video',
            isPlaying: !isAudio && !element.paused && !element.ended,
            title,
            poster,
            duration,
            width,
            height,
            source: 'dom'
          });
        }
      }
    }

    scanSourceElements() {
      // <source> elements are normally inside <video>/<audio> and handled above.
      // This catches players that keep them detached or inside <picture> wrappers.
      const sources = document.querySelectorAll(
        'source[src][type^="video/"], source[src][type^="audio/"], source[src][type*="mpegurl"]'
      );
      for (const source of sources) {
        const mime = source.getAttribute('type') || '';
        this.add({
          url: source.getAttribute('src'),
          mime,
          kind: classify(source.getAttribute('src'), mime),
          title: source.getAttribute('title') || '',
          poster: source.getAttribute('poster') || '',
          source: 'dom'
        });
      }
    }

    scanLinks() {
      const links = document.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;
        const url = absoluteUrl(href);
        if (!url) continue;
        const extension = extensionOf(url);
        if (
          !VIDEO_EXTENSIONS.has(extension) &&
          !AUDIO_EXTENSIONS.has(extension) &&
          !STREAM_EXTENSIONS.has(extension)
        ) {
          continue;
        }
        if (isLikelySegment(url)) continue;

        const text = cleanTitle(link.textContent || link.getAttribute('title') || '', 140);
        this.add({
          url,
          kind: classify(url),
          title: text || this.pageTitle,
          poster: link.querySelector('img')?.getAttribute('src') || '',
          source: 'dom'
        });
      }
    }

    scanMetaTags() {
      const selectors = [
        'meta[property="og:video"]',
        'meta[property="og:video:url"]',
        'meta[property="og:video:secure_url"]',
        'meta[property="og:audio"]',
        'meta[property="og:audio:url"]',
        'meta[property="og:audio:secure_url"]',
        'meta[name="twitter:player:stream"]',
        'meta[itemprop="contentUrl"]',
        'link[rel="preload"][as="video"]',
        'link[rel="preload"][as="audio"]',
        'link[rel="alternate"][type^="video/"]',
        'link[rel="alternate"][type^="audio/"]'
      ];

      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          const url =
            element.getAttribute('content') ||
            element.getAttribute('href') ||
            element.getAttribute('src');
          if (!url) continue;
          const mime =
            element.getAttribute('type') ||
            element.getAttribute('content-type') ||
            '';
          const kind = classify(url, mime, selector.includes('audio') ? 'audio' : 'video');
          if (!kind) continue;
          this.add({
            url,
            mime,
            kind,
            title: this.pageTitle,
            poster:
              document.querySelector('meta[property="og:image"]')?.content || '',
            source: 'page'
          });
        }
      }
    }

    scanJsonLd() {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      let budget = MAX_JSONLD_NODES;

      const visit = (node, depth) => {
        if (!node || typeof node !== 'object' || budget <= 0 || depth > 6) return;
        budget -= 1;

        if (Array.isArray(node)) {
          for (const entry of node) visit(entry, depth + 1);
          return;
        }

        const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : node['@type'];
        const isVideo = /video/i.test(String(type || ''));
        const isAudio = /audio/i.test(String(type || ''));

        if (isVideo || isAudio) {
          const fallback = isAudio ? 'audio' : 'video';
          const urls = [
            { value: node.contentUrl, trusted: true },
            { value: node.url, trusted: false }
          ].filter((entry) => typeof entry.value === 'string');

          // Only keep values that look like actual media, not embed pages or
          // poster images. contentUrl is declared media, so it may omit an
          // extension and rely on the declared type.
          for (const entry of urls) {
            const url = absoluteUrl(entry.value);
            if (!url) continue;
            const kind = classify(url, '', entry.trusted ? fallback : '');
            if (!kind) continue;
            this.add({
              url,
              kind,
              title: cleanTitle(node.name || this.pageTitle),
              poster: absoluteUrl(node.thumbnailUrl || ''),
              duration:
                typeof node.duration === 'string'
                  ? this.parseIsoDuration(node.duration)
                  : Number(node.duration) || 0,
              source: 'page'
            });
          }
        }

        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') visit(value, depth + 1);
        }
      };

      for (const script of scripts) {
        if (budget <= 0) break;
        try {
          const data = JSON.parse(script.textContent || '');
          visit(data, 0);
        } catch {
          // Invalid JSON-LD is common; ignore it.
        }
      }
    }

    scanTikTokEmbeddedData() {
      if (!/(\.|^)tiktok\.com$/i.test(location.hostname)) return;
      const scripts = [...document.querySelectorAll('script')].filter((script) => {
        const id = String(script.id || '').toUpperCase();
        const knownState = id.includes('UNIVERSAL') || id.includes('SIGI_STATE');
        const text = script.textContent || '';
        return (
          knownState ||
          (script.type === 'application/json' && /"play_?addr"|"download_?addr"/i.test(text))
        );
      });
      let budget = 5000;
      const activeVideoId = location.pathname.match(/\/video\/(\d+)/i)?.[1] || '';

      const addressList = (value) => {
        if (typeof value === 'string') return [value];
        if (Array.isArray(value)) return value.slice(0, 10).flatMap(addressList);
        if (!value || typeof value !== 'object') return [];
        return [value.url, value.urlList, value.url_list, value.Url, value.UrlList]
          .filter(Boolean)
          .flatMap(addressList);
      };

      const visit = (node, depth = 0, context = {}) => {
        if (!node || typeof node !== 'object' || budget <= 0 || depth > 12) return;
        budget -= 1;
        if (Array.isArray(node)) {
          for (const entry of node) visit(entry, depth + 1, context);
          return;
        }

        const nextContext = {
          title: cleanTitle(node.desc || node.name || node.title || context.title || this.pageTitle),
          poster: node.cover || node.originCover || node.thumbnailUrl || context.poster || '',
          duration: Number(node.duration) || context.duration || 0,
          isPlaying:
            Boolean(context.isPlaying) ||
            Boolean(activeVideoId && String(node.id || '') === activeVideoId)
        };
        if (node.video && typeof node.video === 'object') {
          const video = node.video;
          const addresses = addressList(
            video.playAddr || video.play_addr || video.playAddress || video.play_address
          );
          const urls = addresses.length
            ? addresses
            : addressList(
                video.downloadAddr ||
                  video.download_addr ||
                  video.downloadAddress ||
                  video.download_address
              );
          for (const value of urls.slice(0, 4)) {
            const url = absoluteUrl(value);
            if (!url) continue;
            this.add({
              url,
              mime: 'video/mp4',
              kind: 'video',
              title: nextContext.title,
              poster: nextContext.poster,
              duration: Number(video.duration) || nextContext.duration,
              width: Number(video.width) || 0,
              height: Number(video.height) || 0,
              isPlaying: nextContext.isPlaying,
              source: 'page'
            });
          }
        }

        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') visit(value, depth + 1, nextContext);
        }
      };

      for (const script of scripts) {
        if (budget <= 0) break;
        const text = script.textContent || '';
        if (!text || text.length > 2 * 1024 * 1024) continue;
        try {
          visit(JSON.parse(text));
        } catch {
          // Ignore invalid embedded state and continue scanning other sources.
        }
      }
    }

    parseIsoDuration(value) {
      const match = String(value || '').match(
        /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
      );
      if (!match) return 0;
      const days = Number(match[1]) || 0;
      const hours = Number(match[2]) || 0;
      const minutes = Number(match[3]) || 0;
      const seconds = Number(match[4]) || 0;
      return days * 86400 + hours * 3600 + minutes * 60 + seconds;
    }

    scanDataAttributes() {
      const selector = DATA_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(', ');
      const elements = document.querySelectorAll(selector);
      let count = 0;

      for (const element of elements) {
        if (count >= 40) break;
        for (const attribute of DATA_ATTRIBUTES) {
          const value = element.getAttribute(attribute);
          if (!value) continue;
          const url = absoluteUrl(value);
          if (!url) continue;
          const mime = element.getAttribute('data-type') || element.getAttribute('type') || '';
          const kind = classify(url, mime);
          if (!kind) continue;

          this.add({
            url,
            mime,
            kind,
            title:
              element.getAttribute('title') ||
              element.getAttribute('aria-label') ||
              this.pageTitle,
            poster: element.getAttribute('poster') || '',
            source: 'dom'
          });
          count += 1;
        }
      }
    }

    scanPerformanceEntries() {
      if (typeof performance === 'undefined' || !performance.getEntriesByType) return;
      let entries;
      try {
        entries = performance.getEntriesByType('resource');
      } catch {
        return;
      }

      const recent = entries.slice(-150);
      for (const entry of recent) {
        const url = entry.name;
        if (!url || !/^https?:/i.test(url)) continue;
        const extension = extensionOf(url);
        const isMediaInitiator =
          entry.initiatorType === 'video' || entry.initiatorType === 'audio';
        if (!isMediaInitiator && !extension) continue;
        // Trust the initiator only for extensionless URLs. A <video poster>
        // image is also attributed to a "video" initiator, but it has an
        // extension (jpg/png/svg) and classify() rejects it.
        const kind = classify(url, '', !extension && isMediaInitiator ? entry.initiatorType : '');
        if (!kind) continue;

        this.add({
          url,
          kind,
          title: this.pageTitle,
          source: 'performance'
        });
      }
    }

    rescan({ clear = false } = {}) {
      if (clear) {
        this.items.clear();
        this.lastSignature = '';
      }
      this.scan();
      return this.getVideos();
    }

    getVideos() {
      return [...this.items.values()].sort((a, b) => {
        if (Boolean(a.isPlaying) !== Boolean(b.isPlaying)) {
          return a.isPlaying ? -1 : 1;
        }
        const rank = { video: 0, stream: 1, audio: 2 };
        const diff = (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9);
        if (diff !== 0) return diff;
        return (b.height || 0) - (a.height || 0);
      });
    }

    get count() {
      return this.items.size;
    }
  }

  const detector = new VideoDetector();
  window.__VD_DETECTOR__ = detector;
})();
