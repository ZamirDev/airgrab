// gesture.js — AirGrab gesture classifier + state machine + overlay viewer.
//
// No training. Uses MediaPipe HandLandmarker's 21 landmarks to measure finger
// flexion (joint angle at each PIP), then:
//   PALM   ~>= 4 fingers extended
//   FIST   ~<= 1 finger extended
//   partial -> in between (not committed)
// A state machine debounces frames, then maps  PALM->FIST => 'grab'
//                                          FIST->PALM => 'release'

import { drawGhost } from './payload.js';

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],            // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],            // index
  [5, 9], [9, 10], [10, 11], [11, 12],       // middle
  [9, 13], [13, 14], [14, 15], [15, 16],     // ring
  [13, 17], [17, 18], [18, 19], [19, 20],    // pinky
  [0, 17],                                   // wrist <-> pinky mcp
];

const FINGERS = [
  { tip: 8, pip: 6,  mcp: 5 },   // index
  { tip: 12, pip: 10, mcp: 9 },  // middle
  { tip: 16, pip: 14, mcp: 13 }, // ring
  { tip: 20, pip: 18, mcp: 17 }, // pinky
  { tip: 4, pip: 3,  mcp: 2 },   // thumb (bends at MCP: points 1-2-3)
];

const EXTENDED_ANGLE_DEG = 140;

const dot = (ax, ay, bx, by) => ax * bx + ay * by;

function point(lm, i) {
  const p = lm[i];
  return { x: p.x, y: p.y };
}

function angleDeg(a, b, c) {
  // angle at vertex b of triangle a-b-c
  const ux = a.x - b.x, uy = a.y - b.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
  if (nu < 1e-6 || nv < 1e-6) return NaN;
  const cos = dot(ux, uy, vx, vy) / (nu * nv);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function fingerExtended(landmarks, f) {
  if (!landmarks[f.tip] || !landmarks[f.pip] || !landmarks[f.mcp]) return { extended: false, angle: NaN };
  const mcp = point(landmarks, f.mcp);
  const pip = point(landmarks, f.pip);
  const tip = point(landmarks, f.tip);
  const angle = angleDeg(mcp, pip, tip);
  return { extended: angle >= EXTENDED_ANGLE_DEG, angle };
}

export function classifyHand(landmarks) {
  if (!landmarks || landmarks.length < 21) {
    return { gesture: 'unreliable', extended: 0, angles: [], reliable: false };
  }
  const per = FINGERS.map((f) => fingerExtended(landmarks, f));
  const unreliable = per.some((p) => Number.isNaN(p.angle));
  const extended = per.filter((p) => p.extended).length;
  let gesture;
  if (unreliable) gesture = 'unreliable';
  else if (extended >= 4) gesture = 'palm';
  else if (extended <= 1) gesture = 'fist';
  else gesture = 'partial';
  return { gesture, extended, angles: per.map((p) => p.angle), reliable: !unreliable };
}

export function palmCentroid(landmarks) {
  // Palm center for ghost placement: mean of wrist + the four MCP joints.
  if (!landmarks || landmarks.length < 21) return null;
  const idx = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of idx) {
    const p = landmarks[i];
    if (!p) return null;
    x += p.x; y += p.y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

export class GestureStateMachine {
  constructor({ holdFrames = 4, onEvent = () => {}, onState = () => {} } = {}) {
    this.holdFrames = holdFrames;
    this.onEvent = onEvent;
    this.onState = onState;
    this.committed = null;
    this.candidate = null;
    this.candidateCount = 0;
  }

  update(cls) {
    const raw = cls.reliable ? cls.gesture : 'unreliable';
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateCount = 1;
    } else {
      this.candidateCount += 1;
    }
    if (this.candidateCount < this.holdFrames) return;

    const next = (raw === 'palm' || raw === 'fist') ? raw : null;
    if (next !== this.committed) {
      const prev = this.committed;
      this.committed = next;
      if (next === 'fist' && prev === 'palm') this.onEvent({ type: 'grab' });
      if (next === 'palm' && prev === 'fist') this.onEvent({ type: 'release' });
      this.onState(next);
    }
  }

  reset() {
    this.committed = null;
    this.candidate = null;
    this.candidateCount = 0;
  }
}

export class HandViewer {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ghostImg = null;   // grabbed-photo preview (HTMLImageElement | null)
  }

  setGhost(img) { this.ghostImg = img; }

  draw(landmarks, { committed, raw, extended }) {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w, 0);            // mirror so it matches the CSS-flipped video
    ctx.scale(-1, 1);
    if (!landmarks) {
      ctx.restore();
      return;
    }

    const centroid = palmCentroid(landmarks);
    if (this.ghostImg && centroid && committed === 'fist') {
      drawGhost(ctx, this.ghostImg, centroid, w, h);
    }

    const color = committed === 'fist' ? '#e5484d' : committed === 'palm' ? '#2e9e6b' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = landmarks[a], pb = landmarks[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
      ctx.stroke();
    }
    for (const p of landmarks) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fefbf4';
      ctx.fill();
    }
    ctx.restore();
  }
}

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export async function initGestureSession({
  video, canvas, wasmBase, modelPath,
  onEvent = () => {}, onState = () => {}, onStatus = () => {},
  onClassify = () => {},
}) {
  const { FilesetResolver, HandLandmarker } = await import('../vendor/taskvision.mjs');
  onStatus('loading model');
  const vision = await FilesetResolver.forVisionTasks(wasmBase || 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
  const landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: modelPath || './models/hand_landmarker.task', delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  });
  onStatus('ready');

  const machine = new GestureStateMachine({ onEvent, onState });
  const viewer = new HandViewer(video, canvas);
  let raf = 0;
  let lastVideoTime = -1;

  function loop(ts) {
    if (lastVideoTime !== video.currentTime && video.readyState >= 2) {
      const results = landmarker.detectForVideo(video, ts);
      const lm = results.landmarks && results.landmarks[0];
      const cls = classifyHand(lm);
      machine.update(cls);
      onClassify(cls);
      viewer.draw(lm, {
        committed: machine.committed,
        raw: cls.gesture,
        extended: cls.extended,
      });
      lastVideoTime = video.currentTime;
    }
    raf = requestAnimationFrame(loop);
  }

  function start() {
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    cancelAnimationFrame(raf);
  }
  return { start, stop, machine, landmarker, viewer };
}