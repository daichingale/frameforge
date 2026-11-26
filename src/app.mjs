import {
  addAsset, appendClip, createProject, locateClip, moveClip, parseProject,
  removeCaption, removeClip, setCaption, sliceProject, splitClip, timelineDuration, trimClip,
} from './project.mjs';
import {captionAt, drawFrame} from './render.mjs';
import {cueVideo, inspectMedia} from './media.mjs';
import {exportVideo, getExportFormats} from './export.mjs';

const $ = id => document.getElementById(id);
const sources = new Map();
const past = [];
const future = [];
const video = document.createElement('video');
const canvas = $('preview');
const ctx = canvas.getContext('2d');
video.preload = 'auto';
video.playsInline = true;

let project = createProject();
let currentTime = 0;
let selectedId = null;
let captionId = null;
let playback = null;
let playing = false;
let mediaBusy = false;
let exportTask = null;
let downloadUrl = null;

const findAsset = id => project.assets.find(asset => asset.id === id);
const notify = message => { $('status').textContent = message; };
const round = value => Number(value.toFixed(3));
const formatTime = time => {
  const millis = Math.floor(Math.max(0, time) * 1000 + 0.0001);
  const minutes = String(Math.floor(millis / 60000)).padStart(2, '0');
  const seconds = String(Math.floor(millis / 1000) % 60).padStart(2, '0');
  return `${minutes}:${seconds}.${String(millis % 1000).padStart(3, '0')}`;
};

function button(label, className, action) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.className = className;
  element.addEventListener('click', action);
  return element;
}

function setPlaying(value) {
  playing = value;
  $('play-pause').textContent = value ? '⏸ 一時停止' : '▶ 再生';
  $('play-pause').setAttribute('aria-pressed', String(value));
}

function showTime() {
  const duration = timelineDuration(project);
  const seek = $('seek');
  seek.value = String(currentTime);
  $('time-readout').textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  $('timeline').style.setProperty('--playhead', `${duration ? currentTime / duration * 100 : 0}%`);
  const location = locateClip(project, currentTime);
  $('split').disabled = !location || currentTime <= location.start || currentTime >= location.end;
}

function paint(frame = null) {
  drawFrame(ctx, frame, captionAt(project, currentTime));
  showTime();
}

function stopPlayback() {
  playback?.abort();
  playback = null;
  video.pause();
  setPlaying(false);
}

async function preview(autoplay = false) {
  stopPlayback();
  const controller = new AbortController();
  playback = controller;
  const {signal} = controller;
  let position = locateClip(project, currentTime);
  if (!position) {
    paint();
    return;
  }
  if (autoplay) setPlaying(true);

  try {
    while (position) {
      const url = sources.get(position.clip.assetId);
      if (!url) {
        paint();
        if (autoplay) notify(`「${findAsset(position.clip.assetId).name}」を再リンクしてください。`);
        break;
      }
      await cueVideo(video, url, position.sourceTime, signal);
      signal.throwIfAborted();
      paint(video);
      if (!autoplay) break;
      await video.play();
      signal.throwIfAborted();
      await new Promise(resolve => {
        const update = () => {
          if (signal.aborted) return resolve();
          currentTime = Math.min(position.end, position.start + Math.max(0, video.currentTime - position.clip.in));
          paint(video);
          if (video.ended || currentTime >= position.end || video.error) return resolve();
          requestAnimationFrame(update);
        };
        requestAnimationFrame(update);
      });
      signal.throwIfAborted();
      video.pause();
      if (video.error) throw new Error('この動画の再生中にエラーが発生しました。');
      currentTime = position.end;
      const duration = timelineDuration(project);
      if (currentTime >= duration) {
        paint(video);
        break;
      }
      position = locateClip(project, currentTime);
    }
  } catch (error) {
    if (!signal.aborted) {
      paint();
      notify(error.message);
    }
  } finally {
    if (playback === controller) {
      playback = null;
      setPlaying(false);
    }
  }
}

function selectClip(id, time = currentTime) {
  selectedId = id;
  currentTime = time;
  render();
  void preview();
}

function resetCaption() {
  captionId = null;
  $('caption-form').reset();
  $('caption-start').value = round(currentTime);
  $('caption-end').value = round(currentTime + 2);
}

function render() {
  const duration = timelineDuration(project);
  const assets = $('asset-list');
  assets.replaceChildren();
  for (const asset of project.assets) {
    const row = document.createElement('div');
    const linked = sources.has(asset.id);
    row.className = linked ? 'asset-row' : 'asset-row missing';
    const label = document.createElement('span');
    label.textContent = `${asset.name} · ${formatTime(asset.duration)}${linked ? '' : ' · 未リンク'}`;
    const add = button('+', 'asset-add', () => edit(() => appendClip(project, asset.id)));
    add.setAttribute('aria-label', `${asset.name} をタイムラインに追加`);
    row.append(label, add);
    assets.append(row);
  }
  if (project.assets.length === 0) assets.textContent = '動画素材を追加してください';

  const timeline = $('timeline');
  timeline.replaceChildren();
  let offset = 0;
  for (const clip of project.clips) {
    const start = offset;
    const clipDuration = clip.out - clip.in;
    const asset = findAsset(clip.assetId);
    const block = button(asset.name, 'clip-block', () => selectClip(clip.id, start));
    block.classList.toggle('selected', clip.id === selectedId);
    block.classList.toggle('missing', !sources.has(clip.assetId));
    block.setAttribute('aria-pressed', String(clip.id === selectedId));
    block.style.flexGrow = String(clipDuration);
    block.title = `${asset.name} · ${formatTime(clipDuration)}`;
    timeline.append(block);
    offset += clipDuration;
  }
  $('timeline-empty').hidden = project.clips.length > 0;
  timeline.hidden = project.clips.length === 0;

  const index = project.clips.findIndex(clip => clip.id === selectedId);
  const clip = project.clips[index];
  $('selection-empty').hidden = Boolean(clip);
  $('clip-inspector').hidden = !clip;
  if (clip) {
    const asset = findAsset(clip.assetId);
    $('clip-name').textContent = asset.name;
    $('clip-in').value = clip.in;
    $('clip-out').value = clip.out;
    $('clip-in').max = asset.duration;
    $('clip-out').max = asset.duration;
    $('clip-left').disabled = index === 0;
    $('clip-right').disabled = index === project.clips.length - 1;
  }

  const captions = $('caption-list');
  captions.replaceChildren();
  for (const caption of [...project.captions].sort((a, b) => a.start - b.start)) {
    const row = document.createElement('div');
    row.className = 'caption-row';
    const jump = button(`${formatTime(caption.start)} · ${caption.text}`, '', () => {
      captionId = caption.id;
      $('caption-start').value = caption.start;
      $('caption-end').value = caption.end;
      $('caption-text').value = caption.text;
      currentTime = Math.min(duration, caption.start);
      $('caption-text').focus();
      void preview();
    });
    const remove = button('削除', '', () => edit(() => {
      if (captionId === caption.id) resetCaption();
      return removeCaption(project, caption.id);
    }));
    remove.setAttribute('aria-label', `字幕「${caption.text}」を削除`);
    row.append(jump, remove);
    captions.append(row);
  }

  $('seek').max = String(duration);
  $('seek').disabled = !duration;
  $('play-pause').disabled = !duration;
  $('undo').disabled = !past.length || mediaBusy;
  $('redo').disabled = !future.length || mediaBusy;
  $('add-media').disabled = mediaBusy;
  $('relink-media').disabled = mediaBusy || !project.assets.some(asset => !sources.has(asset.id));
  $('open-project').disabled = mediaBusy;
  $('export-open').disabled = !duration || mediaBusy;
  showTime();
}

function commit(next) {
  if (next === project) return;
  past.push(project);
  if (past.length > 100) past.shift();
  future.length = 0;
  project = next;
  currentTime = Math.min(currentTime, timelineDuration(project));
  render();
  void preview();
}

function edit(operation) {
  if (mediaBusy) return;
  try {
    commit(operation());
  } catch (error) {
    notify(error.message);
  }
}

function restore(from, to) {
  if (mediaBusy || from.length === 0) return;
  to.push(project);
  project = from.pop();
  currentTime = Math.min(currentTime, timelineDuration(project));
  resetCaption();
  render();
  void preview();
}

function readFiles(id, handler) {
  $(id).addEventListener('change', async event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length || mediaBusy) return;
    mediaBusy = true;
    stopPlayback();
    render();
    try {
      await handler(files);
    } catch (error) {
      notify(error.message);
    } finally {
      mediaBusy = false;
      render();
      void preview();
    }
  });
}

async function importMedia(files, relink) {
  const failures = [];
  const attached = [];
  let next = project;
  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      const duration = await inspectMedia(url);
      if (relink) {
        const candidates = project.assets.filter(asset =>
          !sources.has(asset.id) && asset.name === file.name && asset.size === file.size
          && Math.abs(asset.duration - duration) < 0.1);
        const exact = candidates.find(asset => asset.lastModified === file.lastModified);
        const asset = exact ?? (candidates.length === 1 ? candidates[0] : null);
        if (!asset) throw new Error('一致する未リンク素材がありません');
        sources.set(asset.id, url);
      } else {
        const id = crypto.randomUUID();
        next = addAsset(next, {id, name: file.name, duration, size: file.size, lastModified: file.lastModified});
        sources.set(id, url);
      }
      attached.push(file.name);
    } catch (error) {
      URL.revokeObjectURL(url);
      failures.push(`${file.name}（${error.message}）`);
    }
  }
  commit(next);
  notify([`${relink ? '再リンク' : '追加'} ${attached.length}件`, ...failures].join(' ／ '));
}

$('add-media').onclick = () => $('media-input').click();
$('open-project').onclick = () => $('project-input').click();
$('relink-media').onclick = () => $('relink-input').click();
readFiles('media-input', files => importMedia(files, false));
readFiles('relink-input', files => importMedia(files, true));
readFiles('project-input', async ([file]) => {
  const opened = parseProject(await file.text());
  for (const [id, url] of sources) {
    const oldAsset = findAsset(id);
    const newAsset = opened.assets.find(asset => asset.id === id);
    if (newAsset && oldAsset && ['name', 'size', 'lastModified', 'duration'].every(key => oldAsset[key] === newAsset[key])) continue;
    URL.revokeObjectURL(url);
    sources.delete(id);
  }
  project = opened;
  past.length = 0;
  future.length = 0;
  selectedId = null;
  currentTime = 0;
  resetCaption();
  notify(opened.assets.some(asset => !sources.has(asset.id))
    ? 'プロジェクトを開きました。元の動画を「素材を再リンク」から選んでください。'
    : 'プロジェクトを開きました。');
});

$('save-project').onclick = () => {
  const blob = new Blob([JSON.stringify(project, null, 2)], {type: 'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'frameforge-project.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  notify('プロジェクトを保存しました。別の端末で開くときは元の動画も用意してください。');
};
$('undo').onclick = () => restore(past, future);
$('redo').onclick = () => restore(future, past);

function togglePlayback() {
  const duration = timelineDuration(project);
  if (!duration) return;
  if (playing) {
    stopPlayback();
    return;
  }
  if (currentTime >= duration) currentTime = 0;
  void preview(true);
}

$('play-pause').onclick = togglePlayback;
$('seek').oninput = event => {
  currentTime = Number(event.target.value);
  showTime();
  void preview();
};
$('split').onclick = () => edit(() => splitClip(project, currentTime));
$('clip-inspector').onsubmit = event => {
  event.preventDefault();
  edit(() => trimClip(project, selectedId, $('clip-in').valueAsNumber, $('clip-out').valueAsNumber));
};
$('clip-left').onclick = () => edit(() => moveClip(project, selectedId, -1));
$('clip-right').onclick = () => edit(() => moveClip(project, selectedId, 1));
$('clip-remove').onclick = () => edit(() => removeClip(project, selectedId));
$('caption-form').onsubmit = event => {
  event.preventDefault();
  edit(() => {
    const caption = {
      start: $('caption-start').valueAsNumber,
      end: $('caption-end').valueAsNumber,
      text: $('caption-text').value,
    };
    if (captionId) caption.id = captionId;
    const next = setCaption(project, caption);
    resetCaption();
    return next;
  });
};
$('caption-reset').onclick = resetCaption;

const dialog = $('export-dialog');
const availableFormats = getExportFormats();
for (const option of $('export-format').options) {
  option.disabled = option.value !== 'auto' && !availableFormats.includes(option.value);
}

function clearDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  $('export-download').hidden = true;
  $('export-download').removeAttribute('href');
}

$('export-open').onclick = () => {
  stopPlayback();
  clearDownload();
  const duration = timelineDuration(project);
  $('export-in').value = 0;
  $('export-out').value = duration;
  $('export-in').max = duration;
  $('export-out').max = duration;
  $('export-start').disabled = !availableFormats.length;
  $('export-message').textContent = availableFormats.length
    ? '再生と同じくらいの時間がかかります。完了までこのタブを開いてください。'
    : 'このブラウザでは動画を書き出せません。';
  $('export-progress').value = 0;
  dialog.showModal();
};

$('export-form').onsubmit = async event => {
  event.preventDefault();
  if (exportTask) return;
  const controller = new AbortController();
  exportTask = controller;
  clearDownload();
  $('export-start').disabled = true;
  $('export-progress').value = 0;
  $('export-message').textContent = '書き出し中…';
  try {
    const [width, height] = $('export-size').value.split('x').map(Number);
    const range = sliceProject(project, $('export-in').valueAsNumber, $('export-out').valueAsNumber);
    const {blob, extension} = await exportVideo({
      project: range,
      sources,
      options: {height, width, format: $('export-format').value},
      signal: controller.signal,
      onProgress: fraction => { $('export-progress').value = fraction; },
    });
    controller.signal.throwIfAborted();
    downloadUrl = URL.createObjectURL(blob);
    const link = $('export-download');
    link.href = downloadUrl;
    link.download = `frameforge.${extension}`;
    link.hidden = false;
    $('export-message').textContent = '書き出しが完了しました。';
  } catch (error) {
    $('export-message').textContent = controller.signal.aborted ? '書き出しを中止しました。' : error.message;
  } finally {
    exportTask = null;
    $('export-start').disabled = false;
  }
};

function closeExport(event) {
  event.preventDefault();
  if (exportTask) exportTask.abort();
  else dialog.close();
}
$('export-cancel').onclick = closeExport;
dialog.addEventListener('cancel', closeExport);

document.addEventListener('keydown', event => {
  if (dialog.open || event.target.closest('input, textarea, select, [contenteditable]')) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
    event.preventDefault();
    if (key === 'y' || event.shiftKey) restore(future, past);
    else restore(past, future);
  } else if (!event.ctrlKey && !event.metaKey && key === 's' && !$('split').disabled) {
    event.preventDefault();
    $('split').click();
  } else if (event.code === 'Space' && event.target === document.body) {
    event.preventDefault();
    togglePlayback();
  }
});

resetCaption();
render();
paint();
