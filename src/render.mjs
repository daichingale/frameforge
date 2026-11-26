export function captionAt(project, time) {
  return project.captions
    .filter(caption => caption.start <= time && time < caption.end)
    .map(caption => caption.text)
    .join('\n');
}

function wrapCaption(ctx, text, maxWidth) {
  return text.split(/\r?\n/).flatMap(paragraph => {
    const lines = [];
    let line = '';
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
    lines.push(line);
    return lines;
  });
}

export function drawFrame(ctx, video, captionText = '') {
  const {width, height} = ctx.canvas;
  ctx.fillStyle = '#07090d';
  ctx.fillRect(0, 0, width, height);
  if (video?.readyState >= 2 && video.videoWidth > 0) {
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
  }
  if (!captionText) return;

  let fontSize = Math.round(height * 0.048);
  let lineHeight;
  let lines;
  do {
    ctx.font = `700 ${fontSize}px "Yu Gothic", "Noto Sans CJK JP", sans-serif`;
    lineHeight = fontSize * 1.35;
    lines = wrapCaption(ctx, captionText, width * 0.86);
    if (lines.length * lineHeight <= height * 0.82 || fontSize <= 8) break;
    fontSize -= 2;
  } while (true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const padding = fontSize * 0.36;
  const blockWidth = Math.max(...lines.map(line => ctx.measureText(line).width)) + 2 * padding;
  const blockHeight = lines.length * lineHeight + padding;
  const top = Math.max(0, height * 0.92 - blockHeight);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillRect((width - blockWidth) / 2, top, blockWidth, blockHeight);
  ctx.fillStyle = '#fff';
  lines.forEach((line, index) => ctx.fillText(line, width / 2, top + padding / 2 + (index + 0.5) * lineHeight));
}
