const MIN_CLIP_DURATION = 0.05;
const TIME_TOLERANCE = 1e-9;

export function createProject() {
  return { version: 1, assets: [], clips: [], captions: [], audioClips: [] };
}

export function assetKind(asset) {
  return asset?.kind ?? 'video';
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
  const { id, name, duration, size, lastModified, kind } = asset;
  if (!hasText(id) || !hasText(name) || !Number.isFinite(duration) || duration <= 0
      || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(lastModified)
      || (kind !== undefined && !['video', 'image', 'audio'].includes(kind))) {
    throw new Error('素材の情報が正しくありません。');
  }
  const fields = { id, name, duration, size, lastModified };
  return kind === undefined ? fields : { ...fields, kind };
}

function validateClip(clip, asset) {
  requireRecord(clip, 'クリップの情報が正しくありません。');
  if (!asset) throw new Error('クリップの素材が見つかりません。');
  const { id, assetId, in: start, out: end } = clip;
  if (!hasText(id) || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end > asset.duration || end <= start) {
    throw new Error('クリップの開始・終了を素材の範囲内で指定してください。');
  }
  return { id, assetId, in: start, out: end };
}

function validateClipEdit(clip, asset) {
  const validated = validateClip(clip, asset);
  const minimum = Math.min(MIN_CLIP_DURATION, asset.duration);
  const tolerance = Math.min(TIME_TOLERANCE, minimum * 1e-6);
  if (validated.out - validated.in < minimum - tolerance) {
    throw new Error('クリップの長さは0.05秒以上にしてください。');
  }
  return validated;
}

export function audioClipEnd(clip) {
  return clip.start + (clip.out - clip.in);
}

function validateAudioClip(clip, asset) {
  if (assetKind(asset) !== 'audio') throw new Error('音声素材が見つかりません。');
  const source = validateClip(clip, asset);
  const { start, gain } = clip;
  const validated = { ...source, start, gain };
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(audioClipEnd(validated))
      || audioClipEnd(validated) <= start || !Number.isFinite(gain) || gain < 0 || gain > 2) {
    throw new Error('音声の配置時刻は0秒以上、音量は0〜200%で指定してください。');
  }
  return validated;
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
  const clips = input.clips.map(clip => {
    const asset = assetIndex.get(clip?.assetId);
    if (assetKind(asset) === 'audio') throw new Error('音声素材は音声トラックに配置してください。');
    return validateClip(clip, asset);
  });
  if (input.audioClips !== undefined && !Array.isArray(input.audioClips)) {
    throw new Error('音声トラックのデータが正しくありません。');
  }
  const audioClips = (input.audioClips ?? []).map(clip => validateAudioClip(clip, assetIndex.get(clip?.assetId)));
  const captions = input.captions.map(validateCaption);
  uniqueById([...clips, ...audioClips]);
  uniqueById(captions);
  const project = { version: 1, assets, clips, captions, audioClips };
  if (!Number.isFinite(timelineDuration(project))) throw new Error('タイムラインが長すぎます。');
  return project;
}

export function timelineDuration(project) {
  return (project.audioClips ?? []).reduce((duration, clip) => Math.max(duration, audioClipEnd(clip)), visualDuration(project));
}

export function visualDuration(project) {
  return project.clips.reduce((sum, clip) => sum + (clip.out - clip.in), 0);
}

// A range can keep a fragment below the minimum for manual split and trim.
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
  const audioClips = (project.audioClips ?? []).flatMap(clip => {
    const clipEnd = audioClipEnd(clip);
    if (clipEnd <= start || end <= clip.start) return [];
    const overlapStart = Math.max(clip.start, start);
    return [{
      ...clip,
      start: overlapStart - start,
      in: clip.start < start ? clip.in + (start - clip.start) : clip.in,
      out: end < clipEnd ? clip.in + (end - clip.start) : clip.out,
    }];
  });
  return { ...project, clips, captions, audioClips };
}

function boundaryTolerance(time) {
  return Number.EPSILON * Math.max(Math.abs(time), 1) * 4;
}

export function rippleDeleteRange(project, start, end) {
  const duration = timelineDuration(project);
  if (!Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || start >= duration || end - duration > boundaryTolerance(duration)) {
    throw new Error('削除の開始・終了をタイムラインの範囲内で指定してください。');
  }
  const rangeEnd = Math.min(end, duration);
  const clips = [];
  let clipStart = 0;

  for (const clip of project.clips) {
    const clipEnd = clipStart + (clip.out - clip.in);
    const tolerance = Math.min(boundaryTolerance(clipEnd), (clip.out - clip.in) / 2);
    if (clipEnd - start <= tolerance || rangeEnd - clipStart <= tolerance) {
      clips.push(clip);
    } else {
      const leftOut = clip.in + (start - clipStart);
      const rightIn = clip.in + (rangeEnd - clipStart);
      const keepLeft = start - clipStart > tolerance && leftOut > clip.in;
      if (keepLeft) clips.push({ ...clip, out: leftOut });
      if (clipEnd - rangeEnd > tolerance && rightIn < clip.out) {
        clips.push({
          ...clip,
          id: keepLeft ? crypto.randomUUID() : clip.id,
          in: rightIn,
        });
      }
    }
    clipStart = clipEnd;
  }

  const shift = time => {
    if (time <= start) return time;
    if (time <= rangeEnd) return start;
    return start + (time - rangeEnd);
  };
  const audioClips = (project.audioClips ?? []).flatMap(clip => {
    const clipEnd = audioClipEnd(clip);
    const tolerance = Math.min(boundaryTolerance(clipEnd), (clip.out - clip.in) / 2);
    if (clipEnd - start <= tolerance) return [clip];
    if (rangeEnd - clip.start <= tolerance) return [{ ...clip, start: shift(clip.start) }];
    const fragments = [];
    const leftOut = clip.in + (start - clip.start);
    const rightIn = clip.in + (rangeEnd - clip.start);
    const keepLeft = start - clip.start > tolerance && leftOut > clip.in;
    if (keepLeft) fragments.push({ ...clip, out: leftOut });
    if (clipEnd - rangeEnd > tolerance && rightIn < clip.out) {
      fragments.push({
        ...clip,
        id: keepLeft ? crypto.randomUUID() : clip.id,
        start,
        in: rightIn,
      });
    }
    return fragments;
  });
  const captions = clips.length === 0 && audioClips.length === 0 ? [] : project.captions
    .map(caption => ({ ...caption, start: shift(caption.start), end: shift(caption.end) }))
    .filter(caption => caption.end > caption.start);

  return { ...project, clips, captions, audioClips };
}

export function locateClip(project, time) {
  if (project.clips.length === 0) return null;
  if (!Number.isFinite(time)) throw new Error('時刻を秒数で指定してください。');
  const position = Math.max(0, time);
  let start = 0;
  for (const [index, clip] of project.clips.entries()) {
    const end = start + (clip.out - clip.in);
    const last = index === project.clips.length - 1;
    if (last && position > end && (project.audioClips ?? []).some(item => audioClipEnd(item) > end)) return null;
    if (position < end || last) {
      const sourceTime = position >= end ? clip.out : Math.min(clip.out, clip.in + (position - start));
      return { clip, index, start, end, sourceTime };
    }
    start = end;
  }
  return null;
}

export function addAsset(project, asset, audioStart = 0) {
  requireRecord(asset, '素材の情報が正しくありません。');
  const nextAsset = validateAsset({ ...asset, id: asset.id ?? crypto.randomUUID() });
  if (project.assets.some(item => item.id === nextAsset.id)) {
    throw new Error('同じIDの素材がすでにあります。');
  }
  const next = { ...project, assets: [...project.assets, nextAsset] };
  return assetKind(nextAsset) === 'audio'
    ? addAudioClip(next, nextAsset.id, audioStart)
    : appendClip(next, nextAsset.id);
}

function findAsset(project, assetId) {
  const asset = project.assets.find(item => item.id === assetId);
  if (!asset) throw new Error('素材が見つかりません。');
  return asset;
}

export function appendClip(project, assetId) {
  const asset = findAsset(project, assetId);
  const kind = assetKind(asset);
  if (kind === 'audio') throw new Error('音声素材は音声トラックに配置してください。');
  const duration = kind === 'image' ? Math.min(3, asset.duration) : asset.duration;
  if (!Number.isFinite(visualDuration(project) + duration)) {
    throw new Error('タイムラインが長すぎます。');
  }
  const clip = { id: crypto.randomUUID(), assetId, in: 0, out: duration };
  return { ...project, clips: [...project.clips, clip] };
}

function selectAudioClip(project, id) {
  const clips = project.audioClips ?? [];
  const index = clips.findIndex(clip => clip.id === id);
  if (index < 0) throw new Error('音声クリップが見つかりません。');
  return { clips, index, clip: clips[index] };
}

export function addAudioClip(project, assetId, start = 0) {
  const asset = findAsset(project, assetId);
  const clip = validateAudioClip({ id: crypto.randomUUID(), assetId, start, in: 0, out: asset.duration, gain: 1 }, asset);
  return { ...project, audioClips: [...(project.audioClips ?? []), clip] };
}

export function updateAudioClip(project, id, { start, in: inPoint, out, gain }) {
  const { clips, index, clip } = selectAudioClip(project, id);
  const asset = findAsset(project, clip.assetId);
  const updated = validateAudioClip({
    ...clip,
    start: start ?? clip.start,
    in: inPoint ?? clip.in,
    out: out ?? clip.out,
    gain: gain ?? clip.gain,
  }, asset);
  if (updated.start === clip.start && updated.in === clip.in && updated.out === clip.out && updated.gain === clip.gain) return project;
  return { ...project, audioClips: clips.toSpliced(index, 1, updated) };
}

export function removeAudioClip(project, id) {
  const { clips, index } = selectAudioClip(project, id);
  return { ...project, audioClips: clips.toSpliced(index, 1) };
}

export function splitAudioClip(project, id, time) {
  const { clips, index, clip } = selectAudioClip(project, id);
  if (!Number.isFinite(time) || time <= clip.start || time >= audioClipEnd(clip)) {
    throw new Error('選択した音声の途中に再生位置を合わせてください。');
  }
  const asset = findAsset(project, clip.assetId);
  const splitAt = clip.in + (time - clip.start);
  const left = validateAudioClip({ ...clip, out: splitAt }, asset);
  const right = validateAudioClip({ ...clip, id: crypto.randomUUID(), start: time, in: splitAt }, asset);
  return { ...project, audioClips: clips.toSpliced(index, 1, left, right) };
}

export function duplicateAudioClip(project, id) {
  const { clips, index, clip } = selectAudioClip(project, id);
  const asset = findAsset(project, clip.assetId);
  const duplicate = validateAudioClip({ ...clip, id: crypto.randomUUID(), start: audioClipEnd(clip) }, asset);
  return { ...project, audioClips: clips.toSpliced(index + 1, 0, duplicate) };
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
  const left = validateClipEdit({ ...clip, out: sourceTime }, asset);
  const right = validateClipEdit({ ...clip, id: crypto.randomUUID(), in: sourceTime }, asset);
  return { ...project, clips: project.clips.toSpliced(index, 1, left, right) };
}

export function trimClip(project, clipId, inPoint, outPoint) {
  const index = findClipIndex(project, clipId);
  const clip = project.clips[index];
  const asset = findAsset(project, clip.assetId);
  const trimmed = validateClipEdit({ ...clip, in: inPoint, out: outPoint }, asset);
  const nextProject = { ...project, clips: project.clips.toSpliced(index, 1, trimmed) };
  if (!Number.isFinite(timelineDuration(nextProject))) throw new Error('タイムラインが長すぎます。');
  return nextProject;
}

export function trimClipToPlayhead(project, clipId, time, edge) {
  if (edge !== 'in' && edge !== 'out') {
    throw new Error('クリップの開始または終了を指定してください。');
  }
  const position = locateClip(project, time);
  if (!position || position.clip.id !== clipId || time <= position.start || time >= position.end) {
    throw new Error('選択したクリップの途中に再生位置を合わせてください。');
  }
  const {clip, sourceTime} = position;
  return edge === 'in'
    ? trimClip(project, clipId, sourceTime, clip.out)
    : trimClip(project, clipId, clip.in, sourceTime);
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
