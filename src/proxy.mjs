import {exportVideo, getExportFormats} from './export.mjs?v=3';
import {mediaEvent} from './media.mjs?v=3';

const MAX_LONG_EDGE = 640;
const MAX_SHORT_EDGE = 360;
const VIDEO_BITRATE = 450_000;
const AUDIO_BITRATE = 64_000;

export async function inspectPreviewMedia(url, signal) {
  const video = document.createElement('video');
  video.preload = 'metadata';
  try {
    const ready = mediaEvent(video, 'loadedmetadata', signal);
    video.src = url;
    await ready;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error('動画の長さと解像度を取得できませんでした。');
    }
    return {width: video.videoWidth, height: video.videoHeight, duration: video.duration};
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export function isLightPreviewSource({width, height, duration}, size) {
  return Math.max(width, height) <= MAX_LONG_EDGE &&
    Math.min(width, height) <= MAX_SHORT_EDGE &&
    size * 8 / duration <= VIDEO_BITRATE + AUDIO_BITRATE;
}

export async function createPreviewProxy(url, {signal, onProgress, source, format} = {}) {
  signal?.throwIfAborted();
  const available = getExportFormats();
  const outputFormat = format ?? (available.includes('webm') ? 'webm' : available[0]);
  if (!available.includes(outputFormat)) {
    throw new Error('このブラウザでは軽量プレビューを作れません。');
  }
  const video = source ?? await inspectPreviewMedia(url, signal);
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(video.width, video.height),
    MAX_SHORT_EDGE / Math.min(video.width, video.height));
  const even = value => Math.max(2, Math.round(value * scale / 2) * 2);
  const {blob} = await exportVideo({
    project: {clips: [{assetId: 'preview', in: 0, out: video.duration}], captions: []},
    sources: new Map([['preview', url]]),
    options: {
      width: even(video.width), height: even(video.height), fps: 24, format: outputFormat,
      videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE,
    },
    signal,
    onProgress,
  });
  return blob;
}
