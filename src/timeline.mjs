const DEFAULT_ZOOM = 88;
const MAX_WIDTH = 20_000_000;
const SNAP_DISTANCE = 6;
const MAX_SNAP_SECONDS = 0.25;
const DRAG_DISTANCE = 4;
const MIN_CLIP = 0.05;
const CLIP_SELECTOR = '[data-clip-id]';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function node(tag, className, label) {
  const item = document.createElement(tag);
  item.className = className;
  if (label) item.setAttribute('aria-label', label);
  if (tag === 'button') item.type = 'button';
  return item;
}

function stamp(seconds, decimals = 2) {
  const precision = 10 ** decimals;
  const units = Math.round(seconds * precision);
  const minutes = Math.floor(units / (60 * precision));
  const remainder = (units % (60 * precision)) / precision;
  return `${minutes}:${remainder.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')}`;
}

function tickInterval(minimum) {
  const magnitude = 10 ** Math.floor(Math.log10(minimum));
  const multiplier = [1, 2, 5, 10].find(value => value * magnitude >= minimum);
  return multiplier * magnitude;
}

function nearest(time, points, window) {
  let distance = window;
  let result = time;
  for (const point of points) {
    const gap = Math.abs(point - time);
    if (gap > distance) continue;
    distance = gap;
    result = point;
  }
  return result;
}

export function mountTimeline({
  element, onSelect, onSeek, onTrim, onMove, onTrimPreview, onCaptionSelect,
}) {
  element.classList.add('ff-timeline');
  const stage = node('div', 'ff-timeline-stage');
  const ruler = node('div', 'ff-timeline-ruler', 'タイムラインの再生位置');
  ruler.tabIndex = 0;
  ruler.setAttribute('role', 'slider');
  ruler.setAttribute('aria-valuemin', '0');
  ruler.setAttribute('aria-orientation', 'horizontal');
  const marks = node('div', 'ff-timeline-marks');
  marks.setAttribute('aria-hidden', 'true');
  const clipsLane = node('div', 'ff-timeline-clips', '動画クリップ');
  const captionsLane = node('div', 'ff-timeline-captions', '字幕の区間');
  const playhead = node('span', 'ff-timeline-head');
  const range = node('span', 'ff-timeline-range');
  const rangeStartMark = node('span', 'ff-timeline-range-point');
  const rangeEndMark = node('span', 'ff-timeline-range-point');
  const dropLine = node('span', 'ff-timeline-drop');
  const dragReadout = node('span', 'ff-timeline-drag-time');
  for (const decoration of [playhead, range, rangeStartMark, rangeEndMark, dropLine, dragReadout]) {
    decoration.setAttribute('aria-hidden', 'true');
  }
  ruler.append(marks);
  stage.append(ruler, clipsLane, captionsLane, range, rangeStartMark, rangeEndMark, dropLine, playhead, dragReadout);
  element.replaceChildren(stage);

  let entries = [];
  let duration = 0;
  let zoom = DEFAULT_ZOOM;
  let scale = zoom;
  let currentTime = 0;
  let rangeFrom = null;
  let rangeTo = null;
  let fitWidth = false;
  let interaction = null;
  let rulerFrame = 0;

  const pixels = seconds => seconds * scale;
  const snapWindow = () => Math.min(MAX_SNAP_SECONDS, SNAP_DISTANCE / scale);

  function position(item, seconds, length) {
    item.style.left = `${pixels(seconds)}px`;
    if (length !== undefined) item.style.width = `${pixels(length)}px`;
  }

  function updateRuler() {
    rulerFrame = 0;
    if (element.hidden || duration <= 0) return;
    const step = tickInterval(68 / scale);
    const first = Math.max(0, Math.ceil((element.scrollLeft - 72) / pixels(step)));
    const last = Math.min(
      Math.floor(duration / step + 1e-8),
      Math.ceil((element.scrollLeft + element.clientWidth + 72) / pixels(step)),
    );
    const tickDecimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
    const children = [];
    for (let index = first; index <= last; index++) {
      const time = index * step;
      const item = node('span', 'ff-timeline-mark');
      item.textContent = stamp(time, tickDecimals);
      position(item, time);
      children.push(item);
    }
    marks.replaceChildren(...children);
  }

  function scheduleRuler() {
    if (!rulerFrame) rulerFrame = requestAnimationFrame(updateRuler);
  }

  function setTime(seconds) {
    currentTime = clamp(seconds, 0, duration);
    position(playhead, currentTime);
    ruler.setAttribute('aria-valuenow', String(currentTime));
    ruler.setAttribute('aria-valuetext', stamp(currentTime, 3));
  }

  function updateRange() {
    rangeStartMark.hidden = rangeFrom === null;
    rangeEndMark.hidden = rangeTo === null;
    range.hidden = rangeFrom === null || rangeTo === null;
    if (!rangeStartMark.hidden) position(rangeStartMark, rangeFrom);
    if (!rangeEndMark.hidden) position(rangeEndMark, rangeTo);
    if (!range.hidden) position(range, Math.min(rangeFrom, rangeTo), Math.abs(rangeTo - rangeFrom));
  }

  function setRange(start, end) {
    rangeFrom = Number.isFinite(start) ? clamp(start, 0, duration) : null;
    rangeTo = Number.isFinite(end) ? clamp(end, 0, duration) : null;
    updateRange();
  }

  function formatClip(item, entry, start = entry.start, length = entry.end - entry.start) {
    position(item, start, length);
    item.classList.toggle('ff-timeline-narrow', pixels(length) < 66);
    item.classList.toggle('ff-timeline-tiny', pixels(length) < 26);
  }

  function layout(anchor = false) {
    const oldScale = scale;
    const first = element.scrollLeft / oldScale;
    const markerOffset = (currentTime - first) * oldScale;
    const width = Math.max(1, element.clientWidth - 2);
    const requested = fitWidth && duration ? width / duration : zoom;
    scale = duration ? Math.min(requested, MAX_WIDTH / duration) : requested;
    stage.style.width = `${Math.max(1, Math.ceil(pixels(duration)) + 1)}px`;
    ruler.setAttribute('aria-valuemax', String(duration));
    for (const entry of entries) formatClip(entry.item, entry);
    for (const item of captionsLane.children) {
      const start = Number(item.dataset.start);
      position(item, start, Number(item.dataset.end) - start);
    }
    setTime(currentTime);
    updateRange();
    if (anchor && markerOffset >= 0 && markerOffset <= width) {
      element.scrollLeft = pixels(currentTime) - markerOffset;
    } else if (anchor) {
      element.scrollLeft = pixels(first);
    }
    scheduleRuler();
  }

  function trimHandle(edge, name) {
    const handle = node('button', 'ff-timeline-handle', `${name}の${edge === 'in' ? '開始' : '終了'}をトリム`);
    handle.dataset.edge = edge;
    handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
    return handle;
  }

  function clipItem(clip, asset, selected, linked) {
    const item = node('div', 'clip-block ff-timeline-clip');
    item.dataset.clipId = clip.id;
    item.classList.toggle('selected', selected);
    item.classList.toggle('missing', !linked);
    const name = asset.name;
    const button = node('button', 'ff-timeline-select', `${name}、${stamp(clip.out - clip.in)}`);
    button.textContent = name;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
    button.title = name;
    const leading = trimHandle('in', name);
    const trailing = trimHandle('out', name);
    leading.tabIndex = trailing.tabIndex = selected ? 0 : -1;
    item.append(button, leading, trailing);
    return item;
  }

  function setSelection(id) {
    for (const {clip, item} of entries) {
      const selected = clip.id === id;
      item.classList.toggle('selected', selected);
      item.firstElementChild.setAttribute('aria-pressed', String(selected));
      for (const handle of item.querySelectorAll('[data-edge]')) handle.tabIndex = selected ? 0 : -1;
    }
  }

  function captionItem(caption, row) {
    const item = node(onCaptionSelect ? 'button' : 'span', 'ff-timeline-caption');
    item.dataset.start = caption.start;
    item.dataset.end = Math.min(caption.end, duration);
    item.dataset.captionId = caption.id;
    item.style.top = `${row * 24 + 3}px`;
    item.textContent = caption.text;
    item.title = `${stamp(caption.start)}–${stamp(caption.end)} ${caption.text}`;
    if (onCaptionSelect) item.addEventListener('click', () => onCaptionSelect(caption.id));
    return item;
  }

  function rebuildCaptions(captions) {
    const lanes = [];
    const children = [];
    const ordered = [...captions].sort((a, b) => a.start - b.start || a.end - b.end);
    for (const caption of ordered) {
      if (caption.start >= duration) break;
      const free = lanes.findIndex(end => end <= caption.start);
      const row = free < 0 ? lanes.length : free;
      lanes[row] = caption.end;
      children.push(captionItem(caption, row));
    }
    captionsLane.hidden = !children.length;
    captionsLane.style.height = `${lanes.length * 24 + 6}px`;
    captionsLane.replaceChildren(...children);
  }

  function render({project, selectedId, sources}) {
    const active = document.activeElement;
    const focusClip = active?.closest(CLIP_SELECTOR)?.dataset.clipId;
    const focusEdge = active?.dataset.edge;
    const focusCaption = active?.dataset.captionId;
    clearInteraction();
    duration = 0;
    const assets = new Map(project.assets.map(asset => [asset.id, asset]));
    entries = project.clips.map(clip => {
      const start = duration;
      duration += clip.out - clip.in;
      const asset = assets.get(clip.assetId);
      const item = clipItem(clip, asset, clip.id === selectedId, sources.has(clip.assetId));
      return {clip, asset, item, start, end: duration};
    });
    clipsLane.replaceChildren(...entries.map(entry => entry.item));
    rebuildCaptions(project.captions);
    layout();
    if (focusClip) {
      const item = entries.find(entry => entry.clip.id === focusClip)?.item;
      item?.querySelector(focusEdge ? `[data-edge="${focusEdge}"]` : '.ff-timeline-select')?.focus({preventScroll: true});
    }
    if (focusCaption) {
      [...captionsLane.children].find(item => item.dataset.captionId === focusCaption)?.focus({preventScroll: true});
    }
  }

  function pointerTime(clientX) {
    return (clientX - element.getBoundingClientRect().left + element.scrollLeft) / scale;
  }

  function cue(time, shouldSnap) {
    const positionTime = clamp(time, 0, duration);
    const snapped = shouldSnap ? nearest(positionTime, [0, ...entries.map(entry => entry.end)], snapWindow()) : positionTime;
    onSeek(snapped);
  }

  function limits(entry, edge) {
    const {clip, asset} = entry;
    const minimum = Math.min(MIN_CLIP, asset.duration);
    return edge === 'in' ? [0, clip.out - minimum] : [clip.in + minimum, asset.duration];
  }

  function trimmed(entry, edge, delta, shouldSnap) {
    const {clip} = entry;
    const [min, max] = limits(entry, edge);
    if (max < min) return [clip.in, clip.out];
    let value = clamp(clip[edge] + delta, min, max);
    if (shouldSnap) {
      const points = [min, max];
      for (const other of entries) {
        if (other === entry || other.clip.assetId !== clip.assetId) continue;
        for (const point of [other.clip.in, other.clip.out]) {
          if (point >= min && point <= max) points.push(point);
        }
      }
      value = nearest(value, points, snapWindow());
    }
    return edge === 'in' ? [value, clip.out] : [clip.in, value];
  }

  function updateReadout(time, label) {
    dragReadout.textContent = label;
    dragReadout.hidden = false;
    const visible = clamp(pixels(time), element.scrollLeft + 16, element.scrollLeft + element.clientWidth - 16);
    dragReadout.style.left = `${visible}px`;
  }

  function updateTrim(drag, delta) {
    const {entry, edge, index} = drag;
    const [start, end] = trimmed(entry, edge, delta, !drag.alt);
    const sizeDelta = end - start - (entry.end - entry.start);
    formatClip(entry.item, entry, entry.start, end - start);
    for (const next of entries.slice(index + 1)) formatClip(next.item, next, next.start + sizeDelta);
    updateReadout(edge === 'in' ? entry.start : entry.end + sizeDelta, `素材 ${stamp(edge === 'in' ? start : end, 3)}`);
    if (drag.inPoint === start && drag.outPoint === end) return;
    drag.inPoint = start;
    drag.outPoint = end;
    onTrimPreview?.(entry.clip.id, start, end);
  }

  function updateMove(drag, delta) {
    const mid = (drag.entry.start + drag.entry.end) / 2 + delta;
    let target = drag.index;
    while (target < entries.length - 1 && mid >= (entries[target + 1].start + entries[target + 1].end) / 2) target++;
    while (target > 0 && mid < (entries[target - 1].start + entries[target - 1].end) / 2) target--;
    drag.target = target;
    drag.entry.item.style.transform = `translateX(${pixels(delta)}px)`;
    dropLine.hidden = target === drag.index;
    if (!dropLine.hidden) position(dropLine, target > drag.index ? entries[target].end : entries[target].start);
  }

  function paintInteraction(drag) {
    drag.frame = 0;
    if (interaction !== drag) return;
    if (drag.kind === 'seek') {
      cue(pointerTime(drag.clientX), !drag.alt);
      return;
    }
    if (!drag.moved) return;
    const bounds = element.getBoundingClientRect();
    const left = drag.clientX - bounds.left;
    const right = bounds.right - drag.clientX;
    const before = element.scrollLeft;
    const canScroll = (left < 30 && before > 0) || (right < 30 && before + element.clientWidth < element.scrollWidth);
    if (canScroll) {
      const direction = left < 30 ? -1 : 1;
      const edgeGap = Math.min(left, right);
      element.scrollLeft += direction * clamp((30 - edgeGap) * 0.33, 1, 18);
    }
    const delta = pointerTime(drag.clientX) - drag.startTime;
    if (drag.edge) updateTrim(drag, delta);
    else updateMove(drag, delta);
    if (canScroll && element.scrollLeft !== before) {
      drag.frame = requestAnimationFrame(() => paintInteraction(drag));
    }
  }

  function clearInteraction() {
    const drag = interaction;
    if (!drag) return;
    interaction = null;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    if (drag.entry) {
      drag.entry.item.classList.remove('ff-timeline-dragging');
      drag.entry.item.style.transform = '';
      for (const entry of entries.slice(drag.index)) formatClip(entry.item, entry);
    }
    dropLine.hidden = true;
    dragReadout.hidden = true;
    if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
  }

  function startPointer(event) {
    if (interaction || !event.isPrimary || event.button !== 0) return;
    const item = event.target.closest(CLIP_SELECTOR);
    const index = item ? entries.findIndex(entry => entry.item === item) : -1;
    if (index < 0 && (!ruler.contains(event.target) || event.pointerType === 'touch')) return;
    const entry = entries[index];
    interaction = {
      pointerId: event.pointerId,
      kind: entry ? 'clip' : 'seek',
      index,
      entry,
      edge: event.target.closest('[data-edge]')?.dataset.edge,
      clientX: event.clientX,
      startX: event.clientX,
      startTime: pointerTime(event.clientX),
      moved: false,
      alt: event.altKey,
      frame: 0,
      target: index,
      inPoint: entry?.clip.in,
      outPoint: entry?.clip.out,
    };
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    if (!entry) paintInteraction(interaction);
  }

  function movePointer(event) {
    const drag = interaction;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.clientX = event.clientX;
    drag.alt = event.altKey;
    if (!drag.moved && Math.abs(drag.clientX - drag.startX) >= DRAG_DISTANCE) {
      drag.moved = true;
      drag.entry?.item.classList.add('ff-timeline-dragging');
    }
    if (!drag.frame) drag.frame = requestAnimationFrame(() => paintInteraction(drag));
  }

  function finishPointer(event) {
    const drag = interaction;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    movePointer(event);
    cancelAnimationFrame(drag.frame);
    paintInteraction(drag);
    clearInteraction();
    if (drag.kind === 'seek') return;
    const {entry, edge, index, moved, target, inPoint, outPoint} = drag;
    if (event.pointerType !== 'touch') entry.item.firstElementChild.focus({preventScroll: true});
    onSelect(entry.clip.id);
    if (!moved) return;
    if (edge && (entry.clip.in !== inPoint || entry.clip.out !== outPoint)) onTrim(entry.clip.id, inPoint, outPoint);
    if (!edge && target !== index) onMove(entry.clip.id, target);
  }

  function activate(event) {
    const item = event.target.closest(CLIP_SELECTOR);
    if (item && event.detail === 0) {
      onSelect(item.dataset.clipId);
    } else if (ruler.contains(event.target)) {
      // Mouse scrubbing is already handled by the captured pointer. A touch
      // tap seeks, while a horizontal swipe scrolls the long timeline.
      if (event.pointerType === 'touch') cue(pointerTime(event.clientX), true);
    } else if (event.target === clipsLane || event.target === captionsLane) {
      cue(pointerTime(event.clientX), !event.altKey);
    }
  }

  function keyboard(event) {
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const step = event.shiftKey ? 1 : 1 / 30;
    if (event.target === ruler) {
      const time = event.key === 'Home' ? 0 : event.key === 'End' ? duration : currentTime + delta * step;
      if (!delta && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      cue(time, false);
      const left = pixels(clamp(time, 0, duration));
      if (left < element.scrollLeft || left > element.scrollLeft + element.clientWidth - 8) {
        element.scrollLeft = left - element.clientWidth / 2;
      }
      return;
    }
    const item = event.target.closest(CLIP_SELECTOR);
    if (!item || !delta) return;
    const index = entries.findIndex(entry => entry.item === item);
    const edge = event.target.dataset.edge;
    if (!edge && !event.altKey) return;
    event.preventDefault();
    const entry = entries[index];
    onSelect(entry.clip.id);
    if (edge) {
      const [start, end] = trimmed(entry, edge, delta * step, false);
      if (entry.clip.in !== start || entry.clip.out !== end) onTrim(entry.clip.id, start, end);
    } else {
      const target = clamp(index + delta, 0, entries.length - 1);
      if (target !== index) onMove(entry.clip.id, target);
    }
  }

  dropLine.hidden = true;
  dragReadout.hidden = true;
  updateRange();
  element.addEventListener('scroll', scheduleRuler, {passive: true});
  element.addEventListener('pointerdown', startPointer);
  element.addEventListener('pointermove', movePointer);
  element.addEventListener('pointerup', finishPointer);
  element.addEventListener('pointercancel', clearInteraction);
  element.addEventListener('lostpointercapture', clearInteraction);
  element.addEventListener('click', activate);
  element.addEventListener('keydown', keyboard);
  const observer = new ResizeObserver(() => {
    if (!interaction) layout();
  });
  observer.observe(element);

  return {
    render,
    setSelection,
    setTime,
    setRange,
    setZoom(value) {
      if (!Number.isFinite(value) || value <= 0) return;
      zoom = clamp(value, 1, 1000);
      fitWidth = false;
      layout(true);
    },
    fit() {
      fitWidth = true;
      layout();
      element.scrollLeft = 0;
      return scale;
    },
  };
}
