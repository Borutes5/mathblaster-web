// MathBlaster v2 – browser prototype of M1.1–M1.4 (drag steering, auto-fire, x2 gate, target wall).
// Coordinates: Unity (x, y, z forward)  ->  three.js (x, y, -z). All gameplay maths is done in Unity-style z.
import * as THREE from './vendor/three.module.min.js';

// ---------- Tuned values (Decision, from the Unity version) ----------
const CFG = {
  clampX: 3.5,            // track half-width 4 minus cannon half-width 0.5
  sensitivity: 11,        // world units per full screen-width drag
  smoothK: 30,            // x = lerp(x, target, 1 - exp(-k*dt))
  fireRate: 8,            // shots per second
  muzzleZ: 0.7,
  bulletSpeed: 25,
  bulletLife: 2.2,         // 25 u/s still clears the wall at z=40 with margin
  bulletRadius: 0.15,     // diameter 0.3
  gate: { x: 1.75, y: 1, z: 12, w: 3.5, h: 2, d: 0.2, multiplier: 2, spread: 0.35 },
  track: { width: 8, zMin: -1, zMax: 42 }, // short pad behind the cannon, wall at z=40
  maxBullets: 512,
};

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b2a5b);

// Pitch ~30° down, FOV 60. Height and distance are solved per aspect so the cannon
// base sits ~12% above the bottom (or just above the home indicator) and x=±4.5
// at the cannon's near face stays inside 96% of the frame.
const PITCH_DOWN = 30 * Math.PI / 180;
const PITCH_SHALLOW = 18 * Math.PI / 180;
const VFOV_TAN = Math.tan(30 * Math.PI / 180);
const FIT_HALF = 4.5;
const FIT_NDC = 0.96;
const WALL_CLEAR_PX = 120;
const LABEL_H = 2.25;
const TARGET_PLANE_PX = 73; // ~40px of ink; digits fill about 55% of the plane
const _pv = new THREE.Vector3();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);
function safeBottomPx() {
  const el = document.getElementById('safe-bottom');
  return el ? el.offsetHeight : 0;
}
function poseCamera(pitch, w, h) {
  const SIN = Math.sin(pitch), COS = Math.cos(pitch);
  const aspect = w / Math.max(h, 1);
  const gap = Math.max(0.12 * h, safeBottomPx());
  const ndcBase = 2 * (gap / h) - 1;
  const depthF = (FIT_HALF / FIT_NDC) / (VFOV_TAN * aspect);
  const depthB = depthF + 0.5 * SIN;
  const yCamB = ndcBase * depthB * VFOV_TAN;
  const RHS1 = depthF + 0.5 * (SIN + COS);
  const RHS2 = yCamB + 0.5 * SIN;
  camera.fov = 60;
  camera.aspect = aspect;
  camera.rotation.x = -pitch;
  camera.position.set(0, SIN * RHS1 - COS * RHS2, COS * RHS1 + SIN * RHS2);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
}
function screenY(y, z, h) {
  _pv.set(0, y, z).project(camera);
  return (-_pv.y * 0.5 + 0.5) * h;
}
function fitCamera(w, h) {
  const zFront = -wallZ + wallD / 2 + 0.02;
  let pitch = PITCH_DOWN;
  poseCamera(pitch, w, h);
  if (screenY(1.25 + LABEL_H / 2, zFront, h) < WALL_CLEAR_PX) {
    let lo = PITCH_SHALLOW, hi = pitch;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      poseCamera(mid, w, h);
      if (screenY(1.25 + LABEL_H / 2, zFront, h) < WALL_CLEAR_PX) hi = mid;
      else lo = mid;
    }
    poseCamera(lo, w, h);
  }
  const basePx = Math.abs(screenY(1.25 + LABEL_H / 2, zFront, h) - screenY(1.25 - LABEL_H / 2, zFront, h));
  let s = TARGET_PLANE_PX / Math.max(basePx, 1);
  const place = (scale) => {
    const worldH = LABEL_H * scale;
    const localY = 1.25 - worldH / 2 < 0.06 ? worldH / 2 - 1.19 : 0;
    const top = 1.25 + localY + worldH / 2;
    return { localY, top: screenY(top, zFront, h) };
  };
  if (place(s).top < WALL_CLEAR_PX) {
    let lo = 0.8, hi = s;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (place(mid).top < WALL_CLEAR_PX) hi = mid;
      else lo = mid;
    }
    s = lo;
  }
  const placed = place(s);
  hitLabel.scale.set(s, s, 1);
  hitLabel.position.y = placed.localY;
}

scene.add(new THREE.HemisphereLight(0xdfefff, 0x1a3a6a, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(3, 10, 4);
scene.add(sun);

// ---------- Blueprint world ----------
// Background ground grid (large, faint)
const bgGrid = new THREE.GridHelper(200, 100, 0x2c5a9a, 0x1b4580);
bgGrid.position.y = -0.02;
scene.add(bgGrid);

// Track: lighter blueprint panel with its own fine grid texture
function gridTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#14427f'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(170,210,255,0.35)'; g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  g.strokeStyle = 'rgba(170,210,255,0.12)'; g.lineWidth = 1;
  for (let i = 0; i <= 256; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const trackLen = CFG.track.zMax - CFG.track.zMin;
const trackTex = gridTexture(); trackTex.repeat.set(CFG.track.width / 2, trackLen / 2); // 1 major cell = 0.5 units... 4 cells per 2 units
const track = new THREE.Mesh(new THREE.PlaneGeometry(CFG.track.width, trackLen),
  new THREE.MeshBasicMaterial({ map: trackTex }));
track.rotation.x = -Math.PI / 2;
track.position.set(0, 0, -(CFG.track.zMin + trackLen / 2));
scene.add(track);
// Track edge lines
const edgeMat = new THREE.LineBasicMaterial({ color: 0xbfe0ff });
for (const sx of [-1, 1]) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(sx * CFG.track.width / 2, 0.01, -CFG.track.zMin),
    new THREE.Vector3(sx * CFG.track.width / 2, 0.01, -CFG.track.zMax)]);
  scene.add(new THREE.Line(geo, edgeMat));
}

// Cannon: 1x1x1 cube at y 0.5, with outline
const cannon = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xf2f6ff }));
cannon.position.set(0, 0.5, 0);
cannon.add(new THREE.LineSegments(new THREE.EdgesGeometry(cannon.geometry), new THREE.LineBasicMaterial({ color: 0x0b2a5b })));
scene.add(cannon);

// 1-unit lineup marker (Unity z=6). Off until the TUNE checkbox is enabled.
const MARKER_IDLE = 0xfff4c2, MARKER_OK = 0x3dff7a;
const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 0.28),
  new THREE.MeshBasicMaterial({ color: MARKER_IDLE }));
marker.position.set(0, 0.04, -6);
marker.visible = false;
scene.add(marker);
let markerOn = false, markerX = 0, markerHold = 0, markerAge = 0, markerGreen = 0;
let markerLast = null, markerSum = 0, markerN = 0;
function placeMarker() {
  markerX = Math.random() * 6 - 3;
  marker.position.x = markerX;
  marker.position.z = -6;
  markerHold = 0;
  markerAge = 0;
  markerGreen = 0;
  marker.material.color.setHex(MARKER_IDLE);
  marker.visible = true;
}
function updateMarker(dt) {
  if (!markerOn) return;
  if (markerGreen > 0) {
    markerGreen -= dt;
    if (markerGreen <= 0) placeMarker();
    return;
  }
  markerAge += dt;
  if (Math.abs(x - markerX) <= 0.5) {
    markerHold += dt;
    if (markerHold >= 0.3) {
      markerLast = markerAge;
      markerSum += markerAge;
      markerN += 1;
      marker.material.color.setHex(MARKER_OK);
      markerGreen = 0.4;
      paintHud();
    }
  } else markerHold = 0;
}

// Gate x2
const G = CFG.gate;
const gateGroup = new THREE.Group();
gateGroup.position.set(G.x, G.y, -G.z);
const gatePanel = new THREE.Mesh(new THREE.BoxGeometry(G.w, G.h, G.d),
  new THREE.MeshBasicMaterial({ color: 0x7cc8ff, transparent: true, opacity: 0.38, depthWrite: false }));
gateGroup.add(gatePanel);
gateGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(gatePanel.geometry), new THREE.LineBasicMaterial({ color: 0xd8f0ff })));
function labelTexture(text) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.font = '900 200px system-ui, -apple-system, Helvetica, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 18; g.strokeStyle = '#0b2a5b'; g.strokeText(text, 256, 140);
  g.fillStyle = '#ffffff'; g.fillText(text, 256, 140);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const label = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.3),
  new THREE.MeshBasicMaterial({ map: labelTexture('x' + G.multiplier), transparent: true, depthWrite: false }));
label.position.set(0, 0.05, G.d / 2 + 0.02); // front face (towards camera)
label.renderOrder = 2;
gateGroup.add(label);
scene.add(gateGroup);
// One timer for the gate punch. 0 = just hit; large = idle and perfectly still.
const GATE_BASE = new THREE.Color(0x7cc8ff);
const GATE_WHITE = new THREE.Color(0xffffff);
let gateFx = true;
let gatePunch = 1;
let gateLive = false;
function restGate() {
  gateGroup.scale.set(1, 1, 1);
  gateGroup.position.x = G.x;
  label.scale.set(1, 1, 1);
  gatePanel.material.opacity = 0.38;
  gatePanel.material.color.copy(GATE_BASE);
  gateLive = false;
  gatePunch = 1;
}
function punchGate() {
  if (!gateFx) return;
  gatePunch = 0; // re-triggers amp to 0.12 via the exp below
  gateLive = true;
}
function updateGatePunch(dt) {
  if (!gateLive) return;
  if (!gateFx) { restGate(); return; }
  gatePunch += dt;
  const env = Math.exp(-gatePunch / 0.03);          // ~90 ms back to rest
  const pop = Math.min(0.15, 0.12 * env);           // scale 1.12, never past 1.15
  if (pop < 0.001) { restGate(); return; }
  gateGroup.scale.set(1 + pop, 1 + pop, 1);          // x/y only; z stays 1
  const flash = Math.exp(-gatePunch / 0.034);       // opacity + label, ~100 ms
  gateGroup.position.x = G.x + (gatePunch < 0.045 ? 0.03 : -0.03) * (pop / 0.12);
  gatePanel.material.opacity = 0.38 + 0.27 * flash;  // 0.38 -> 0.65
  gatePanel.material.color.copy(GATE_BASE).lerp(GATE_WHITE, flash);
  const ls = 1 + 0.18 * flash;                       // label 1 -> 1.18
  label.scale.set(ls, ls, 1);
}

// Target wall: full track width, sitting on y=0, far end of the longer track (Unity z=40).
const wallW = 8, wallH = 2.5, wallD = 0.6, wallZ = 40;
const WALL_BASE = new THREE.Color(0x8ebbe8);
const WALL_FLASH = new THREE.Color(0xffffff);
const wallMat = new THREE.MeshBasicMaterial({ color: WALL_BASE });
const wall = new THREE.Mesh(new THREE.BoxGeometry(wallW, wallH, wallD), wallMat);
wall.position.set(0, wallH / 2, -wallZ);
wall.add(new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), new THREE.LineBasicMaterial({ color: 0xf4fbff })));
const hitCanvas = document.createElement('canvas');
hitCanvas.width = 512; hitCanvas.height = 160;
const hitCtx = hitCanvas.getContext('2d');
hitCtx.textAlign = 'center'; hitCtx.textBaseline = 'middle'; hitCtx.lineWidth = 14;
const hitTex = new THREE.CanvasTexture(hitCanvas);
hitTex.colorSpace = THREE.SRGBColorSpace; hitTex.anisotropy = 4;
const hitLabel = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 2.25),
  new THREE.MeshBasicMaterial({ map: hitTex, transparent: true, depthWrite: false }));
hitLabel.position.set(0, 0, wallD / 2 + 0.02); // front face (towards camera)
hitLabel.renderOrder = 2;
wall.add(hitLabel);
scene.add(wall);
let hits = 0, hitsShown = -1, hitDrawAcc = 0, wallFlash = 0, wallPulsing = false;
function paintHits(n) {
  const digits = n < 1000 ? 3 : n < 10000 ? 4 : n < 100000 ? 5 : 6;
  hitCtx.font = '900 ' + (digits <= 3 ? 128 : digits === 4 ? 104 : digits === 5 ? 84 : 68) + 'px system-ui, -apple-system, Helvetica, Arial, sans-serif';
  hitCtx.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
  hitCtx.strokeStyle = '#0b2a5b'; hitCtx.fillStyle = '#ffffff';
  hitCtx.strokeText(String(n), 256, 84);
  hitCtx.fillText(String(n), 256, 84);
  hitTex.needsUpdate = true;
  hitsShown = n;
}
paintHits(0);

// ---------- Bullet pool (struct-of-arrays + one InstancedMesh, no per-shot allocations) ----------
const N = CFG.maxBullets;
const bx = new Float32Array(N), bz = new Float32Array(N), bAge = new Float32Array(N);
const bPassed = new Uint8Array(N);   // bit flags: gate 0 passed
let count = 0;                       // live bullets are indices [0, count)
const bulletMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(CFG.bulletRadius, 12, 8),
  new THREE.MeshLambertMaterial({ color: 0xffd447 }), N);
bulletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bulletMesh.count = 0;
bulletMesh.frustumCulled = false;
scene.add(bulletMesh);
const BULLET_Y = 0.5;
function spawn(x, z, age, passed) {
  if (count >= N) return; // pool exhausted: drop (never allocate)
  bx[count] = x; bz[count] = z; bAge[count] = age; bPassed[count] = passed; count++;
}
function kill(i) { // swap-remove
  count--;
  bx[i] = bx[count]; bz[i] = bz[count]; bAge[i] = bAge[count]; bPassed[i] = bPassed[count];
}

// ---------- Input: relative drag ----------
let x = 0, targetX = 0;
let activeId = null, anchorPx = 0, anchorTarget = 0;
const hint = document.getElementById('hint');
let touchSmooth = false;          // optional pointer-x average; default OFF
const moveSamples = [];
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (activeId !== null) return; // one steering finger at a time
  activeId = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  moveSamples.length = 0;
  anchorPx = e.clientX; anchorTarget = targetX;
  hint.style.opacity = '0';
}, { passive: false });
function smoothedPointerX(e) {
  if (!touchSmooth) return e.clientX;
  moveSamples.push(e.clientX);
  if (moveSamples.length > 3) moveSamples.shift();
  let s = 0;
  for (let i = 0; i < moveSamples.length; i++) s += moveSamples[i];
  return s / moveSamples.length;
}
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== activeId) return;
  e.preventDefault();
  const w = window.innerWidth || 1;
  const px = smoothedPointerX(e);
  // use coalesced events' latest position (same result, finest-grained)
  const t = anchorTarget + ((px - anchorPx) / w) * CFG.sensitivity;
  if (t > CFG.clampX || t < -CFG.clampX) {
    targetX = t > 0 ? CFG.clampX : -CFG.clampX;
    anchorPx = px; anchorTarget = targetX; // re-anchor at the edge
    if (touchSmooth) { moveSamples.length = 0; moveSamples.push(e.clientX); }
  } else targetX = t;
}, { passive: false });
function endPointer(e) { if (e.pointerId === activeId) activeId = null; }
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
// Block page scroll / pinch / pull-to-refresh / double-tap zoom / long-press menu.
// Touches that start on the tune UI are left alone so iOS Safari can drag the sliders.
function eventInTuneUi(e) {
  const n = e.target;
  const el = n && n.nodeType === 1 ? n : n && n.parentElement;
  return !!(el && el.closest && el.closest('#actions, #tune-panel'));
}
const block = (e) => {
  if (e.type.startsWith('touch') && eventInTuneUi(e)) return;
  e.preventDefault();
};
for (const ev of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu'])
  document.addEventListener(ev, block, { passive: false });

// ---------- HUD ----------
const hud = document.getElementById('hud');
const toggle = document.getElementById('toggle');
let hudOn = true;
toggle.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
toggle.addEventListener('click', (e) => { e.stopPropagation(); hudOn = !hudOn; hud.style.display = hudOn ? '' : 'none'; });
let fpsFrames = 0, fpsTime = 0, fps = 0, worstMs = 0, worstAcc = 0;

// ---------- Live tune (persisted; defaults stay the Unity values) ----------
const TUNE_KEY = 'mathblaster-tune';
const inSensitivity = document.getElementById('in-sensitivity');
const inSmoothK = document.getElementById('in-smoothK');
const inClampX = document.getElementById('in-clampX');
const inTouchSmooth = document.getElementById('in-touchSmooth');
const inGateFx = document.getElementById('in-gateFx');
const inMarker = document.getElementById('in-marker');
const outSensitivity = document.getElementById('out-sensitivity');
const outSmoothK = document.getElementById('out-smoothK');
const outClampX = document.getElementById('out-clampX');
const tuneBtn = document.getElementById('tune');
const tunePanel = document.getElementById('tune-panel');

function quantize(value, min, max, step) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const q = min + Math.round((n - min) / step) * step;
  const decimals = (String(step).split('.')[1] || '').length;
  const out = Number(q.toFixed(decimals));
  if (out < min || out > max) return null;
  return out;
}
function formatTune(v) { return String(Number(Number(v).toFixed(2))); }
function persistTune() {
  try {
    localStorage.setItem(TUNE_KEY, JSON.stringify({
      sensitivity: CFG.sensitivity, smoothK: CFG.smoothK, clampX: CFG.clampX, touchSmooth, gateFx, marker: markerOn,
    }));
  } catch (_) {}
}
function loadTune() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TUNE_KEY) || 'null'); } catch (_) { saved = null; }
  if (!saved || typeof saved !== 'object') return;
  const sensitivity = quantize(saved.sensitivity, 6, 16, 0.5);
  const smoothK = quantize(saved.smoothK, 5, 60, 1);
  const clampX = quantize(saved.clampX, 2.5, 3.5, 0.1);
  if (sensitivity != null) CFG.sensitivity = sensitivity;
  if (smoothK != null) CFG.smoothK = smoothK;
  if (clampX != null) CFG.clampX = clampX;
  touchSmooth = saved.touchSmooth === true;
  if (typeof saved.gateFx === 'boolean') gateFx = saved.gateFx;
  markerOn = saved.marker === true;
}
function constrainTarget() {
  if (targetX > CFG.clampX || targetX < -CFG.clampX) {
    targetX = Math.min(CFG.clampX, Math.max(-CFG.clampX, targetX));
    anchorTarget = targetX;
  }
}
function syncTuneUi() {
  inSensitivity.value = String(CFG.sensitivity);
  inSmoothK.value = String(CFG.smoothK);
  inClampX.value = String(CFG.clampX);
  inTouchSmooth.checked = touchSmooth;
  inGateFx.checked = gateFx;
  inMarker.checked = markerOn;
  outSensitivity.textContent = formatTune(CFG.sensitivity);
  outSmoothK.textContent = formatTune(CFG.smoothK);
  outClampX.textContent = formatTune(CFG.clampX);
}
function bindRange(input, key, min, max, step, out) {
  input.addEventListener('input', () => {
    const v = quantize(input.value, min, max, step);
    if (v == null) return;
    CFG[key] = v;
    out.textContent = formatTune(v);
    if (key === 'clampX') constrainTarget();
    persistTune();
  });
}
loadTune();
constrainTarget();
syncTuneUi();
if (markerOn) placeMarker();
tuneBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
tuneBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = tunePanel.hasAttribute('hidden');
  if (open) tunePanel.removeAttribute('hidden');
  else tunePanel.setAttribute('hidden', '');
  tuneBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
tunePanel.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
bindRange(inSensitivity, 'sensitivity', 6, 16, 0.5, outSensitivity);
bindRange(inSmoothK, 'smoothK', 5, 60, 1, outSmoothK);
bindRange(inClampX, 'clampX', 2.5, 3.5, 0.1, outClampX);
inTouchSmooth.addEventListener('change', () => {
  touchSmooth = inTouchSmooth.checked;
  moveSamples.length = 0;
  persistTune();
});
inGateFx.addEventListener('change', () => {
  gateFx = inGateFx.checked;
  if (!gateFx) restGate();
  persistTune();
});
inMarker.addEventListener('change', () => {
  markerOn = inMarker.checked;
  if (markerOn) placeMarker();
  else marker.visible = false;
  persistTune();
  paintHud();
});
document.getElementById('tune-reset').addEventListener('click', (e) => {
  e.stopPropagation();
  CFG.sensitivity = 11;
  CFG.smoothK = 30;
  CFG.clampX = 3.5;
  touchSmooth = false;
  gateFx = true;
  markerOn = false;
  marker.visible = false;
  markerHold = 0; markerGreen = 0; markerLast = null; markerSum = 0; markerN = 0;
  moveSamples.length = 0;
  syncTuneUi();
  paintHud();
  try { localStorage.removeItem(TUNE_KEY); } catch (_) {}
});
document.getElementById('reset-hits').addEventListener('click', (e) => {
  e.stopPropagation();
  resetHits();
});

// ---------- Resize ----------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  fitCamera(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

// ---------- Main loop ----------
const m4 = new THREE.Matrix4();
let fireAcc = 0, last = performance.now(), shots = 0, time = 0;
const gx0 = G.x - G.w / 2 - CFG.bulletRadius, gx1 = G.x + G.w / 2 + CFG.bulletRadius;
const gz0 = G.z - G.d / 2 - CFG.bulletRadius, gz1 = G.z + G.d / 2 + CFG.bulletRadius;
const wx0 = -wallW / 2 - CFG.bulletRadius, wx1 = wallW / 2 + CFG.bulletRadius;
const wz0 = wallZ - wallD / 2 - CFG.bulletRadius, wz1 = wallZ + wallD / 2 + CFG.bulletRadius;
let copySign = 1;
// Rolling 1s hit window. Fixed ring, no per-hit allocation.
const HIT_RING = 128;
const hitStamp = new Float32Array(HIT_RING);
let hitRingI = 0, hitRingN = 0, hitsPerSec = 0;
function pushHits(n) {
  for (let k = 0; k < n; k++) {
    hitStamp[hitRingI] = time;
    hitRingI = (hitRingI + 1) % HIT_RING;
    if (hitRingN < HIT_RING) hitRingN++;
  }
}
function hitsInLastSecond() {
  const cutoff = time - 1;
  let c = 0;
  for (let k = 0; k < hitRingN; k++) {
    let idx = hitRingI - 1 - k;
    if (idx < 0) idx += HIT_RING;
    if (hitStamp[idx] < cutoff) break;
    c++;
  }
  return c;
}
function resetHits() {
  hits = 0;
  hitRingI = 0; hitRingN = 0; hitsPerSec = 0;
  wallFlash = 0; wallPulsing = false;
  wallMat.color.copy(WALL_BASE);
  wall.scale.set(1, 1, 1);
  paintHits(0);
  hitDrawAcc = 0;
  paintHud();
}
function paintHud() {
  if (!hudOn) return;
  let text = `v0.7\nFPS ${fps.toFixed(0)}  worst ${worstMs.toFixed(1)}ms\nbullets ${count}/${N}\nhits ${hits}\nhits/s ${hitsPerSec.toFixed(1)}`;
  if (markerOn) {
    const last = markerLast == null ? '—' : markerLast.toFixed(2) + 's';
    const avg = markerN ? (markerSum / markerN).toFixed(2) + 's' : '—';
    text += `\nalign ${last}  avg ${avg}`;
  }
  hud.textContent = text;
}

function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1; // tab switch / hitch guard
  time += dt;

  // Steering
  x += (targetX - x) * (1 - Math.exp(-CFG.smoothK * dt));
  cannon.position.x = x;
  updateMarker(dt);

  // Auto-fire (accumulator keeps exact 8/s regardless of frame rate)
  fireAcc += dt;
  const interval = 1 / CFG.fireRate;
  while (fireAcc >= interval) {
    fireAcc -= interval;
    // bullet already travelled for fireAcc seconds since its exact spawn time
    spawn(x, CFG.muzzleZ + CFG.bulletSpeed * fireAcc, fireAcc, 0);
    shots++;
  }

  // Move bullets, gate check (swept along z so fast bullets can't tunnel), wall hit, expire
  const step = CFG.bulletSpeed * dt;
  let frameHits = 0;
  for (let i = 0; i < count; i++) {
    const z0 = bz[i];
    const z1 = z0 + step;
    bz[i] = z1; bAge[i] += dt;
    if (!(bPassed[i] & 1) && z1 >= gz0 && z0 <= gz1 && bx[i] >= gx0 && bx[i] <= gx1) {
      bPassed[i] |= 1;
      for (let k = 1; k < G.multiplier; k++) {
        spawn(bx[i] + copySign * G.spread * k, z1, bAge[i], bPassed[i]); // copy inherits age + gate flag
        copySign = -copySign;
      }
      punchGate();
    }
    if (z1 >= wz0 && z0 <= wz1 && bx[i] >= wx0 && bx[i] <= wx1) {
      bAge[i] = CFG.bulletLife; // removed below, same frame
      frameHits++;
    }
  }
  for (let i = count - 1; i >= 0; i--) if (bAge[i] >= CFG.bulletLife) kill(i);
  if (frameHits) {
    hits += frameHits;
    pushHits(frameHits);
    wallFlash = 0.08;
  }
  hitsPerSec = hitsInLastSecond();
  updateGatePunch(dt);

  // Wall flash (~80 ms). Reuses the material colour and scale; nothing allocated per hit.
  if (wallFlash > 0) {
    wallFlash = Math.max(0, wallFlash - dt);
    const k = wallFlash / 0.08;
    wallMat.color.copy(WALL_BASE).lerp(WALL_FLASH, k);
    const s = 1 + 0.035 * k;
    wall.scale.set(s, s, s);
    wallPulsing = true;
  } else if (wallPulsing) {
    wallMat.color.copy(WALL_BASE);
    wall.scale.set(1, 1, 1);
    wallPulsing = false;
  }
  hitDrawAcc += dt;
  if (hits !== hitsShown && hitDrawAcc >= 0.1) {
    paintHits(hits);
    hitDrawAcc = 0;
  }

  // Upload instance matrices
  for (let i = 0; i < count; i++) {
    m4.makeTranslation(bx[i], BULLET_Y, -bz[i]);
    bulletMesh.setMatrixAt(i, m4);
  }
  bulletMesh.count = count;
  bulletMesh.instanceMatrix.needsUpdate = true;

  renderer.render(scene, camera);

  // FPS readout
  fpsFrames++; fpsTime += dt; worstAcc = Math.max(worstAcc, dt * 1000);
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime; worstMs = worstAcc; fpsFrames = 0; fpsTime = 0; worstAcc = 0;
    paintHud();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
