const MIN_CLIP_DURATION = 0.05;
const TIME_TOLERANCE = 1e-9;

export function createProject() {
  return { version: 1, assets: [], clips: [], captions: [] };
}

function requireRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAsset(asset) {
  requireRecord(asset, '素材の情報が正しくありません。');
  const { id, name, duration, size, lastModified } = asset;
  if (!hasText(id) || !hasText(name) || !Number.isFinite(duration) || duration <= 0
      || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified)) {
    throw new Error('素材の情報が正しくありません。');
  }
  return { id, name, duration, size, lastModified };
}

function validateClip(clip, asset) {
  requireRecord(clip, 'クリップの情報が正しくありません。');
  if (!asset) throw new Error('クリップの素材が見つかりません。');
  const { id, assetId, in: start, out: end } = clip;
  if (!hasText(id) || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end > asset.duration || end <= start) {
    throw new Error('クリップの開始・終了を素材の範囲内で指定してください。');
  }
  const minimum = Math.min(MIN_CLIP_DURATION, asset.duration);
  const tolerance = Math.min(TIME_TOLERANCE, minimum * 1e-6);
  if (end - start < minimum - tolerance) {
    throw new Error('クリップの長さは0.05秒以上にしてください。');
  }
  return { id, assetId, in: start, out: end };
}

function validateCaption(caption) {
  requireRecord(caption, '字幕の情報が正しくありません。');
  const { id, start, end, text } = caption;
  if (!hasText(id) || !hasText(text) || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start) {
    throw new Error('字幕の本文を入力し、終了時刻を開始時刻より後にしてください。');
  }
  return { id, start, end, text };
}

function uniqueById(items) {
  const index = new Map(items.map(item => [item.id, item]));
  if (index.size !== items.length) throw new Error('プロジェクト内に重複したIDがあります。');
  return index;
}

export function parseProject(json) {
  const input = JSON.parse(json);
  requireRecord(input, 'FrameForgeのプロジェクトファイルを選択してください。');
  if (input.version !== 1) throw new Error('このバージョンのプロジェクトには対応していません。');
  if (!Array.isArray(input.assets) || !Array.isArray(input.clips) || !Array.isArray(input.captions)) {
    throw new Error('プロジェクトの素材・クリップ・字幕データが不足しています。');
  }
  const assets = input.assets.map(validateAsset);
  const assetIndex = uniqueById(assets);
  const clips = input.clips.map(clip => validateClip(clip, assetIndex.get(clip?.assetId)));
  const captions = input.captions.map(validateCaption);
  uniqueById(clips);
  uniqueById(captions);
  const project = { version: 1, assets, clips, captions };
  if (!Number.isFinite(timelineDuration(project))) throw new Error('タイムラインが長すぎます。');
  return project;
}

export function timelineDuration(project) {
  return project.clips.reduce((sum, clip) => sum + (clip.out - clip.in), 0);
}

// Export ranges may contain fragments shorter than the minimum editable clip duration.
export function sliceProject(project, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > timelineDuration(project)) {
    throw new Error('書き出しの開始・終了をタイムラインの範囲内で指定してください。');
  }

  const clips = [];
  let clipStart = 0;
  for (const clip of project.clips) {
    if (clipStart >= end) break;
    const clipEnd = clipStart + (clip.out - clip.in);
    if (clipEnd > start) {
      clips.push({
        ...clip,
        in: start > clipStart ? clip.in + (start - clipStart) : clip.in,
        out: end < clipEnd ? clip.in + (end - clipStart) : clip.out,
      });
    }
    clipStart = clipEnd;
  }

  const captions = project.captions
    .filter(caption => caption.end > start && caption.start < end)
    .map(caption => ({
      ...caption,
      start: Math.max(caption.start, start) - start,
      end: Math.min(caption.end, end) - start,
    }));
  return { ...project, clips, captions };
}

export function locateClip(project, time) {
  if (project.clips.length === 0) return null;
  if (!Number.isFinite(time)) throw new Error('時刻を秒数で指定してください。');
  const position = Math.max(0, time);
  let start = 0;
  for (const [index, clip] of project.clips.entries()) {
    const end = start + (clip.out - clip.in);
    const last = index === project.clips.length - 1;
    if (position < end || last) {
      const sourceTime = position >= end ? clip.out : Math.min(clip.out, clip.in + (position - start));
      return { clip, index, start, end, sourceTime };
    }
    start = end;
  }
  return null;
}

export function addAsset(project, asset) {
  requireRecord(asset, '素材の情報が正しくありません。');
  const nextAsset = validateAsset({ ...asset, id: asset.id ?? crypto.randomUUID() });
  if (project.assets.some(item => item.id === nextAsset.id)) {
    throw new Error('同じIDの素材がすでにあります。');
  }
  return appendClip({ ...project, assets: [...project.assets, nextAsset] }, nextAsset.id);
}

function findAsset(project, assetId) {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset) throw new Error('素材が見つかりません。');
  return asset;
}

export function appendClip(project, assetId) {
  const asset = findAsset(project, assetId);
  if (!Number.isFinite(timelineDuration(project) + asset.duration)) {
    throw new Error('タイムラインが長すぎます。');
  }
  const clip = { id: crypto.randomUUID(), assetId, in: 0, out: asset.duration };
  return { ...project, clips: [...project.clips, clip] };
}

function findClipIndex(project, clipId) {
  const index = project.clips.findIndex(item => item.id === clipId);
  if (index < 0) throw new Error('クリップが見つかりません。');
  return index;
}

export function splitClip(project, time) {
  const position = locateClip(project, time);
  if (!position || time <= position.start || time >= position.end) {
    throw new Error('クリップの途中に再生位置を合わせてください。');
  }
  const { clip, index, sourceTime } = position;
  const asset = findAsset(project, clip.assetId);
  const left = validateClip({ ...clip, out: sourceTime }, asset);
  const right = validateClip({ ...clip, id: crypto.randomUUID(), in: sourceTime }, asset);
  return { ...project, clips: project.clips.toSpliced(index, 1, left, right) };
}

export function trimClip(project, clipId, inPoint, outPoint) {
  const index = findClipIndex(project, clipId);
  const clip = project.clips[index];
  const asset = findAsset(project, clip.assetId);
  const trimmed = validateClip({ ...clip, in: inPoint, out: outPoint }, asset);
  const nextProject = { ...project, clips: project.clips.toSpliced(index, 1, trimmed) };
  if (!Number.isFinite(timelineDuration(nextProject))) throw new Error('タイムラインが長すぎます。');
  return nextProject;
}

export function removeClip(project, clipId) {
  const index = findClipIndex(project, clipId);
  return { ...project, clips: project.clips.toSpliced(index, 1) };
}

export function moveClip(project, clipId, delta) {
  if (!Number.isSafeInteger(delta)) throw new Error('移動するクリップ数を整数で指定してください。');
  const index = findClipIndex(project, clipId);
  const target = Math.min(project.clips.length - 1, Math.max(0, index + delta));
  if (target === index) return project;
  const clips = [...project.clips];
  const [clip] = clips.splice(index, 1);
  clips.splice(target, 0, clip);
  return { ...project, clips };
}

export function setCaption(project, caption) {
  requireRecord(caption, '字幕の情報が正しくありません。');
  const nextCaption = validateCaption({ ...caption, id: caption.id ?? crypto.randomUUID() });
  const index = project.captions.findIndex(item => item.id === nextCaption.id);
  const captions = index < 0
    ? [...project.captions, nextCaption]
    : project.captions.toSpliced(index, 1, nextCaption);
  return { ...project, captions };
}

export function removeCaption(project, id) {
  const index = project.captions.findIndex(item => item.id === id);
  if (index < 0) throw new Error('字幕が見つかりません。');
  return { ...project, captions: project.captions.toSpliced(index, 1) };
}
