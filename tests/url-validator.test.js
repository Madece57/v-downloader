import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHttpUrl,
  isYouTubeUrl,
  isRestrictedUrl,
  isInjectableUrl,
  getExtension,
  getExtensionFromMime,
  detectMediaKind,
  inferMimeType,
  isStreamUrl,
  isHls,
  isDash,
  isMediaUrl,
  hasMediaExtension,
  validateMediaUrl,
  getUnsupportedPageReason,
  prettyUrl
} from '../scripts/url-validator.js';

describe('url-validator', () => {
  describe('isHttpUrl', () => {
    it('accepts http/https', () => {
      assert.equal(isHttpUrl('https://example.com/video.mp4'), true);
      assert.equal(isHttpUrl('http://example.com/video.mp4'), true);
    });
    it('rejects others', () => {
      assert.equal(isHttpUrl('ftp://example.com/video.mp4'), false);
      assert.equal(isHttpUrl('chrome://extensions'), false);
      assert.equal(isHttpUrl(''), false);
    });
  });

  describe('isYouTubeUrl', () => {
    it('recognizes YouTube pages, embeds, and media CDN URLs', () => {
      assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=abc'), true);
      assert.equal(isYouTubeUrl('https://www.youtube-nocookie.com/embed/abc'), true);
      assert.equal(isYouTubeUrl('https://youtu.be/abc'), true);
      assert.equal(isYouTubeUrl('https://rr1.googlevideo.com/videoplayback'), true);
    });
    it('does not match lookalike or unrelated hosts', () => {
      assert.equal(isYouTubeUrl('https://youtube.com.example.org/video.mp4'), false);
      assert.equal(isYouTubeUrl('https://example.com/video.mp4'), false);
      assert.equal(isYouTubeUrl('not-a-url'), false);
    });
  });

  describe('isRestrictedUrl', () => {
    it('detects restricted schemes', () => {
      assert.equal(isRestrictedUrl('chrome://settings'), true);
      assert.equal(isRestrictedUrl('chrome-extension://abc/page.html'), true);
      assert.equal(isRestrictedUrl('file:///C:/video.mp4'), true);
      assert.equal(isRestrictedUrl('about:blank'), true);
    });
    it('allows http(s)', () => {
      assert.equal(isRestrictedUrl('https://example.com/'), false);
    });
  });

  describe('isInjectableUrl', () => {
    it('true only for http(s) not restricted', () => {
      assert.equal(isInjectableUrl('https://example.com/'), true);
      assert.equal(isInjectableUrl('chrome://extensions'), false);
      assert.equal(isInjectableUrl('file:///test.mp4'), false);
    });
  });

  describe('getExtension', () => {
    it('extracts extension ignoring query/fragment', () => {
      assert.equal(getExtension('https://example.com/video.mp4?token=abc#t=10'), 'mp4');
      assert.equal(getExtension('https://example.com/playlist.m3u8'), 'm3u8');
      assert.equal(getExtension('https://example.com/audio.m4a'), 'm4a');
    });
    it('returns empty if none', () => {
      assert.equal(getExtension('https://example.com/video'), '');
      assert.equal(getExtension('not-a-url'), '');
    });
  });

  describe('getExtensionFromMime', () => {
    it('maps common mime types', () => {
      assert.equal(getExtensionFromMime('video/mp4'), 'mp4');
      assert.equal(getExtensionFromMime('application/vnd.apple.mpegurl'), 'm3u8');
      assert.equal(getExtensionFromMime('application/dash+xml'), 'mpd');
      assert.equal(getExtensionFromMime('video/mp2t'), 'ts');
    });
  });

  describe('detectMediaKind', () => {
    it('detects video/audio/stream', () => {
      assert.equal(detectMediaKind('https://example.com/video.mp4'), 'video');
      assert.equal(detectMediaKind('https://example.com/audio.mp3'), 'audio');
      assert.equal(detectMediaKind('https://example.com/playlist.m3u8'), 'stream');
      assert.equal(detectMediaKind('https://example.com/manifest.mpd'), 'stream');
    });
    it('uses mime type', () => {
      assert.equal(detectMediaKind('https://example.com/stream', 'application/vnd.apple.mpegurl'), 'stream');
      assert.equal(detectMediaKind('https://example.com/file', 'video/webm'), 'video');
    });
  });

  describe('inferMimeType', () => {
    it('returns provided mime if valid', () => {
      assert.equal(inferMimeType('https://x.com/a.mp4', 'video/mp4'), 'video/mp4');
    });
    it('infers from extension', () => {
      assert.equal(inferMimeType('https://x.com/a.webm'), 'video/webm');
      assert.equal(inferMimeType('https://x.com/a.m3u8'), 'application/vnd.apple.mpegurl');
    });
  });

  describe('isStreamUrl/isHls/isDash', () => {
    it('detects streams correctly', () => {
      assert.equal(isStreamUrl('https://x.com/playlist.m3u8'), true);
      assert.equal(isHls('https://x.com/playlist.m3u8'), true);
      assert.equal(isDash('https://x.com/manifest.mpd'), true);
    });
  });

  describe('isMediaUrl/hasMediaExtension', () => {
    it('identifies media URLs', () => {
      assert.equal(isMediaUrl('https://x.com/video.mp4'), true);
      assert.equal(isMediaUrl('https://x.com/page.html'), false);
      assert.equal(hasMediaExtension('https://x.com/audio.m4a'), true);
    });
  });

  describe('validateMediaUrl', () => {
    it('validates http mp4', () => {
      const result = validateMediaUrl('https://example.com/video.mp4');
      assert.equal(result.valid, true);
      assert.equal(result.kind, 'video');
    });
    it('rejects non-http', () => {
      const result = validateMediaUrl('file:///video.mp4');
      assert.equal(result.valid, false);
    });
    it('rejects streams when not allowed', () => {
      const result = validateMediaUrl('https://example.com/playlist.m3u8', { allowStreams: false });
      assert.equal(result.valid, false);
    });
    it('allows streams by default', () => {
      const result = validateMediaUrl('https://example.com/playlist.m3u8');
      assert.equal(result.valid, true);
      assert.equal(result.kind, 'stream');
    });
  });

  describe('getUnsupportedPageReason', () => {
    it('gives reasons for restricted pages', () => {
      assert.ok(getUnsupportedPageReason('chrome://extensions').includes('Browser'));
      assert.ok(getUnsupportedPageReason('file:///test.html').includes('Local files'));
    });
    it('returns empty for normal pages', () => {
      assert.equal(getUnsupportedPageReason('https://example.com/'), '');
    });
  });

  describe('prettyUrl', () => {
    it('formats URLs for display', () => {
      const result = prettyUrl('https://example.com/path/to/video.mp4');
      assert.ok(result.includes('example.com'));
    });
  });
});
