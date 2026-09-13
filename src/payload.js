// payload.js — AirGrab grabbed payload: sample tray, add-files, capture-on-grab,
// and the ghost renderer that makes the grabbed photo float at your palm.

export const SAMPLE_ASSETS = [
  { name: 'cat.svg', src: './assets/cat.svg', mime: 'image/svg+xml' },
  { name: 'rocket.svg', src: './assets/rocket.svg', mime: 'image/svg+xml' },
  { name: 'party.svg', src: './assets/party.svg', mime: 'image/svg+xml' },
  { name: 'beach.svg', src: './assets/beach.svg', mime: 'image/svg+xml' },
  { name: 'trees.svg', src: './assets/trees.svg', mime: 'image/svg+xml' },
  { name: 'night.svg', src: './assets/night.svg', mime: 'image/svg+xml' },
];

export const GHOST_BASE_WIDTH = 104; // px on a 640-wide overlay, scaled by its width

// —— tray -------------------------------------------------------------

export function buildTray(container, { onSelect } = {}) {
  container.innerHTML = '';
  let selected = { type: 'sample', ...SAMPLE_ASSETS[0], data: null };

  const tiles = [];
  const makeTile = (item, label) => {
    const t = document.createElement('button');
    t.className = 'tile';
    t.title = label;
    const img = document.createElement('img');
    img.src = item.preview || item.src;
    img.alt = label;
    t.append(img);
    if (item.type === 'capture') t.dataset.capture = '1';
    t.addEventListener('click', () => {
      selected = item;
      tiles.forEach((x) => x.classList.toggle('on', x === t));
    });
    tiles.push(t);
    container.append(t);
  };

  for (const s of SAMPLE_ASSETS) makeTile({ type: 'sample', ...s }, s.name);
  makeTile({ type: 'capture', name: 'capture-photo.jpg', mime: 'image/jpeg', src: '', data: null }, '📸 capture selfie on grab');

  const add = document.createElement('button');
  add.className = 'tile';
  add.title = 'Add your own photos';
  add.textContent = '+';
  add.addEventListener('click', () => fileInput.click());
  tiles.push(add);
  container.append(add);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      makeTile({ type: 'file', name: f.name, mime: f.type || 'application/octet-stream', data: await f.arrayBuffer(), preview: URL.createObjectURL(f) }, f.name);
    }
    fileInput.value = '';
  });
  container.append(fileInput);

  tiles[0]?.classList.add('on');
  const getSelected = () => selected;
  return { getSelected };
}

// —— capture-on-grab (same front camera as the gesture) ---------------

export async function capturePhotoFromVideo(video, { name = 'capture-photo.jpg', mime = 'image/jpeg', quality = 0.92 } = {}) {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.scale(-1, 1);           // selfie = mirror
  ctx.drawImage(video, 0, 0, -w, h);
  ctx.restore();
  const blob = await new Promise((res) => cv.toBlob(res, mime, quality));
  return { type: 'capture', name, mime, size: blob.size, data: await blob.arrayBuffer() };
}

// —— file loading -------------------------------------------------------

export async function filesToPayloads(fileList) {
  const out = [];
  for (const f of fileList) {
    out.push({ type: 'file', name: f.name, mime: f.type || 'application/octet-stream', size: f.size, data: await f.arrayBuffer() });
  }
  return out;
}

export async function loadImage(srcOrUrl) {
  const img = new Image();
  img.src = srcOrUrl;
  await img.decode();
  return img;
}

// —— thumbnail (for the holding preview ghost sent ahead of the bytes) -----

export async function makeThumb(data, mime, max = 160) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  try {
    const img = await loadImage(URL.createObjectURL(blob));
    const bw = img.naturalWidth || 1, bh = img.naturalHeight || 1;
    const scale = Math.min(1, max / Math.max(bw, bh));
    const w = Math.max(1, Math.round(bw * scale));
    const h = Math.max(1, Math.round(bh * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const tb = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.8));
    return { preview: await tb.arrayBuffer(), previewMime: 'image/jpeg' };
  } catch {
    const bytes = data instanceof ArrayBuffer ? data : await blob.arrayBuffer();
    return { preview: bytes, previewMime: mime };
  }
}

// —— payload -> transfer blob metadata ----------------------------------

export function payloadAsTransfer(payload) {
  return { name: payload.name, mime: payload.mime, size: payload.data ? payload.data.byteLength : 0, data: payload.data };
}

// —— ghost renderer -------------------------------------------------------
// draws the grabbed photo following the palm; called with the mirrored ctx.

export function drawGhost(ctx, img, centroid, stageW, stageH) {
  if (!img || !centroid) return;
  const shadow = 1.6;
  const w = Math.min(GHOST_BASE_WIDTH, stageW * 0.22);
  const h = w;
  const cx = (1 - centroid.x) * stageW;   // mirrored to match overlay
  const cy = centroid.y * stageH;
  const grad = ctx.createRadialGradient(cx, cy + 2, w * 0.2, cx, cy + 2, w * shadow);
  grad.addColorStop(0, 'rgba(0,0,0,.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 4, w * shadow, h * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(cx, cy);
  ctx.rotate(-0.06);
  ctx.shadowColor = 'rgba(0,0,0,.4)';
  ctx.shadowBlur = 14;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}