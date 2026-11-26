import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addAsset, appendClip, createProject, locateClip, moveClip, parseProject,
  removeCaption, removeClip, setCaption, sliceProject, splitClip, timelineDuration, trimClip,
} from '../src/project.mjs';

function asset(id = 'a', duration = 8) {
  return { id, name: `${id}.mp4`, duration, size: 1024, lastModified: 1_800_000_000_000 };
}

test('add, append and remove clips without modifying previous project snapshots', () => {
  const empty = createProject();
  const initial = addAsset(empty, asset());
  const repeated = appendClip(initial, 'a');
  const edited = removeClip(repeated, repeated.clips[0].id);

  assert.equal(locateClip(empty, 0), null);
  assert.equal(empty.assets.length, 0);
  assert.equal(initial.clips.length, 1);
  assert.equal(timelineDuration(repeated), 16);
  assert.notEqual(repeated.clips[0].id, repeated.clips[1].id);
  assert.deepEqual(edited.clips, [repeated.clips[1]]);
  assert.equal(edited.assets.length, 1);
  assert.throws(() => addAsset(edited, asset()), /ID/);
  assert.throws(() => appendClip(edited, 'missing'), /素材/);
});

test('locate and split a trimmed clip using source time and half-open timeline intervals', () => {
  const initial = addAsset(addAsset(createProject(), asset()), asset('b', 4));
  const clipId = initial.clips[1].id;
  const trimmed = trimClip(initial, clipId, 0.75, 3.5);
  const position = locateClip(trimmed, 8);

  assert.equal(position.index, 1);
  assert.equal(position.sourceTime, 0.75);
  assert.equal(locateClip(trimmed, -1).sourceTime, 0);
  assert.equal(locateClip(trimmed, 10.75).sourceTime, 3.5);
  assert.equal(locateClip(trimmed, 100).sourceTime, 3.5);

  const split = splitClip(trimmed, 9.25);
  assert.deepEqual(split.clips.slice(1).map(({ in: start, out: end }) => [start, end]), [
    [0.75, 2], [2, 3.5],
  ]);
  assert.equal(split.clips[1].id, clipId);
  assert.notEqual(split.clips[2].id, clipId);
  assert.equal(timelineDuration(split), timelineDuration(trimmed));
  assert.throws(() => splitClip(trimmed, 8), /途中/);
  assert.throws(() => splitClip(trimmed, 10.75), /途中/);
  assert.throws(() => splitClip(trimmed, 8.01), /0.05/);
  assert.throws(() => trimClip(trimmed, clipId, 0, 4.01), /範囲/);
});

test('reordering and removing clips leave caption times anchored to the timeline', () => {
  const initial = addAsset(addAsset(createProject(), asset()), asset('b', 4));
  const captioned = setCaption(initial, { start: 2, end: 9, text: '演奏開始' });
  const edited = setCaption(captioned, { ...captioned.captions[0], text: '開演' });
  const reordered = moveClip(edited, edited.clips[0].id, 1);
  const cropped = removeClip(reordered, reordered.clips[1].id);

  assert.deepEqual(reordered.clips.map(clip => clip.assetId), ['b', 'a']);
  assert.equal(captioned.captions[0].text, '演奏開始');
  assert.deepEqual(cropped.captions, [{ ...captioned.captions[0], text: '開演' }]);
  assert.equal(removeCaption(cropped, cropped.captions[0].id).captions.length, 0);
  assert.throws(() => setCaption(initial, { start: 2, end: 2, text: '無効' }), /字幕/);
});

test('import round-trips short source clips and rejects corrupted project references', () => {
  const project = addAsset(createProject(), asset('short', 0.02));
  assert.deepEqual(parseProject(JSON.stringify(project)), project);
  assert.throws(() => splitClip(project, 0.01), /0.05/);
  assert.throws(() => parseProject(JSON.stringify({ ...project, version: 2 })), /バージョン/);
  assert.throws(() => parseProject(JSON.stringify({ ...project, assets: [] })), /素材/);
  assert.throws(() => parseProject(JSON.stringify({ ...project, clips: [...project.clips, ...project.clips] })), /重複/);
  assert.throws(() => parseProject(JSON.stringify({ ...project, clips: [{ ...project.clips[0], out: 1 }] })), /範囲/);
});

test('export range clips the intersecting source ranges and rebases overlapping captions', () => {
  let project = addAsset(addAsset(createProject(), asset()), asset('b', 4));
  project = trimClip(project, project.clips[1].id, 0.5, 3.5);
  project = setCaption(project, { id: 'before', start: 0, end: 7.5, text: '前' });
  project = setCaption(project, { id: 'overlap', start: 7, end: 8.5, text: '途中' });
  project = setCaption(project, { id: 'later', start: 8.75, end: 11, text: '後' });
  project = setCaption(project, { id: 'after', start: 9.5, end: 12, text: '範囲外' });
  const snapshot = JSON.stringify(project);

  const sliced = sliceProject(project, 7.5, 9.5);

  assert.equal(sliced.assets, project.assets);
  assert.deepEqual(sliced.clips, [
    { ...project.clips[0], in: 7.5, out: 8 },
    { ...project.clips[1], in: 0.5, out: 2 },
  ]);
  assert.deepEqual(sliced.captions, [
    { ...project.captions[1], start: 0, end: 1 },
    { ...project.captions[2], start: 1.25, end: 2 },
  ]);
  assert.equal(timelineDuration(sliced), 2);
  assert.equal(JSON.stringify(project), snapshot);
});

test('export range excludes clips ending at its start and allows short output fragments', () => {
  const project = addAsset(addAsset(createProject(), asset()), asset('b', 4));
  const sliced = sliceProject(project, 8, 8.02);

  assert.equal(sliced.clips.length, 1);
  assert.equal(sliced.clips[0].assetId, 'b');
  assert.ok(Math.abs(timelineDuration(sliced) - 0.02) < 1e-9);
  assert.deepEqual(sliceProject(project, 0, 8).clips, [project.clips[0]]);
  assert.deepEqual(sliceProject(project, 0, 12), project);
  for (const [start, end] of [[-1, 1], [1, 0], [0, 0], [0, 13], [NaN, 1], [0, Infinity]]) {
    assert.throws(() => sliceProject(project, start, end), /書き出し/);
  }
});
