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
const WALL_CLEAR_MIN = 120;
let fittedClear = 0;
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
function wallClearPx() {
  const el = document.getElementById('hud');
  if (!el || el.style.display === 'none') return WALL_CLEAR_MIN;
  const b = el.getBoundingClientRect().bottom;
  if (!(b > 0)) return WALL_CLEAR_MIN;
  return Math.max(WALL_CLEAR_MIN, b + 14);
}
function fitCamera(w, h) {
  const zFront = -wallZ + wallD / 2 + 0.02;
  const clear = wallClearPx();
  let pitch = PITCH_DOWN;
  poseCamera(pitch, w, h);
  if (screenY(1.25 + LABEL_H / 2, zFront, h) < clear) {
    let lo = PITCH_SHALLOW, hi = pitch;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      poseCamera(mid, w, h);
      if (screenY(1.25 + LABEL_H / 2, zFront, h) < clear) hi = mid;
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
  if (place(s).top < clear) {
    let lo = 0.8, hi = s;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (place(mid).top < clear) hi = mid;
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

// Narrow cannon: body + barrel + lit muzzle, so four of them stay separate.
const CANNON_W = 0.34;
const CANNON_GAP = 0.82; // centre spacing; gap between bodies is about 0.48
function makeCannon() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(CANNON_W, 0.46, 0.4),
    new THREE.MeshLambertMaterial({ color: 0xf7f9ff }));
  body.position.set(0, 0.23, 0.02);
  body.add(new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0x142033 })));
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.46),
    new THREE.MeshLambertMaterial({ color: 0x243044 }));
  barrel.position.set(0, 0.32, -0.32); // toward the enemies (three.js -z)
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.08),
    new THREE.MeshBasicMaterial({ color: 0x8ef6ff }));
  muzzle.position.set(0, 0.32, -0.58);
  g.add(body, barrel, muzzle);
  scene.add(g);
  return g;
}
const cannons = [makeCannon(), makeCannon(), makeCannon(), makeCannon()];
for (let i = 1; i < 4; i++) cannons[i].visible = false;

// Live-unit count floating just above the cannon. Texture updates at most 10/s.
const unitCanvas = document.createElement('canvas');
unitCanvas.width = 256; unitCanvas.height = 128;
const unitCtx = unitCanvas.getContext('2d');
unitCtx.textAlign = 'center'; unitCtx.textBaseline = 'middle';
const unitTex = new THREE.CanvasTexture(unitCanvas);
unitTex.colorSpace = THREE.SRGBColorSpace;
const unitLabel = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.58),
  new THREE.MeshBasicMaterial({ map: unitTex, transparent: true, depthWrite: false }));
unitLabel.position.set(0, 1.6, 0.7);
unitLabel.renderOrder = 3;
scene.add(unitLabel);
let unitsShown = -1, unitDrawAcc = 0;
function paintUnits(n) {
  unitCtx.clearRect(0, 0, 256, 128);
  unitCtx.font = '900 100px system-ui, -apple-system, Helvetica, Arial, sans-serif';
  unitCtx.lineWidth = 12; unitCtx.strokeStyle = '#0b2a5b'; unitCtx.fillStyle = '#ffffff';
  unitCtx.strokeText(String(n), 128, 70);
  unitCtx.fillText(String(n), 128, 70);
  unitTex.needsUpdate = true;
  unitsShown = n;
}
paintUnits(0);

// Cannon groups are created above. Spacing is CANNON_GAP.
const HP_OK = new THREE.Color(0x3dff7a);
const HP_RED = new THREE.Color(0xff4d4d);
const hpMat = new THREE.MeshBasicMaterial({ color: HP_OK });
const hpBar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.08), hpMat);
hpBar.position.set(0, 0.08, 0.4);
hpBar.visible = false;
scene.add(hpBar);

// Tier-1 enemies. Fixed pool of 8, two staggered rows, no per-wave allocation.
const ENEMY_N = 8;
const ENEMY_R = 0.35;
const ENEMY_HP = 3;
const ENEMY_BLUE = new THREE.Color(0x3d8cff);
const ENEMY_WHITE = new THREE.Color(0xffffff);
const ENEMY_X = [-3.4, -2.55, -1.7, -1.0, 1.0, 1.7, 2.55, 3.4];
const ENEMY_ROW = [0, 1, 0, 1, 0, 1, 0, 1]; // 0 = far z 39.3, 1 = near z 37.5
const enemies = [];
for (let i = 0; i < ENEMY_N; i++) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(ENEMY_R, 14, 10),
    new THREE.MeshLambertMaterial({ color: ENEMY_BLUE }));
  mesh.visible = false;
  scene.add(mesh);
  const cnv = document.createElement('canvas');
  cnv.width = 256; cnv.height = 128;
  const ctx = cnv.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.58),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  tag.visible = false;
  tag.renderOrder = 3;
  scene.add(tag);
  enemies.push({ mesh, tag, ctx, tex, alive: false, x: 0, z: 0, hp: 0, flash: 0, pop: 0 });
}
function paintEnemyHp(en) {
  const g = en.ctx;
  g.clearRect(0, 0, 256, 128);
  g.font = '900 108px system-ui, -apple-system, Helvetica, Arial, sans-serif';
  g.lineWidth = 18; g.strokeStyle = '#06101f'; g.fillStyle = '#ffffff';
  g.strokeText(String(en.hp), 128, 68);
  g.fillText(String(en.hp), 128, 68);
  en.tex.needsUpdate = true;
}
function placeHpTag(en, shrink) {
  const h = window.innerHeight || 932;
  const y0 = screenY(0, -en.z, h);
  const y1 = screenY(1, -en.z, h);
  const px = Math.abs(y1 - y0) || 1;
  const worldH = Math.min(1.7, Math.max(0.7, 46 / px));
  const s = worldH / 0.58;
  en.tag.scale.set(s, s, 1);
  en.tag.position.set(en.x, ENEMY_R * shrink + worldH * 0.62, -en.z + 0.12);
  en.tag.visible = true;
}

// +1 panel. Wave 1 sits at x=-0.2 so the centre lane can reach it; later waves vary in [-1.5, 1.5].
const PANEL_BASE = new THREE.Color(0x7cc8ff);
const PANEL_DARK = new THREE.Color(0x1a3358);
const PANEL_HITS = 10;
function bullseyeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1a120e';
  g.fillRect(0, 0, 256, 256);
  const rings = ['#e10600', '#f4f4f4', '#e10600', '#f4f4f4', '#111111'];
  for (let i = 0; i < rings.length; i++) {
    g.fillStyle = rings[i];
    g.beginPath();
    g.arc(128, 128, 118 - i * 22, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const panelCanvas = document.createElement('canvas');
panelCanvas.width = 512; panelCanvas.height = 256;
const panelCtx = panelCanvas.getContext('2d');
panelCtx.textAlign = 'center'; panelCtx.textBaseline = 'middle';
const panelTex = new THREE.CanvasTexture(panelCanvas);
panelTex.colorSpace = THREE.SRGBColorSpace;
const panelMat = new THREE.MeshLambertMaterial({ color: 0x2a2420 });
const panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.2, 0.22), panelMat);
const panelFaceMat = new THREE.MeshBasicMaterial({ map: bullseyeTexture(), color: 0xffffff });
const panelFace = new THREE.Mesh(new THREE.PlaneGeometry(1.28, 1.05), panelFaceMat);
panelFace.position.set(0, 0, 0.12);
panel.add(panelFace);
const panelTag = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.9),
  new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, depthWrite: false }));
panelTag.position.set(0, 0, 0.16);
panel.add(panelTag);
panel.visible = false;
scene.add(panel);
let panelAlive = false, panelX = 0, panelZ = 20, panelHp = PANEL_HITS, panelPop = 0;

let shooters = 1, shooterHp = 100, wave = 1, waveWait = 0, gameOver = false, hpFlash = 0, foesAlive = 0;
const banner = document.getElementById('banner');
function showBanner(text, over) {
  banner.textContent = text;
  banner.hidden = false;
  banner.className = over ? 'over' : 'clear';
}
function hideBanner() { banner.hidden = true; banner.textContent = ''; }
function panelXFor(w) {
  if (w <= 1) return -0.2;
  const f = (w * 0.61803398875) % 1;
  return Math.round((-1.5 + f * 3) * 100) / 100;
}
function paintPanelHp() {
  const g = panelCtx;
  g.clearRect(0, 0, 512, 256);
  g.fillStyle = 'rgba(6, 8, 14, 0.88)';
  g.beginPath();
  g.arc(256, 128, 108, 0, Math.PI * 2);
  g.fill();
  g.font = '900 188px system-ui, -apple-system, Helvetica, Arial, sans-serif';
  g.lineWidth = 22; g.strokeStyle = '#05070c'; g.fillStyle = '#ffffff';
  g.strokeText(String(Math.max(0, panelHp)), 256, 142);
  g.fillText(String(Math.max(0, panelHp)), 256, 142);
  panelTex.needsUpdate = true;
  const k = (PANEL_HITS - panelHp) / PANEL_HITS;
  panelFaceMat.color.setScalar(1 - 0.55 * k);
}
function cannonXs(n, center) {
  const half = CANNON_W / 2 + (n - 1) * CANNON_GAP / 2;
  const lim = TRACK_LIM - half;
  const cx = Math.max(-lim, Math.min(lim, center));
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(cx + (i - (n - 1) / 2) * CANNON_GAP);
  return xs;
}
function layoutCannons() {
  const n = v09On ? shooters : 1;
  const xs = cannonXs(n, x);
  for (let i = 0; i < 4; i++) {
    const on = i < n;
    cannons[i].visible = on;
    if (on) cannons[i].position.set(xs[i], 0, 0);
  }
  const cx = xs[0] === undefined ? x : (xs[0] + xs[xs.length - 1]) / 2;
  hpBar.visible = v09On && !gameOver;
  if (v09On) {
    hpBar.position.set(cx, 0.08, 0.42);
    hpBar.scale.x = Math.max(0.04, shooterHp / 100);
    hpMat.color.copy(hpFlash > 0 ? HP_RED : HP_OK);
  }
  unitLabel.visible = !v09On;
}
function clearEnemies() {
  for (let i = 0; i < ENEMY_N; i++) {
    const en = enemies[i];
    en.alive = false; en.pop = 0; en.flash = 0;
    en.mesh.visible = false; en.tag.visible = false;
  }
  foesAlive = 0;
  panelAlive = false; panelPop = 0; panel.visible = false;
}
function spawnWave() {
  clearEnemies();
  for (let i = 0; i < ENEMY_N; i++) {
    const en = enemies[i];
    en.alive = true; en.pop = 0; en.flash = 0;
    en.hp = ENEMY_HP;
    en.x = ENEMY_X[i];
    en.z = ENEMY_ROW[i] ? 37.5 : 39.3;
    en.mesh.visible = true;
    en.mesh.scale.setScalar(1);
    en.mesh.material.color.copy(ENEMY_BLUE);
    en.mesh.position.set(en.x, ENEMY_R, -en.z);
    paintEnemyHp(en);
    en.tag.visible = hpNumbers;
    if (hpNumbers) placeHpTag(en, 1);
  }
  foesAlive = ENEMY_N;
  panelAlive = true; panelPop = 0; panelHp = PANEL_HITS;
  panelX = panelXFor(wave); panelZ = 20;
  panel.visible = true;
  panel.scale.set(1, 1, 1);
  paintPanelHp();
  panel.position.set(panelX, 0.85, -panelZ);
  hideBanner();
}
function damageShooter(n) {
  if (gameOver || !v09On) return;
  shooterHp = Math.max(0, shooterHp - n);
  hpFlash = 0.28;
  paintHud();
  if (shooterHp <= 0) {
    gameOver = true;
    waveWait = 0;
    showBanner('Game over - tap to restart', true);
  }
}
function endWave() {
  if (gameOver) return;
  for (let i = 0; i < ENEMY_N; i++) {
    enemies[i].alive = false;
    enemies[i].pop = 0;
    enemies[i].mesh.visible = false;
    enemies[i].tag.visible = false;
  }
  panelAlive = false;
  if (panelPop <= 0) panel.visible = false;
  showBanner('Wave clear', false);
  waveWait = 2;
}
function clearBullets() {
  count = 0;
  bulletMesh.count = 0;
}
function restartV09() {
  gameOver = false;
  shooterHp = 100;
  shooters = 1;
  wave = 1;
  waveWait = 0;
  hpFlash = 0;
  clearBullets();
  spawnWave();
  paintHud();
}
function breakPanel() {
  panelAlive = false;
  panelPop = 0.24;
  if (shooters < 4) shooters++;
  paintHud();
}
function updateV09(dt) {
  if (!v09On || gameOver) return;
  if (waveWait > 0) {
    waveWait -= dt;
    if (waveWait <= 0) {
      wave++;
      spawnWave();
      paintHud();
    }
    return;
  }
  for (let i = 0; i < ENEMY_N; i++) {
    const en = enemies[i];
    if (!en.alive) continue;
    if (en.pop > 0) {
      en.pop -= dt;
      const k = Math.max(0, en.pop / 0.2);
      en.mesh.scale.setScalar(0.35 + 1.15 * k);
      en.mesh.material.color.copy(ENEMY_WHITE);
      en.tag.visible = false;
      if (en.pop <= 0) {
        en.alive = false;
        en.mesh.visible = false;
      }
      continue;
    }
    en.z -= enemySpeed * dt;
    if (en.z <= 0.5) {
      en.alive = false;
      en.mesh.visible = false;
      en.tag.visible = false;
      foesAlive--;
      damageShooter(5);
      if (gameOver) return;
      continue;
    }
    const shrink = 0.62 + 0.38 * (en.hp / ENEMY_HP);
    en.mesh.scale.setScalar(shrink);
    if (en.flash > 0) {
      en.flash = Math.max(0, en.flash - dt);
      en.mesh.material.color.copy(ENEMY_BLUE).lerp(ENEMY_WHITE, en.flash / 0.12);
    } else en.mesh.material.color.copy(ENEMY_BLUE);
    en.mesh.position.set(en.x, ENEMY_R * shrink, -en.z);
    en.tag.visible = hpNumbers;
    if (hpNumbers) placeHpTag(en, shrink);
  }
  if (panelPop > 0) {
    panelPop -= dt;
    const k = Math.max(0, panelPop / 0.24);
    panel.visible = k > 0;
    panel.scale.setScalar(1 + 0.5 * k);
    panelMat.color.copy(PANEL_BASE).lerp(ENEMY_WHITE, Math.min(1, k + 0.35));
    panelMat.opacity = 0.25 + 0.7 * k;
    if (panelPop <= 0) panel.visible = false;
  } else if (panelAlive) {
    panelZ -= enemySpeed * dt;
    if (panelZ <= 0.5) {
      panelAlive = false;
      panel.visible = false;
    } else panel.position.set(panelX, 0.85, -panelZ);
  }
  if (!gameOver && foesAlive <= 0 && waveWait <= 0) endWave();
}
function syncEnemyTags() {
  for (let i = 0; i < ENEMY_N; i++) {
    const en = enemies[i];
    en.tag.visible = hpNumbers && en.alive && en.pop <= 0 && v09On;
  }
}
banner.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
banner.addEventListener('click', (e) => {
  e.stopPropagation();
  if (gameOver) restartV09();
});

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

// Gates. '+' and 'x' are cyan (good); '-' is red (bad). One mesh each, punch state is a number.
const GATE_H = 2, GATE_D = 0.2, GATE_Y = 1, GATE_SPREAD = 0.35;
const TRACK_LIM = CFG.track.width / 2;
let gateFx = true;
let m2On = false;
let v09On = true;
let enemySpeed = 4;
let hpNumbers = false;
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
function makeGate(op, value, good) {
  const baseHex = good ? 0x7cc8ff : 0xff5a32;
  const edgeHex = good ? 0xd8f0ff : 0xffc7a8;
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: baseHex, transparent: true, opacity: 0.38, depthWrite: false });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(3.5, GATE_H, GATE_D), mat);
  group.add(panel);
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(panel.geometry), new THREE.LineBasicMaterial({ color: edgeHex })));
  const lab = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2),
    new THREE.MeshBasicMaterial({ map: labelTexture(op + value), transparent: true, depthWrite: false }));
  lab.position.set(0, 0.05, GATE_D / 2 + 0.02);
  lab.renderOrder = 2;
  group.add(lab);
  scene.add(group);
  return {
    op, value, good, group, mat, lab,
    base: new THREE.Color(baseHex), flash: new THREE.Color(good ? 0xffffff : 0xffe4d6),
    x: 0, z: 12, w: 3.5, x0: 0, x1: 0, z0: 0, z1: 0,
    bit: 0, active: false, punch: 1, live: false, debt: 0,
  };
}
const gates = [makeGate('+', 3, true), makeGate('-', 2, false), makeGate('x', 2, true)];
for (let i = 0; i < gates.length; i++) gates[i].bit = 1 << i;
function restOne(g) {
  g.group.scale.set(1, 1, 1);
  g.group.position.x = g.x;
  g.lab.scale.set(1, 1, 1);
  g.mat.opacity = 0.38;
  g.mat.color.copy(g.base);
  g.live = false;
  g.punch = 1;
}
function restAllGates() { for (let i = 0; i < gates.length; i++) restOne(gates[i]); }
function placeGate(g, x, z, w, active) {
  g.x = x; g.z = z; g.w = w; g.active = active;
  g.group.visible = active;
  g.group.position.set(x, GATE_Y, -z);
  const r = CFG.bulletRadius;
  g.x0 = x - w / 2 - r; g.x1 = x + w / 2 + r;
  g.z0 = z - GATE_D / 2 - r; g.z1 = z + GATE_D / 2 + r;
  g.debt = 0;
  restOne(g);
}
function applyM2() {
  bPassed.fill(0);
  if (v09On) {
    for (let i = 0; i < gates.length; i++) {
      gates[i].active = false;
      gates[i].group.visible = false;
      restOne(gates[i]);
    }
    return;
  }
  if (m2On) {
    placeGate(gates[0], -1.75, 10, 3.5, true); // +3 left
    placeGate(gates[1], 1.75, 10, 3.5, true);  // -2 right
    placeGate(gates[2], 1.75, 20, 3.5, true);  // x2 right, further down
  } else {
    placeGate(gates[0], -1.75, 10, 3.5, false);
    placeGate(gates[1], 1.75, 10, 3.5, false);
    placeGate(gates[2], CFG.gate.x, CFG.gate.z, CFG.gate.w, true); // v0.7 x2 only
  }
}
function punchGate(g) {
  if (!gateFx) return;
  g.punch = 0;
  g.live = true;
}
function updateGatePunch(dt) {
  for (let gi = 0; gi < gates.length; gi++) {
    const g = gates[gi];
    if (!g.live) continue;
    if (!gateFx || !g.active) { restOne(g); continue; }
    g.punch += dt;
    const env = Math.exp(-g.punch / 0.03);
    const pop = Math.min(0.15, 0.12 * env);
    if (pop < 0.001) { restOne(g); continue; }
    g.group.scale.set(1 + pop, 1 + pop, 1);
    const flash = Math.exp(-g.punch / 0.034);
    g.group.position.x = g.x + (g.punch < 0.045 ? 0.03 : -0.03) * (pop / 0.12);
    g.mat.opacity = 0.38 + 0.27 * flash;
    g.mat.color.copy(g.base).lerp(g.flash, flash);
    const ls = 1 + 0.18 * flash;
    g.lab.scale.set(ls, ls, 1);
  }
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
const bulletMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 0.4),
  new THREE.MeshBasicMaterial({ color: 0xb8f7ff }), N);
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
applyM2();

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
  return !!(el && el.closest && el.closest('#actions, #tune-panel, #banner'));
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
const inM2 = document.getElementById('in-m2');
const inV09 = document.getElementById('in-v09');
const inHpNum = document.getElementById('in-hpnum');
const inEspeed = document.getElementById('in-espeed');
const outEspeed = document.getElementById('out-espeed');
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
      sensitivity: CFG.sensitivity, smoothK: CFG.smoothK, clampX: CFG.clampX, touchSmooth, gateFx, marker: markerOn, m2: m2On,
      v09: v09On, hpNumbers, enemySpeed,
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
  if (typeof saved.m2 === 'boolean') m2On = saved.m2;
  if (typeof saved.v09 === 'boolean') v09On = saved.v09;
  hpNumbers = saved.hpNumbers === true;
  const sp = quantize(saved.enemySpeed, 0.5, 8, 0.1);
  if (sp != null) enemySpeed = sp;
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
  inM2.checked = m2On;
  inV09.checked = v09On;
  inHpNum.checked = hpNumbers;
  inEspeed.value = String(enemySpeed);
  outEspeed.textContent = enemySpeed.toFixed(1);
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
applyM2();
if (v09On) {
  wall.visible = false;
  hitLabel.visible = false;
  spawnWave();
} else { wall.visible = true; hitLabel.visible = true; }
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
  if (!gateFx) restAllGates();
  persistTune();
});
inMarker.addEventListener('change', () => {
  markerOn = inMarker.checked;
  if (markerOn) placeMarker();
  else marker.visible = false;
  persistTune();
  paintHud();
});
inM2.addEventListener('change', () => {
  m2On = inM2.checked;
  applyM2();
  persistTune();
});
inEspeed.addEventListener('input', () => {
  const v = quantize(inEspeed.value, 0.5, 8, 0.1);
  if (v == null) return;
  enemySpeed = v;
  outEspeed.textContent = v.toFixed(1);
  persistTune();
});
inHpNum.addEventListener('change', () => {
  hpNumbers = inHpNum.checked;
  syncEnemyTags();
  persistTune();
});
inV09.addEventListener('change', () => {
  v09On = inV09.checked;
  gameOver = false;
  waveWait = 0;
  hideBanner();
  if (v09On) {
    shooterHp = 100; shooters = 1; wave = 1; hpFlash = 0;
    wall.visible = false; hitLabel.visible = false;
    spawnWave();
  } else {
    clearEnemies();
    wall.visible = true; hitLabel.visible = true;
    shooters = 1;
  }
  applyM2();
  paintHud();
  persistTune();
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
  m2On = false;
  v09On = true;
  enemySpeed = 4;
  hpNumbers = false;
  shooterHp = 100;
  shooters = 1;
  wave = 1;
  gameOver = false;
  waveWait = 0;
  moveSamples.length = 0;
  syncTuneUi();
  applyM2();
  if (v09On) restartV09();
  else { clearEnemies(); wall.visible = true; hitLabel.visible = true; }
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
    let text = `v0.10\nFPS ${fps.toFixed(0)}  worst ${worstMs.toFixed(1)}ms`;
  if (v09On) {
    text += `\nwave ${wave}  HP ${shooterHp}\nshooters ${shooters}  pool ${count}`;
    if (markerOn) {
      const last = markerLast == null ? '—' : markerLast.toFixed(2) + 's';
      const avg = markerN ? (markerSum / markerN).toFixed(2) + 's' : '—';
      text += `\nalign ${last}  avg ${avg}`;
    }
  } else {
    text += `\nbullets ${count}/${N}  units ${count}\nhits ${hits}  hits/s ${hitsPerSec.toFixed(1)}`;
    if (markerOn) {
      const last = markerLast == null ? '—' : markerLast.toFixed(2) + 's';
      const avg = markerN ? (markerSum / markerN).toFixed(2) + 's' : '—';
      text += `  align ${last}  avg ${avg}`;
    }
  }
  hud.textContent = text;
  const clearNow = wallClearPx();
  if (Math.abs(clearNow - fittedClear) > 1) {
    fittedClear = clearNow;
    fitCamera(window.innerWidth, window.innerHeight);
  }
}

function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (dt > 0.1) dt = 0.1; // tab switch / hitch guard
  time += dt;

  // Steering
  x += (targetX - x) * (1 - Math.exp(-CFG.smoothK * dt));
  layoutCannons();
  unitLabel.position.x = x;
  updateMarker(dt);
  if (hpFlash > 0) hpFlash = Math.max(0, hpFlash - dt);
  updateV09(dt);

  // Auto-fire (accumulator keeps exact 8/s regardless of frame rate)
  fireAcc += dt;
  const interval = 1 / CFG.fireRate;
  const firing = !(v09On && gameOver);
  if (firing) {
    while (fireAcc >= interval) {
      fireAcc -= interval;
      const n = v09On ? shooters : 1;
      const xs = cannonXs(n, x);
      for (let s = 0; s < n; s++) {
        spawn(xs[s], CFG.muzzleZ + CFG.bulletSpeed * fireAcc, fireAcc, 0);
      }
      shots++;
    }
  } else fireAcc = 0;

  // Move bullets, gates (swept on z), wall hit, expire. Copies come from the pool.
  const step = CFG.bulletSpeed * dt;
  let frameHits = 0;
  for (let i = 0; i < count; i++) {
    const z0 = bz[i];
    const z1 = z0 + step;
    bz[i] = z1; bAge[i] += dt;
    const px = bx[i];
    if (v09On) {
      if (bAge[i] < CFG.bulletLife) {
        const hitR = ENEMY_R + CFG.bulletRadius;
        for (let e = 0; e < ENEMY_N; e++) {
          const en = enemies[e];
          if (!en.alive || en.pop > 0) continue;
          if (px < en.x - hitR || px > en.x + hitR) continue;
          if (z1 < en.z - hitR || z0 > en.z + hitR) continue;
          en.hp -= 1;
          en.flash = 0.12;
          if (en.hp <= 0) {
            en.pop = 0.2;
            foesAlive--;
          } else if (hpNumbers) paintEnemyHp(en);
          bAge[i] = CFG.bulletLife;
          break;
        }
      }
      if (bAge[i] < CFG.bulletLife && panelAlive) {
        const hw = 0.75, hd = 0.18;
        if (px >= panelX - hw && px <= panelX + hw && z1 >= panelZ - hd && z0 <= panelZ + hd) {
          panelHp--;
          paintPanelHp();
          bAge[i] = CFG.bulletLife;
          if (panelHp <= 0) breakPanel();
        }
      }
    } else {
      for (let gi = 0; gi < gates.length; gi++) {
        const g = gates[gi];
        if (!g.active || (bPassed[i] & g.bit)) continue;
        if (z1 < g.z0 || z0 > g.z1 || px < g.x0 || px > g.x1) continue;
        bPassed[i] |= g.bit;
        if (g.op === '-') {
          if (g.debt < g.value) { g.debt++; bAge[i] = CFG.bulletLife; punchGate(g); break; }
          g.debt = 0; // 1 survivor per N+1 bullets
          continue;
        }
        const extras = g.op === '+' ? g.value : g.value - 1;
        const passed = bPassed[i], age = bAge[i];
        for (let k = 1; k <= extras; k++) {
          let cx = px + copySign * GATE_SPREAD * k;
          if (cx > TRACK_LIM) cx = TRACK_LIM;
          else if (cx < -TRACK_LIM) cx = -TRACK_LIM;
          spawn(cx, z1, age, passed);
          copySign = -copySign;
        }
        punchGate(g);
      }
      if (bAge[i] < CFG.bulletLife && z1 >= wz0 && z0 <= wz1 && px >= wx0 && px <= wx1) {
        bAge[i] = CFG.bulletLife;
        frameHits++;
      }
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
  unitDrawAcc += dt;
  if (count !== unitsShown && unitDrawAcc >= 0.1) {
    paintUnits(count);
    unitDrawAcc = 0;
  }

  // Upload instance matrices
  for (let i = 0; i < count; i++) {
    m4.makeTranslation(bx[i], BULLET_Y, -bz[i]);
    bulletMesh.setMatrixAt(i, m4);
  }
  bulletMesh.count = count;
  bulletMesh.instanceMatrix.needsUpdate = true;

  layoutCannons();
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
