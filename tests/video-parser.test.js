import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMediaLists, normalizeMedia, sortMedia } from '../scripts/video-parser.js';

describe('video-parser media titles', () => {
  it('prefers a specific video title over a generic page title', () => {
    const generic = normalizeMedia({
      url: 'https://cdn.example.com/playback/video.mp4',
      title: 'TikTok - Make Your Day',
      pageTitle: 'TikTok - Make Your Day',
      pageUrl: 'https://www.tiktok.com/@creator/video/123',
      source: 'network'
    });
    const specific = normalizeMedia({
      url: 'https://cdn.example.com/playback/video.mp4',
      title: 'A video with its actual title',
      pageTitle: 'TikTok - Make Your Day',
      pageUrl: 'https://www.tiktok.com/@creator/video/123',
      source: 'page'
    });

    const [merged] = mergeMediaLists([generic], [specific]);
    assert.equal(merged.title, 'A video with its actual title');
  });

  it('keeps a specific title when a generic title is merged later', () => {
    const specific = normalizeMedia({
      url: 'https://cdn.example.com/playback/video.mp4',
      title: 'A video with its actual title',
      pageTitle: 'TikTok - Make Your Day',
      pageUrl: 'https://www.tiktok.com/@creator/video/123',
      source: 'page'
    });
    const generic = normalizeMedia({
      url: 'https://cdn.example.com/playback/video.mp4',
      title: 'TikTok - Make Your Day',
      pageTitle: 'TikTok - Make Your Day',
      pageUrl: 'https://www.tiktok.com/@creator/video/123',
      source: 'network'
    });

    const [merged] = mergeMediaLists([specific], [generic]);
    assert.equal(merged.title, 'A video with its actual title');
  });

  it('sorts the currently playing video before higher-resolution media', () => {
    const playing = normalizeMedia({
      url: 'https://cdn.example.com/current.mp4',
      title: 'Currently playing',
      kind: 'video',
      height: 360,
      isPlaying: true
    });
    const other = normalizeMedia({
      url: 'https://cdn.example.com/other.mp4',
      title: 'Another video',
      kind: 'video',
      height: 1080
    });

    assert.equal(sortMedia([other, playing])[0].title, 'Currently playing');
  });

  it('uses the latest page playback state when merging detections', () => {
    const previouslyPlaying = normalizeMedia({
      url: 'https://cdn.example.com/current.mp4',
      title: 'Currently playing',
      kind: 'video',
      isPlaying: true,
      source: 'dom'
    });
    const currentScan = normalizeMedia({
      url: 'https://cdn.example.com/current.mp4',
      title: 'Currently playing',
      kind: 'video',
      isPlaying: false,
      source: 'dom'
    });

    const [merged] = mergeMediaLists([previouslyPlaying], [currentScan]);
    assert.equal(merged.isPlaying, false);
  });
});
