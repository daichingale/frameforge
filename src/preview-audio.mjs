export function createPreviewAudio() {
  let context;
  const cache = new Map();

  async function prepare(clips, sources, start, end, signal) {
    const playable = clips.filter(clip => clip.gain > 0 && sources.has(clip.assetId)
      && clip.start < end && clip.start + (clip.out - clip.in) > start);
    if (!playable.length) return () => () => {};
    const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('このブラウザでは音声トラックを試聴できません。');
    context ??= new AudioContext();
    await context.resume();
    const active = await Promise.all(playable.map(async clip => {
      const url = sources.get(clip.assetId);
      if (!cache.has(url)) {
        const decoded = fetch(url).then(response => response.arrayBuffer())
          .then(data => context.decodeAudioData(data)).catch(error => {
            cache.delete(url);
            throw new Error('音声トラックを読み込めませんでした。', {cause: error});
          });
        cache.set(url, decoded);
      }
      return {clip, buffer: await cache.get(url)};
    }));
    signal.throwIfAborted();
    return rate => {
      const now = context.currentTime;
      const nodes = [];
      const stop = () => {
        signal.removeEventListener('abort', stop);
        for (const {source, volume} of nodes.splice(0)) {
          source.stop();
          source.disconnect();
          volume.disconnect();
        }
      };
      signal.throwIfAborted();
      signal.addEventListener('abort', stop, {once: true});
      try {
        for (const {clip, buffer} of active) {
          const at = Math.max(start, clip.start);
          const until = Math.min(end, clip.start + (clip.out - clip.in));
          const offset = clip.in + (at - clip.start);
          if (offset >= buffer.duration) continue;
          const source = context.createBufferSource();
          const volume = context.createGain();
          source.buffer = buffer;
          source.playbackRate.value = rate;
          volume.gain.value = clip.gain;
          source.connect(volume).connect(context.destination);
          source.start(now + (at - start) / rate, offset, Math.min(until - at, buffer.duration - offset));
          nodes.push({source, volume});
        }
      } catch (error) {
        stop();
        throw error;
      }
      return stop;
    };
  }
  return {prepare, release: url => cache.delete(url)};
}
