import { captionAt, drawFrame } from './render.mjs'

const mimeTypes = {
  mp4: ['video/mp4;codecs=avc1.42001f,mp4a.40.2', 'video/mp4'],
  webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
}

function supportedMimeType(format) {
  if (!Object.hasOwn(mimeTypes, format)) return undefined
  return mimeTypes[format].find(type => globalThis.MediaRecorder?.isTypeSupported(type))
}

export function getExportFormats() {
  return Object.keys(mimeTypes).filter(format => supportedMimeType(format))
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('書き出しを中止しました。', 'AbortError')
}

function checkAbort(signal) {
  if (signal.aborted) throw abortReason(signal)
}

function waitForAction(signal, timeoutMessage, subscribe, timeout = 15000) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const cleanup = []
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      for (const dispose of cleanup) dispose()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(abortReason(signal))
    signal.addEventListener('abort', abort, { once: true })
    cleanup.push(() => signal.removeEventListener('abort', abort))
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeout)
    cleanup.push(() => clearTimeout(timer))
    try {
      subscribe(finish, cleanup)
    } catch (error) {
      finish(error)
    }
  })
}

function waitForMedia(video, event, ready, signal) {
  checkAbort(signal)
  if (ready()) return Promise.resolve()
  return waitForAction(signal, '動画の読み込みに時間がかかりすぎています。', (finish, cleanup) => {
    const update = () => {
      if (ready()) finish()
    }
    const fail = () => finish(new Error('動画を読み込めませんでした。'))
    video.addEventListener(event, update)
    video.addEventListener('error', fail)
    cleanup.push(() => video.removeEventListener(event, update))
    cleanup.push(() => video.removeEventListener('error', fail))
    if (video.error) fail()
  })
}

function waitForPlaybackStart(video, signal) {
  return waitForAction(signal, '動画の再生を開始できませんでした。', finish => {
    video.play().then(() => finish(), finish)
  })
}

function playClip(video, end, frameInterval, paint, signal) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let lastFrame = video.currentTime
    let lastTime = lastFrame
    let lastAdvance = performance.now()
    const finish = error => {
      clearInterval(timer)
      signal.removeEventListener('abort', abort)
      video.removeEventListener('ended', tick)
      video.removeEventListener('error', fail)
      video.pause()
      if (error) reject(error)
      else resolve()
    }
    const abort = () => finish(abortReason(signal))
    const fail = () => finish(new Error('書き出し中に動画の再生が止まりました。'))
    const tick = () => {
      const now = performance.now()
      const time = video.currentTime
      if (time >= end || video.ended) {
        if (video.ended && time < end - 0.05) fail()
        else finish()
        return
      }
      if (time !== lastTime) {
        lastTime = time
        lastAdvance = now
      } else if (now - lastAdvance > 15000) {
        fail()
        return
      }
      if (time >= lastFrame + frameInterval - 0.002) {
        lastFrame += Math.floor((time - lastFrame + 0.002) / frameInterval) * frameInterval
        try {
          paint(time)
        } catch (error) {
          finish(error)
        }
      }
    }
    const timer = setInterval(tick, 8)
    signal.addEventListener('abort', abort, { once: true })
    video.addEventListener('ended', tick)
    video.addEventListener('error', fail)
    tick()
  })
}

export async function exportVideo({ project, sources, options = {}, signal, onProgress = () => {} }) {
  const { width = 1280, height = 720, fps = 30, format = 'auto' } = options
  const extension = format === 'auto' ? getExportFormats()[0] : format
  const mimeType = supportedMimeType(extension)
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (!mimeType || !AudioContext || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('このブラウザは指定の形式で動画を書き出せません。')
  }
  if (![width, height, fps].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('書き出しのサイズまたはフレームレートが無効です。')
  }

  const clips = project.clips
  if (!clips.length || clips.some(clip => !Number.isFinite(clip.in) ||
    !Number.isFinite(clip.out) || clip.in < 0 || clip.out <= clip.in)) {
    throw new Error('有効なクリップをタイムラインに追加してください。')
  }
  if (clips.some(clip => !sources.get(clip.assetId))) {
    throw new Error('書き出しに必要な素材を読み込んでください。')
  }
  if (signal) checkAbort(signal)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('書き出し用の画面を作成できませんでした。')

  const video = document.createElement('video')
  video.playsInline = true
  video.preload = 'auto'
  const audio = new AudioContext()
  const controller = new AbortController()
  const activeSignal = controller.signal
  const abort = () => controller.abort(abortReason(signal))
  signal?.addEventListener('abort', abort, { once: true })
  let canvasStream
  let audioStream
  let recorder

  try {
    await waitForAction(activeSignal, '書き出し用の音声を初期化できませんでした。', finish => {
      audio.resume().then(() => finish(), finish)
    })
    const destination = audio.createMediaStreamDestination()
    audio.createMediaElementSource(video).connect(destination)
    audioStream = destination.stream
    canvasStream = canvas.captureStream(fps)
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioStream.getAudioTracks()])
    recorder = new MediaRecorder(stream, { mimeType })
    const chunks = []
    recorder.addEventListener('dataavailable', event => {
      if (event.data.size) chunks.push(event.data)
    })
    recorder.addEventListener('error', event => {
      controller.abort(event.error ?? new Error('エンコードに失敗しました。'))
    })

    const duration = clips.reduce((total, clip) => total + clip.out - clip.in, 0)
    let elapsed = 0
    let loadedSource

    for (const [index, clip] of clips.entries()) {
      const source = sources.get(clip.assetId)
      if (source !== loadedSource) {
        video.src = source
        video.load()
        await waitForMedia(video, 'loadeddata', () => video.readyState >= 2, activeSignal)
        loadedSource = source
      }
      if (!video.videoWidth || !Number.isFinite(video.duration) ||
        clip.in >= video.duration || clip.out > video.duration + 0.05) {
        throw new Error('書き出し範囲が素材の長さを超えているか、動画を読み込めません。')
      }
      if (Math.abs(video.currentTime - clip.in) > 0.0001) {
        video.currentTime = clip.in
        await waitForMedia(video, 'seeked', () => !video.seeking && video.readyState >= 2, activeSignal)
      }
      const paint = sourceTime => {
        const time = elapsed + Math.max(0, sourceTime - clip.in)
        drawFrame(context, video, captionAt(project, time))
        onProgress(Math.min(time / duration, 1))
      }
      paint(clip.in)
      await waitForPlaybackStart(video, activeSignal)
      if (index === 0) recorder.start()
      else recorder.resume()
      await playClip(video, Math.min(clip.out, video.duration), 1 / fps, paint, activeSignal)
      elapsed += clip.out - clip.in
      if (index < clips.length - 1) recorder.pause()
    }

    await waitForAction(activeSignal, '書き出しファイルを確定できませんでした。', (finish, cleanup) => {
      const stop = () => finish()
      recorder.addEventListener('stop', stop, { once: true })
      cleanup.push(() => recorder.removeEventListener('stop', stop))
      recorder.stop()
    })
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType })
    if (!blob.size) throw new Error('書き出した動画にデータがありません。')
    onProgress(1)
    return { blob, extension }
  } finally {
    signal?.removeEventListener('abort', abort)
    video.pause()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    for (const stream of [canvasStream, audioStream]) {
      stream?.getTracks().forEach(track => track.stop())
    }
    video.removeAttribute('src')
    video.load()
    await audio.close().catch(() => {})
  }
}
