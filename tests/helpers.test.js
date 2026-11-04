import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatDuration,
  escapeHtml,
  clamp,
  truncate,
  sanitizeFilename,
  getDomain,
  resolveUrl,
  stripHash,
  hashString,
  createId,
  qualityLabelFromHeight,
  applyTemplate,
  mergeDefined,
  cloneJson,
  firstNonEmpty,
  percent
} from '../utils/helpers.js';

describe('helpers', () => {
  describe('formatBytes', () => {
    it('returns dash for invalid/zero', () => {
      assert.equal(formatBytes(0), '—');
      assert.equal(formatBytes(-1), '—');
      assert.equal(formatBytes(NaN), '—');
    });
    it('formats bytes', () => {
      assert.equal(formatBytes(500), '500 B');
      assert.equal(formatBytes(1024), '1 KB');
      assert.equal(formatBytes(1536), '1.5 KB');
      assert.equal(formatBytes(1024 * 1024), '1 MB');
    });
  });

  describe('formatDuration', () => {
    it('returns empty for invalid', () => {
      assert.equal(formatDuration(0), '');
      assert.equal(formatDuration(-5), '');
    });
    it('formats seconds and minutes', () => {
      assert.equal(formatDuration(5), '0:05');
      assert.equal(formatDuration(65), '1:05');
      assert.equal(formatDuration(3661), '1:01:01');
    });
  });

  describe('escapeHtml', () => {
    it('escapes special chars', () => {
      assert.equal(escapeHtml('<div>"hi"&\'x\'</div>'), '&lt;div&gt;&quot;hi&quot;&amp;&#39;x&#39;&lt;/div&gt;');
    });
  });

  describe('clamp', () => {
    it('clamps values', () => {
      assert.equal(clamp(5, 0, 10), 5);
      assert.equal(clamp(-1, 0, 10), 0);
      assert.equal(clamp(15, 0, 10), 10);
    });
  });

  describe('truncate', () => {
    it('truncates long strings', () => {
      assert.equal(truncate('hello world', 5), 'hell…');
      assert.equal(truncate('short', 10), 'short');
    });
  });

  describe('sanitizeFilename', () => {
    it('removes invalid chars', () => {
      assert.equal(sanitizeFilename('test<>:"/\\|?*.mp4'), 'test.mp4');
    });
    it('handles reserved names on Windows', () => {
      assert.equal(sanitizeFilename('CON'), '_CON');
      assert.equal(sanitizeFilename('con.txt'), '_con.txt');
    });
    it('falls back to download if empty', () => {
      assert.equal(sanitizeFilename('...'), 'download');
    });
  });

  describe('getDomain', () => {
    it('extracts domain without www', () => {
      assert.equal(getDomain('https://www.example.com/path'), 'example.com');
      assert.equal(getDomain('https://sub.example.com/'), 'sub.example.com');
    });
    it('returns fallback on error', () => {
      assert.equal(getDomain('not-a-url'), 'unknown source');
    });
  });

  describe('resolveUrl', () => {
    it('resolves relative URLs', () => {
      assert.equal(resolveUrl('/video.mp4', 'https://example.com/page/'), 'https://example.com/video.mp4');
      assert.equal(resolveUrl('video.mp4', 'https://example.com/path/'), 'https://example.com/path/video.mp4');
    });
    it('returns empty on failure', () => {
      assert.equal(resolveUrl(''), '');
    });
  });

  describe('stripHash', () => {
    it('removes fragment', () => {
      assert.equal(stripHash('https://example.com/video.mp4#t=10'), 'https://example.com/video.mp4');
    });
  });

  describe('hashString', () => {
    it('produces deterministic hash', () => {
      const h1 = hashString('test');
      const h2 = hashString('test');
      assert.equal(h1, h2);
      assert.ok(typeof h1 === 'string' && h1.length > 0);
    });
  });

  describe('createId', () => {
    it('creates id with prefix', () => {
      const id = createId('dl');
      assert.ok(id.startsWith('dl_'));
    });
  });

  describe('qualityLabelFromHeight', () => {
    it('converts heights to labels', () => {
      assert.equal(qualityLabelFromHeight(1080), '1080p');
      assert.equal(qualityLabelFromHeight(2160), '4K');
      assert.equal(qualityLabelFromHeight(1440), '1440p');
    });
  });

  describe('applyTemplate', () => {
    it('replaces tokens', () => {
      assert.equal(applyTemplate('{title} - {quality}', { title: 'My Video', quality: '1080p' }), 'My Video - 1080p');
      assert.equal(applyTemplate('{missing}', { title: 'x' }), '{missing}');
    });
  });

  describe('mergeDefined', () => {
    it('merges ignoring undefined', () => {
      const result = mergeDefined({ a: 1, b: 2 }, { b: undefined, c: 3 });
      assert.deepEqual(result, { a: 1, b: 2, c: 3 });
    });
  });

  describe('cloneJson', () => {
    it('deep clones plain objects', () => {
      const obj = { a: { b: 1 } };
      const cloned = cloneJson(obj);
      assert.deepEqual(cloned, obj);
      assert.notEqual(cloned, obj);
    });
  });

  describe('firstNonEmpty', () => {
    it('returns first non-empty string', () => {
      assert.equal(firstNonEmpty('', '  ', 'hello'), 'hello');
      assert.equal(firstNonEmpty(), '');
    });
  });

  describe('percent', () => {
    it('calculates percentage', () => {
      assert.equal(percent(50, 100), 50);
      assert.equal(percent(1, 3), 33);
      assert.equal(percent(0, 10), 0);
    });
  });
});
