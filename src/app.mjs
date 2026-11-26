import {
  addAsset, appendClip, createProject, locateClip, moveClip, parseProject,
  removeCaption, removeClip, rippleDeleteRange, setCaption, sliceProject, splitClip,
  timelineDuration, trimClip, trimClipToPlayhead,
} from './project.mjs?v=2';
import {captionAt, drawFrame} from './render.mjs';
import {cueVideo, inspectMedia} from './media.mjs';
import {exportVideo, getExportFormats} from './export.mjs?v=2';
import {createPreviewProxy, inspectPreviewMedia, isLightPreviewSource} from './proxy.mjs?v=2';
import {mountTimeline} from './timeline.mjs?v=2';

const $ = id => document.getElementById(id);
const sources = new Map();
const proxies = new Map();
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
let proxyTask = null;
let rangeStart = null;
let rangeEnd = null;
const EDIT_STEP = 1 / 30;

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

const timeline = mountTimeline({
  element: $('timeline'),
  onSelect: id => {
    selectedId = id;
    timeline.setSelection(id);
    renderInspector();
  },
  onSeek: seekTo,
  onTrim: (id, start, end) => edit(() => {
    selectedId = id;
    return trimClip(project, id, start, end);
  }),
  onMove: (id, target) => edit(() => {
    selectedId = id;
    const index = project.clips.findIndex(clip => clip.id === id);
    return moveClip(project, id, target - index);
  }),
  onCaptionSelect: selectCaption,
});

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
  timeline.setTime(currentTime);
  const location = locateClip(project, currentTime);
  const canSplit = location && Math.min(currentTime - location.start, location.end - currentTime) >= 0.05 - 1e-9;
  $('split').disabled = !canSplit || mediaBusy;
  const picked = location?.clip.id === selectedId && location;
  $('trim-to-in').disabled = !picked || !(currentTime > picked.start && picked.end - currentTime >= 0.05 - 1e-9);
  $('trim-to-out').disabled = !picked || !(currentTime < picked.end && currentTime - picked.start >= 0.05 - 1e-9);
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
    playback = null;
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
      const proxy = autoplay && $('use-proxy').checked && proxies.get(position.clip.assetId);
      if (proxy) {
        try {
          await cueVideo(video, proxy, position.sourceTime, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          await cueVideo(video, url, position.sourceTime, signal);
        }
      } else {
        await cueVideo(video, url, position.sourceTime, signal);
      }
      signal.throwIfAborted();
      paint(video);
      if (!autoplay) break;
      video.playbackRate = Number($('playback-rate').value);
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

function seekTo(time) {
  currentTime = Math.min(timelineDuration(project), Math.max(0, time));
  showTime();
  void preview();
}

function showRange() {
  const current = time => time === null ? '—' : formatTime(time);
  $('range-readout').textContent = rangeStart === null && rangeEnd === null
    ? '区間未設定' : `${current(rangeStart)} → ${current(rangeEnd)}`;
  $('range-start').disabled = mediaBusy || project.clips.length === 0;
  $('range-end').disabled = mediaBusy || project.clips.length === 0;
  $('range-remove').disabled = mediaBusy || rangeStart === null || rangeEnd === null || rangeStart >= rangeEnd;
  $('range-clear').disabled = rangeStart === null && rangeEnd === null;
  timeline.setRange(rangeStart, rangeEnd);
}

function clearRange() {
  rangeStart = null;
  rangeEnd = null;
  showRange();
}

function resetCaption() {
  captionId = null;
  $('caption-form').reset();
  $('caption-start').value = round(currentTime);
  $('caption-end').value = round(currentTime + 2);
}

function selectCaption(id) {
  const caption = project.captions.find(item => item.id === id);
  if (!caption) return;
  captionId = id;
  $('caption-start').value = caption.start;
  $('caption-end').value = caption.end;
  $('caption-text').value = caption.text;
  $('caption-text').focus({preventScroll: true});
  seekTo(caption.start);
}

function renderInspector() {
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
  showTime();
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
    const actions = document.createElement('div');
    actions.className = 'asset-actions';
    actions.append(add);
    if (linked) {
      const active = proxyTask?.assetId === asset.id;
      const proxyReady = proxies.has(asset.id);
      const proxyButton = button(active ? '軽量化を中止' : proxyReady ? '軽量版を解除' : '軽量化', '', () => manageProxy(asset));
      proxyButton.disabled = (Boolean(proxyTask) && !active) || mediaBusy;
      proxyButton.setAttribute('aria-label', `${asset.name} の${proxyButton.textContent}`);
      actions.append(proxyButton);
    }
    row.append(label, actions);
    assets.append(row);
  }
  if (project.assets.length === 0) assets.textContent = '動画素材を追加してください';

  $('timeline-empty').hidden = project.clips.length > 0;
  $('timeline').hidden = project.clips.length === 0;
  timeline.render({project, selectedId, sources});
  renderInspector();

  const captions = $('caption-list');
  captions.replaceChildren();
  for (const caption of [...project.captions].sort((a, b) => a.start - b.start)) {
    const row = document.createElement('div');
    row.className = 'caption-row';
    const jump = button(`${formatTime(caption.start)} · ${caption.text}`, '', () => selectCaption(caption.id));
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
  $('step-back').disabled = !duration;
  $('step-forward').disabled = !duration;
  $('timeline-zoom').disabled = !duration;
  $('timeline-fit').disabled = !duration;
  $('undo').disabled = !past.length || mediaBusy;
  $('redo').disabled = !future.length || mediaBusy;
  $('add-media').disabled = mediaBusy;
  $('relink-media').disabled = mediaBusy || !project.assets.some(asset => !sources.has(asset.id));
  $('open-project').disabled = mediaBusy;
  $('export-open').disabled = !duration || mediaBusy || Boolean(proxyTask);
  showRange();
  showTime();
}

function commit(next) {
  if (next === project) return;
  past.push(project);
  if (past.length > 100) past.shift();
  future.length = 0;
  if (next.clips !== project.clips) clearRange();
  project = next;
  if (!project.clips.some(clip => clip.id === selectedId)) selectedId = null;
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
  if (!project.clips.some(clip => clip.id === selectedId)) selectedId = null;
  clearRange();
  currentTime = Math.min(currentTime, timelineDuration(project));
  resetCaption();
  render();
  void preview();
}

async function runMediaJob(files, handler) {
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
}

function readFiles(id, handler) {
  $(id).addEventListener('change', event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    void runMediaJob(files, handler);
  });
}

async function manageProxy(asset) {
  if (proxyTask?.assetId === asset.id) {
    proxyTask.controller.abort();
    return;
  }
  if (proxyTask || mediaBusy) return;
  const previous = proxies.get(asset.id);
  if (previous) {
    const wasPlaying = playing;
    stopPlayback();
    proxies.delete(asset.id);
    URL.revokeObjectURL(previous);
    render();
    void preview(wasPlaying);
    return;
  }
  const controller = new AbortController();
  const {signal} = controller;
  proxyTask = {assetId: asset.id, controller};
  const url = sources.get(asset.id);
  stopPlayback();
  render();
  notify(`「${asset.name}」の軽量プレビューを作成中です。`);
  try {
    const source = await inspectPreviewMedia(url, signal);
    if (isLightPreviewSource(source, asset.size)) {
      notify(`「${asset.name}」はすでに軽いため、そのまま再生します。`);
      return;
    }
    let lastProgress = -1;
    const blob = await createPreviewProxy(url, {source, signal, onProgress: progress => {
      const percent = Math.floor(progress * 10) * 10;
      if (percent === lastProgress) return;
      lastProgress = percent;
      notify(`「${asset.name}」を軽量化中 · ${percent}%`);
    }});
    signal.throwIfAborted();
    if (blob.size >= asset.size) {
      notify(`「${asset.name}」は圧縮後の方が大きいため、元動画を使います。`);
      return;
    }
    proxies.set(asset.id, URL.createObjectURL(blob));
    const original = (asset.size / 1024 / 1024).toFixed(2);
    const reduced = (blob.size / 1024 / 1024).toFixed(2);
    notify(`「${asset.name}」の軽量プレビューを作成しました（${original} MB → ${reduced} MB）。`);
  } catch (error) {
    notify(signal.aborted ? '軽量化を中止しました。' : error.message);
  } finally {
    proxyTask = null;
    render();
  }
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
const mediaPanel = $('media-panel');
mediaPanel.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  if (!mediaBusy) mediaPanel.classList.add('drag-over');
});
mediaPanel.addEventListener('dragleave', event => {
  if (!mediaPanel.contains(event.relatedTarget)) mediaPanel.classList.remove('drag-over');
});
mediaPanel.addEventListener('drop', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  mediaPanel.classList.remove('drag-over');
  void runMediaJob(Array.from(event.dataTransfer.files), files => importMedia(files, false));
});
readFiles('project-input', async ([file]) => {
  const opened = parseProject(await file.text());
  proxyTask?.controller.abort();
  for (const [id, url] of sources) {
    const oldAsset = findAsset(id);
    const newAsset = opened.assets.find(asset => asset.id === id);
    if (newAsset && oldAsset && ['name', 'size', 'lastModified', 'duration'].every(key => oldAsset[key] === newAsset[key])) continue;
    URL.revokeObjectURL(url);
    sources.delete(id);
    if (proxies.has(id)) URL.revokeObjectURL(proxies.get(id));
    proxies.delete(id);
  }
  project = opened;
  past.length = 0;
  future.length = 0;
  selectedId = null;
  currentTime = 0;
  clearRange();
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
    void preview();
    return;
  }
  if (currentTime >= duration) currentTime = 0;
  void preview(true);
}

$('play-pause').onclick = togglePlayback;
$('seek').oninput = event => seekTo(Number(event.target.value));
$('step-back').onclick = () => seekTo(currentTime - EDIT_STEP);
$('step-forward').onclick = () => seekTo(currentTime + EDIT_STEP);
$('playback-rate').onchange = () => { video.playbackRate = Number($('playback-rate').value); };
$('use-proxy').onchange = () => { if (playing) void preview(true); };
$('timeline-zoom').oninput = event => timeline.setZoom(Number(event.target.value));
$('timeline-fit').onclick = () => {
  const zoom = timeline.fit();
  if (Number.isFinite(zoom)) $('timeline-zoom').value = zoom;
};
$('split').onclick = () => edit(() => splitClip(project, currentTime));
$('range-start').onclick = () => {
  rangeStart = currentTime;
  if (rangeEnd !== null && rangeEnd <= rangeStart) rangeEnd = null;
  showRange();
};
$('range-end').onclick = () => {
  rangeEnd = currentTime;
  if (rangeStart !== null && rangeStart >= rangeEnd) rangeStart = null;
  showRange();
};
$('range-clear').onclick = clearRange;
$('range-remove').onclick = () => edit(() => {
  if (rangeStart === null || rangeEnd === null) return project;
  const cutStart = rangeStart;
  const next = rippleDeleteRange(project, cutStart, rangeEnd);
  currentTime = cutStart;
  resetCaption();
  return next;
});
$('clip-inspector').onsubmit = event => {
  event.preventDefault();
  edit(() => trimClip(project, selectedId, $('clip-in').valueAsNumber, $('clip-out').valueAsNumber));
};
$('clip-left').onclick = () => edit(() => moveClip(project, selectedId, -1));
$('clip-right').onclick = () => edit(() => moveClip(project, selectedId, 1));
$('clip-remove').onclick = () => edit(() => removeClip(project, selectedId));
$('trim-to-in').onclick = () => edit(() => trimClipToPlayhead(project, selectedId, currentTime, 'in'));
$('trim-to-out').onclick = () => edit(() => trimClipToPlayhead(project, selectedId, currentTime, 'out'));
$('clip-duplicate').onclick = () => edit(() => {
  const index = project.clips.findIndex(clip => clip.id === selectedId);
  if (index === -1) return project;
  const copy = {...project.clips[index], id: crypto.randomUUID()};
  selectedId = copy.id;
  return {...project, clips: project.clips.toSpliced(index + 1, 0, copy)};
});
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
  const rangeComplete = rangeStart !== null && rangeEnd !== null && rangeStart < rangeEnd;
  $('export-in').value = rangeComplete ? rangeStart : 0;
  $('export-out').value = rangeComplete ? rangeEnd : duration;
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
  if (dialog.open) return;
  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && key === 's') {
    event.preventDefault();
    $('save-project').click();
    return;
  }
  if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (modifier && (key === 'z' || key === 'y')) {
    event.preventDefault();
    if (key === 'y' || event.shiftKey) restore(future, past);
    else restore(past, future);
  } else if (modifier && key === 'd' && selectedId) {
    event.preventDefault();
    $('clip-duplicate').click();
  } else if (!modifier && !event.altKey) {
    const shortcut = {s: 'split', i: 'range-start', o: 'range-end', delete: 'clip-remove'};
    const action = shortcut[key];
    if (action && (action !== 'clip-remove' || project.clips.some(clip => clip.id === selectedId))) {
      event.preventDefault();
      $(action).click();
    } else if (event.code === 'Space' && event.target === document.body) {
      event.preventDefault();
      togglePlayback();
    }
  }
});

resetCaption();
render();
paint();
