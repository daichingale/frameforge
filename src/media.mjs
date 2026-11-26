export function mediaEvent(video, name, signal, timeout = 8000) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      video.removeEventListener(name, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const success = () => finish();
    const failure = () => finish(new Error('この素材を読み込めませんでした。対応する形式で保存し直してください。'));
    const abort = () => finish(signal.reason);
    video.addEventListener(name, success, {once: true});
    video.addEventListener('error', failure, {once: true});
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(failure, timeout);
  });
}

export async function inspectMedia(url, kind = 'video') {
  if (kind === 'image') {
    await loadImage(url);
    return 3600;
  }
  const video = document.createElement(kind === 'audio' ? 'audio' : 'video');
  video.preload = 'metadata';
  try {
    const ready = mediaEvent(video, 'loadedmetadata');
    video.src = url;
    await ready;
    if (!(video.duration > 0 && Number.isFinite(video.duration) && (kind === 'audio' || video.videoWidth > 0))) {
      throw new Error('長さを取得できるファイルを選んでください。');
    }
    return video.duration;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export async function loadImage(url, signal) {
  const image = new Image();
  const ready = mediaEvent(image, 'load', signal);
  image.src = url;
  await ready;
  return image;
}

export function mediaKind(file) {
  if (/\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name)) return 'image';
  if (/\.(aac|aif?f|flac|m4a|mp3|oga|ogg|opus|wav)$/i.test(file.name)) return 'audio';
  if (/^(image|audio|video)\//.test(file.type)) return file.type.split('/')[0];
  if (/\.(m4v|mkv|mov|mp4|ogv|webm)$/i.test(file.name)) return 'video';
  throw new Error('動画・画像・音声ファイルを選んでください。');
}

export async function cueVideo(video, url, time, signal) {
  if (video.src !== url || video.error) {
    const loaded = mediaEvent(video, 'loadedmetadata', signal);
    video.src = url;
    await loaded;
  } else if (video.readyState === 0) {
    await mediaEvent(video, 'loadedmetadata', signal);
  }
  signal.throwIfAborted();
  const target = Math.min(time, Math.max(0, video.duration - 0.001));
  if (Math.abs(video.currentTime - target) > 0.001 || video.seeking) {
    const sought = mediaEvent(video, 'seeked', signal);
    video.currentTime = target;
    await sought;
  }
  if (video.readyState < 2) await mediaEvent(video, 'loadeddata', signal);
}
