import {exportVideo, getExportFormats, supportedMimeType, waitForAction} from './export.mjs?v=3';
import {cueVideo} from './media.mjs?v=3';
import {assetKind, timelineDuration, visualDuration} from './project.mjs?v=3';
import {captionAt, drawFrame} from './render.mjs?v=3';

function makeSegments(project, assets, duration) {
  const segments = [];
  let end = 0;
  for (const clip of project.clips) {
    if (end >= duration) break;
    const start = end;
    end = Math.min(duration, start + (clip.out - clip.in));
    segments.push({clip, start, end, kind: assetKind(assets.get(clip.assetId))});
  }
  if (!segments.length || duration - end > 1e-8) segments.push({start: end, end: duration, kind: 'blank'});
  segments.at(-1).end = duration;
  return segments;
}

function makeSlot(mixer, destination) {
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  mixer.createMediaElementSource(video).connect(destination);
  return {video};
}

function loadSegment(slot, segment, sources, signal) {
  const task = {ready: false, frame: null, error: null};
  task.done = (async () => {
    if (segment.kind === 'blank') return null;
    const url = sources.get(segment.clip.assetId);
    if (segment.kind === 'image') {
      const image = new Image();
      await waitForAction(signal, '画像の読み込みに時間がかかりすぎています。', finish => {
        image.src = url;
        image.decode().then(() => finish(), () => finish(new Error('画像を読み込めませんでした。')));
      });
      return image;
    }
    await cueVideo(slot.video, url, segment.clip.in, signal);
    if (!slot.video.videoWidth || segment.clip.out > slot.video.duration + 0.05) {
      throw new Error('元動画を読み込めないか、編集区間が元動画の長さを超えています。');
    }
    return slot.video;
  })().then(frame => {
    task.frame = frame;
    task.ready = true;
  }, error => {
    task.error = error;
    task.ready = true;
  });
  return task;
}

async function decodeAudio(mixer, clips, sources, assets, signal) {
  const decoded = new Map();
  for (const assetId of new Set(clips.map(clip => clip.assetId))) {
    const response = await fetch(sources.get(assetId), {signal});
    const bytes = await response.arrayBuffer();
    let buffer;
    await waitForAction(signal, '音声データの準備に時間がかかりすぎています。', finish => {
      mixer.decodeAudioData(bytes).then(result => {
        buffer = result;
        finish();
      }, () => finish(new Error(`「${assets.get(assetId).name}」を音声として読み込めませんでした。`)));
    }, 60000);
    decoded.set(assetId, buffer);
  }
  return decoded;
}

async function warmAudioClock(mixer, destination, signal) {
  const silence = mixer.createOscillator();
  const muted = mixer.createGain();
  muted.gain.value = 0;
  silence.connect(muted);
  muted.connect(destination);
  muted.connect(mixer.destination);
  silence.start();
  // Wait for the audio device to start advancing its clock before capturing
  // video. Some browser audio backends hold the first few processing buffers.
  const start = mixer.currentTime;
  await waitForAction(signal, '書き出し用の音声を初期化できませんでした。', (finish, cleanup) => {
    const timer = setInterval(() => {
      if (mixer.currentTime - start >= 0.05) finish();
    }, 8);
    cleanup.push(() => clearInterval(timer));
  });
}

function scheduleAudio(mixer, destination, decoded, clips, origin, duration) {
  for (const clip of clips) {
    const buffer = decoded.get(clip.assetId);
    if (clip.out > buffer.duration + 0.1) {
      throw new Error('音声クリップの編集区間が元の音声の長さを超えています。');
    }
    const length = Math.min(clip.out - clip.in, duration - clip.start, buffer.duration - clip.in);
    if (length <= 0) continue;
    const source = mixer.createBufferSource();
    const gain = mixer.createGain();
    source.buffer = buffer;
    gain.gain.value = clip.gain;
    source.connect(gain).connect(destination);
    source.addEventListener('ended', () => {
      source.disconnect();
      gain.disconnect();
    }, {once: true});
    source.start(origin + clip.start, clip.in, length);
  }
}

function playUntil({mixer, origin, segment, frame, draw, signal, fps}) {
  return waitForAction(signal, 'この区間の書き出しを完了できませんでした。', (finish, cleanup) => {
    let nextTime = segment.start;
    const update = () => {
      try {
        if (frame?.error) return finish(new Error('書き出し中に動画の再生が止まりました。'));
        const time = mixer.currentTime - origin;
        if (time >= segment.end) return finish();
        if (time + 0.002 >= nextTime) {
          draw(frame, Math.max(segment.start, time));
          nextTime = segment.start + (Math.floor((time + 0.002 - segment.start) * fps) + 1) / fps;
        }
      } catch (error) {
        finish(error);
      }
    };
    const timer = setInterval(update, Math.min(8, 500 / fps));
    cleanup.push(() => clearInterval(timer));
    update();
  }, (segment.end - segment.start + 20) * 1000);
}

export async function exportMixedVideo({project, sources, options = {}, signal, onProgress = () => {}}) {
  const {width = 1280, height = 720, fps = 30, format = 'auto', videoBitsPerSecond, audioBitsPerSecond} = options;
  const duration = options.duration ?? timelineDuration(project);
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const audioClips = (project.audioClips ?? []).filter(clip => clip.start < duration && clip.gain !== 0);
  if (duration === visualDuration(project) && !audioClips.length
      && project.clips.every(clip => assetKind(assets.get(clip.assetId)) === 'video')) {
    return exportVideo({project, sources, options, signal, onProgress});
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('タイムラインに素材を追加してください。');
  if (![width, height, fps].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('書き出しのサイズまたはフレームレートが無効です。');
  }
  const extension = format === 'auto' ? getExportFormats()[0] : format;
  const mimeType = supportedMimeType(extension);
  const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!mimeType || !Audio || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('このブラウザは指定の形式で動画を書き出せません。');
  }
  const segments = makeSegments(project, assets, duration);
  const usedClips = [...audioClips, ...segments.flatMap(segment => segment.clip ? [segment.clip] : [])];
  if (usedClips.some(clip => !assets.has(clip.assetId) || !sources.get(clip.assetId))) {
    throw new Error('書き出しに必要な素材を再リンクしてください。');
  }
  signal?.throwIfAborted();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new Error('書き出し用の画面を作れませんでした。');
  const controller = new AbortController();
  const active = controller.signal;
  const mixer = new Audio();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, {once: true});
  const streams = [];
  const slots = [];
  let recorder;

  try {
    await waitForAction(active, '書き出し用の音声を初期化できませんでした。', finish => {
      mixer.resume().then(() => finish(), finish);
    });
    const destination = mixer.createMediaStreamDestination();
    streams.push(destination.stream);
    const chunks = [];
    slots.push(makeSlot(mixer, destination), makeSlot(mixer, destination));

    await warmAudioClock(mixer, destination, active);
    const loadedAudio = await decodeAudio(mixer, audioClips, sources, assets, active);
    let current = loadSegment(slots[0], segments[0], sources, active);
    let origin;
    const draw = (frame, time) => {
      drawFrame(context, frame, captionAt(project, time));
      onProgress(Math.min(time / duration, 1));
    };

    for (const [index, segment] of segments.entries()) {
      const waiting = index > 0 && !current.ready;
      if (waiting) {
        recorder.pause();
        await mixer.suspend();
      }
      await current.done;
      active.throwIfAborted();
      if (current.error) throw current.error;
      const frame = current.frame;
      const video = segment.kind === 'video' ? frame : null;
      const nextSegment = segments[index + 1];
      if (nextSegment) current = loadSegment(slots[(index + 1) % slots.length], nextSegment, sources, active);
      draw(frame, segment.start);
      if (video) {
        await waitForAction(active, '書き出し用の動画を再生できませんでした。', finish => {
          video.play().then(() => finish(), finish);
        });
      }

      if (index === 0) {
        streams.push(canvas.captureStream(fps));
        recorder = new MediaRecorder(new MediaStream(streams.flatMap(stream => stream.getTracks())), {
          mimeType, videoBitsPerSecond, audioBitsPerSecond,
        });
        recorder.addEventListener('dataavailable', event => {
          if (event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener('error', event => controller.abort(event.error ?? new Error('エンコードに失敗しました。')));
        recorder.start(1000);
        origin = mixer.currentTime;
        scheduleAudio(mixer, destination, loadedAudio, audioClips, origin, duration);
      } else if (waiting) {
        await mixer.resume();
        recorder.resume();
      }
      await playUntil({mixer, origin, segment, frame, draw, signal: active, fps});
      video?.pause();
    }

    await waitForAction(active, '書き出しファイルを確定できませんでした。', (finish, cleanup) => {
      const stopped = () => finish();
      recorder.addEventListener('stop', stopped, {once: true});
      cleanup.push(() => recorder.removeEventListener('stop', stopped));
      recorder.stop();
    });
    const blob = new Blob(chunks, {type: recorder.mimeType || mimeType});
    if (!blob.size) throw new Error('書き出した動画にデータがありません。');
    onProgress(1);
    return {blob, extension};
  } finally {
    signal?.removeEventListener('abort', abort);
    controller.abort();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    for (const {video} of slots) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    for (const stream of streams) stream.getTracks().forEach(track => track.stop());
    await mixer.close().catch(() => {});
  }
}
