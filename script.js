(function(){
"use strict";

/* =======================================================================
   CONFIG — tune gesture sensitivity here.
   All distances are normalized against hand size unless noted "px" (pixels
   in the internal canvas coordinate space, which matches the camera's
   native resolution).
   ======================================================================= */
const CONFIG = {
  // Pinch = distance(thumb_tip, index_tip) / distance(wrist, middle_finger_mcp).
  // This normalization makes the threshold roughly independent of how far
  // your hand is from the camera. Smaller value = fingers closer together.
  PINCH_START:   0.40,   // must drop BELOW this to register a new pinch
  PINCH_RELEASE: 0.60,   // must rise ABOVE this to release the pinch
  // ^ The gap between START and RELEASE is the "hysteresis band". Jitter
  //   that stays inside the band is ignored, so trembling fingers near the
  //   threshold won't cause rapid pinch/unpinch flicker.

  MIN_STABLE_FRAMES: 2, // reduced to respond faster to gestures
  FIST_CURL_COUNT: 3, // require three non‑thumb fingers curled for a fist

  // Two-hand rectangle stability check (used to "lock" the box):
  STABILITY_TOLERANCE_PX: 22,  // allowed drift per corner before the hold timer resets
  HOLD_DURATION_MS: 1800,      // how long the box must stay within tolerance to lock

  MIN_BOX_SIZE_PX: 70,         // ignore accidental tiny boxes

  // Matching detected hands frame-to-frame to stable "slots" (so the left
  // rectangle corner doesn't jump between hands). Distance is normalized
  // (0-1 image space).
  HAND_MATCH_MAX_DIST: 0.35,

  // A hand must be tracked for this many consecutive frames before its
  // gestures (pinch/fist) are trusted. Filters out one-or-two-frame "ghost"
  // hand detections that would otherwise register as a spurious extra pinch.


  // Film grain strength (0 = none, ~25 = fairly heavy). Applied as random
  // +/- noise per color channel per pixel.
  GRAIN_AMOUNT: 16,

  COUNTDOWN_STEP_MS: 1000,
  PUZZLE_MAX_DIM_PX: 420,
  SUCCESS_OVERLAY_MS: 1400
};

/* =======================================================================
   DOM refs
   ======================================================================= */
const video = document.getElementById('video');
const canvas = document.getElementById('stageCanvas');
const ctx = canvas.getContext('2d', {willReadFrequently:true});
const stageEl = document.getElementById('stage');
const statusPill = document.getElementById('statusPill');
const photoCounterEl = document.getElementById('photoCounter');
const clickBtn = document.getElementById('clickBtn');
const countdownEl = document.getElementById('countdownEl');
const flashEl = document.getElementById('flashEl');
const puzzleOverlay = document.getElementById('puzzleOverlay');
const puzzleGrid = document.getElementById('puzzleGrid');
const successOverlay = document.getElementById('successOverlay');
const viewToggleBtn = document.getElementById('viewToggleBtn');
const resetBtn = document.getElementById('resetBtn');
const downloadBtn = document.getElementById('downloadBtn');
const stripFrame = document.getElementById('stripFrame');
const stripTitle = document.getElementById('stripTitle');
const themeButtons = document.querySelectorAll('.theme-btn');

// offscreen "clean" canvas — always holds the current video frame
// with NO overlays drawn on it, so captures are guaranteed spoiler/skeleton-free.
const cleanCanvas = document.createElement('canvas');
const cctx = cleanCanvas.getContext('2d');
let camera = null;
const MIRROR_VIDEO = true;
const SUPPORTS_POINTER_EVENTS = window.PointerEvent !== undefined;

const APP_NAME = "PINCH & PRINT";

function ensureCanvasSize(){
  if(video.videoWidth && video.videoHeight){
    if(canvas.width !== video.videoWidth || canvas.height !== video.videoHeight){
      canvas.width = cleanCanvas.width = video.videoWidth;
      canvas.height = cleanCanvas.height = video.videoHeight;
    }
  }
}

function onResults(results){
  ensureCanvasSize();
  if(cleanCanvas.width && cleanCanvas.height){
    cctx.save();
    if(MIRROR_VIDEO){
      cctx.translate(cleanCanvas.width, 0);
      cctx.scale(-1, 1);
    }
    cctx.drawImage(video, 0, 0, cleanCanvas.width, cleanCanvas.height);
    cctx.restore();
  }

  updateTrackedHands(results.multiHandLandmarks || []);
  updateHandGestures();
  if(appState === 'locked'){
    handleLocked();
  }
  if(appState !== 'locked' && appState !== 'countdown' && appState !== 'capturing' && appState !== 'done' && appState !== 'puzzle'){
    handleIdleOrDrawing();
  }
  drawScene();
}

function drawScene(){
  if(!canvas.width || !canvas.height) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cleanCanvas, 0, 0, canvas.width, canvas.height);

  if(box){
    drawBox(box, (appState === 'locked' || appState === 'countdown') ? 'rgba(0,255,192,0.9)' : 'rgba(255,255,255,0.8)');
  }
  if(lockedBox){
    drawBox(lockedBox, 'rgba(0,200,255,0.6)');
  }

  trackedHands.forEach(h=>{
    if(!h) return;
    ctx.fillStyle = 'rgba(0,200,255,0.8)';
    ctx.beginPath();
    ctx.arc(h.screenPinch.x, h.screenPinch.y, 10, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(h.screenWrist.x, h.screenWrist.y, 6, 0, Math.PI*2);
    ctx.stroke();
  });
}

function drawBox(r, strokeStyle){
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
}

/* =======================================================================
   Small math helpers
   ======================================================================= */
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function mid(a,b){ return { x:(a.x+b.x)/2, y:(a.y+b.y)/2 }; }
function clampByte(v){ return v<0?0:(v>255?255:v); }

function landmarkToScreen(lm){
  return { x: MIRROR_VIDEO ? canvas.width - lm.x*canvas.width : lm.x*canvas.width, y: lm.y*canvas.height };
}
function getCanvasDisplayTransform(){
  const rect = canvas.getBoundingClientRect();
  const iw = canvas.width || 1, ih = canvas.height || 1;
  const isCover = stageEl.classList.contains('compact');
  const scale = isCover ? Math.max(rect.width/iw, rect.height/ih)
                        : Math.min(rect.width/iw, rect.height/ih);
  const drawW = iw*scale, drawH = ih*scale;
  return { scale, offsetX: rect.left + (rect.width-drawW)/2, offsetY: rect.top + (rect.height-drawH)/2 };
}
function canvasPointToClient(px,py){
  const t = getCanvasDisplayTransform();
  return { x: t.offsetX + px*t.scale, y: t.offsetY + py*t.scale };
}
function clientPointInRect(pt, rect){
  return pt.x>=rect.left && pt.x<=rect.right && pt.y>=rect.top && pt.y<=rect.bottom;
}
function rectFromPoints(p1,p2){
  const x = Math.min(p1.x,p2.x), y = Math.min(p1.y,p2.y);
  const w = Math.abs(p1.x-p2.x), h = Math.abs(p1.y-p2.y);
  return {x,y,w,h,x2:x+w,y2:y+h};
}

function pinchNormDist(lm){
  const dPinch = dist(lm[4], lm[8]);
  const dScale = dist(lm[0], lm[9]) || 0.0001;
  return dPinch/dScale;
}
function isFist(lm){
  const wrist = lm[0];
  const tips = [8,12,16,20], pips = [6,10,14,18];
  let curled = 0;
  for(let i=0;i<4;i++){
    if(dist(lm[tips[i]],wrist) < dist(lm[pips[i]],wrist)) curled++;
  }
  return curled >= CONFIG.FIST_CURL_COUNT;
}

let trackedHands = [null,null];
function updateTrackedHands(rawLandmarks){
  const detections = rawLandmarks.map(lm=>({landmarks:lm, wrist:lm[0]}));
  const used = new Set();
  const next = [null,null];
  for(let slot=0; slot<2; slot++){
    const prev = trackedHands[slot];
    if(!prev) continue;
    let bestIdx=-1, bestDist=Infinity;
    detections.forEach((d,i)=>{
      if(used.has(i)) return;
      const dd = dist(d.wrist, prev.wrist);
      if(dd<bestDist){ bestDist=dd; bestIdx=i; }
    });
    if(bestIdx!==-1 && bestDist<CONFIG.HAND_MATCH_MAX_DIST){
      used.add(bestIdx);
      next[slot] = { landmarks: detections[bestIdx].landmarks, wrist: detections[bestIdx].wrist, pinchActive: prev.pinchActive||false, wasFist: prev.wasFist||false, framesSeen: (prev.framesSeen||0)+1 };
    }
  }
  for(let i=0;i<detections.length;i++){
    if(used.has(i)) continue;
    const emptySlot = next.findIndex(s=>s===null);
    if(emptySlot!==-1){
      next[emptySlot] = { landmarks:detections[i].landmarks, wrist:detections[i].wrist, pinchActive:false, wasFist:false, framesSeen:1 };
      used.add(i);
    }
  }
  trackedHands = next;
}
function updateHandGestures(){
  trackedHands.forEach(h=>{
    if(!h) return;
    h.justPinched = false; h.justReleased = false; h.justFisted = false;
    if(h.framesSeen < CONFIG.MIN_STABLE_FRAMES){
      h.screenPinch = landmarkToScreen(mid(h.landmarks[4], h.landmarks[8]));
      h.screenWrist = landmarkToScreen(h.landmarks[0]);
      return;
    }
    const d = pinchNormDist(h.landmarks);
    if(!h.pinchActive && d < CONFIG.PINCH_START){ h.pinchActive = true; h.justPinched = true; }
    else if(h.pinchActive && d > CONFIG.PINCH_RELEASE){ h.pinchActive = false; h.justReleased = true; }
    const f = isFist(h.landmarks);
    h.justFisted = f && !h.wasFist;
    h.wasFist = f;
    h.screenPinch = landmarkToScreen(mid(h.landmarks[4], h.landmarks[8]));
    h.screenWrist = landmarkToScreen(h.landmarks[0]);
  });
}

let appState = 'idle';
let photoCount = 0;
let box = null;
let lockedBox = null;
let stableAnchor = null;
const savedPhotos = [];
let qrTimerInterval = null;
let activeSessionId = null;

function deleteSessionFromServer(sessionId) {
  if (!sessionId) return;
  const deleteUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8080'
    ? 'https://gesturesnap2.netlify.app/api/delete'
    : '/api/delete';
  try {
    fetch(deleteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId }),
      keepalive: true
    }).catch(() => {});
  } catch (e) {}
}

window.addEventListener('beforeunload', () => {
  if (activeSessionId) {
    deleteSessionFromServer(activeSessionId);
  }
});

function startQrCountdown(seconds = 60) {
  if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
  let timeLeft = seconds;
  const timerEl = document.getElementById('qrTimerEl');
  if (timerEl) timerEl.textContent = `${timeLeft}s`;

  qrTimerInterval = setInterval(() => {
    timeLeft--;
    if (timerEl) timerEl.textContent = `${timeLeft}s`;
    if (timeLeft <= 0) {
      clearInterval(qrTimerInterval);
      qrTimerInterval = null;
      if (activeSessionId) {
        deleteSessionFromServer(activeSessionId);
        activeSessionId = null;
      }
      resetSession();
    }
  }, 1000);
}

function setStatus(text){ statusPill.textContent = text; }
function updateProgressDots() {
  const activeIdx = Math.min(photoCount, 2);
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`dot${i}`);
    if (dot) {
      if (i === activeIdx && photoCount < 3) {
        dot.textContent = '●';
        dot.className = 'dot-item active';
      } else if (i < photoCount) {
        dot.textContent = '●';
        dot.className = 'dot-item active';
      } else {
        dot.textContent = '○';
        dot.className = 'dot-item inactive';
      }
    }
  }
}

function refreshCounter(){
  const numEl = document.getElementById('counterNum');
  if (numEl) {
    numEl.classList.remove('count-up-anim');
    void numEl.offsetWidth;
    numEl.textContent = photoCount;
    numEl.classList.add('count-up-anim');
  } else if (photoCounterEl) {
    photoCounterEl.textContent = `${photoCount} / 3`;
  }
  updateProgressDots();
}
function updateStability(p1,p2){
  const now = performance.now();
  if(!stableAnchor){ stableAnchor = {p1,p2,start:now}; return; }
  if(dist(p1,stableAnchor.p1) > CONFIG.STABILITY_TOLERANCE_PX || dist(p2,stableAnchor.p2) > CONFIG.STABILITY_TOLERANCE_PX){
    stableAnchor = {p1,p2,start:now}; return;
  }
  const heldMs = now - stableAnchor.start;
  if(heldMs >= CONFIG.HOLD_DURATION_MS){ tryLockBox(p1,p2); }
  else { setStatus(`Hold steady… ${Math.max(0, Math.ceil((CONFIG.HOLD_DURATION_MS-heldMs)/100)/10)}s`); }
}
function tryLockBox(p1,p2){
  const r = rectFromPoints(p1,p2);
  if(r.w < CONFIG.MIN_BOX_SIZE_PX || r.h < CONFIG.MIN_BOX_SIZE_PX){ stableAnchor = null; return; }
  lockedBox = r;
  box = lockedBox;
  appState = 'locked';
  stableAnchor = null;
  triggerCapture();
}
function handleIdleOrDrawing(){
  if(photoCount >= 3){ appState='done'; setStatus('Strip complete — download it!'); box=null; return; }
  const h0 = trackedHands[0], h1 = trackedHands[1];
  if(h0 && h1 && h0.pinchActive && h1.pinchActive){
    appState = 'drawing';
    box = rectFromPoints(h0.screenPinch, h1.screenPinch);
    if(box.w < CONFIG.MIN_BOX_SIZE_PX || box.h < CONFIG.MIN_BOX_SIZE_PX){ setStatus('Pinch both hands further apart…'); }
    else { updateStability(h0.screenPinch, h1.screenPinch); }
  } else {
    if(appState==='drawing'){ setStatus('Box cancelled — pinch both hands to retry'); }
    appState = 'idle'; box = null; stableAnchor = null;
    if(appState==='idle' && photoCount<3) setStatus('Show two pinching hands to draw a box');
  }
}
function handleLocked(){
  for(const h of trackedHands){
    if(!h) continue;
    if(h.justPinched){
      const cp = canvasPointToClient(h.screenPinch.x, h.screenPinch.y);
      if(clientPointInRect(cp, clickBtn.getBoundingClientRect())){ triggerCapture(); return; }
    }
  }
}
function triggerCapture(){
  if(appState!=='locked') return;
  appState = 'countdown';
  if (clickBtn) clickBtn.classList.remove('show');
  startCountdown(5);
}
function startCountdown(seconds = 5){
  // Ensure any previous countdown is cleared
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  let n = seconds;
  countdownEl.textContent = n;
  countdownEl.style.display = 'flex';
  setStatus(`Frame locked! Capturing in ${n}…`);
  countdownInterval = setInterval(() => {
    n--;
    if (n > 0) {
      countdownEl.textContent = n;
      setStatus(`Frame locked! Capturing in ${n}…`);
    } else {
      clearInterval(countdownInterval);
      countdownInterval = null;
      countdownEl.textContent = 'CAPTURE!';
      setStatus('📸 CAPTURE!');
      doCapture();
    }
  }, CONFIG.COUNTDOWN_STEP_MS);
}
function playShutterSound(){
  try{
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const dur = 0.09;
    const buf = ac.createBuffer(1, ac.sampleRate*dur, ac.sampleRate);
    const data = buf.getChannelData(0);
    for(let i=0;i<data.length;i++){
      const t = i/data.length;
      data[i] = (Math.random()*2-1) * Math.pow(1-t, 3);
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const gain = ac.createGain(); gain.gain.value = 0.5;
    src.connect(gain).connect(ac.destination);
    src.start();
    const osc = ac.createOscillator(); osc.type='square'; osc.frequency.value=180;
    const og = ac.createGain(); og.gain.setValueAtTime(0.15, ac.currentTime);
    og.gain.exponentialRampToValueAtTime(0.001, ac.currentTime+0.05);
    osc.connect(og).connect(ac.destination);
    osc.start(); osc.stop(ac.currentTime+0.06);
  }catch(e){}
}
function flashScreen(){ flashEl.classList.remove('flashing'); void flashEl.offsetWidth; flashEl.classList.add('flashing'); }
function showCaptureFeedback() {
  const el = document.getElementById('captureFeedback');
  if (!el) return;
  el.classList.remove('hidden');
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      el.classList.add('hidden');
    }, 300);
  }, 850);
}

function doCapture(){
  appState = 'capturing';
  flashScreen();
  playShutterSound();
  const b = lockedBox;
  const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
  const w = Math.min(cleanCanvas.width - x, Math.round(b.w));
  const h = Math.min(cleanCanvas.height - y, Math.round(b.h));
  const shot = document.createElement('canvas');
  shot.width = w; shot.height = h;
  shot.getContext('2d').drawImage(cleanCanvas, x, y, w, h, 0, 0, w, h);

  savedPhotos.push(shot);
  photoCount++;
  refreshCounter();
  showCaptureFeedback();

  const progressEl = document.getElementById('progressIndicator');
  if (progressEl) {
    if (photoCount === 1) progressEl.textContent = '● ● ○';
    else if (photoCount >= 2) progressEl.textContent = '● ● ●';
  }

  // Show captured overlay
  const countdownEl = document.getElementById('countdownEl');
  if (countdownEl) {
    countdownEl.textContent = '📸 CAPTURED!';
    countdownEl.style.display = 'flex';
    setTimeout(() => { countdownEl.style.display = 'none'; }, 800);
  }
  appState = 'idle';
  box = null;
  lockedBox = null;
  stableAnchor = null;
  clickBtn.classList.remove('show');
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  
  if (photoCount >= 3) {
    setStatus('🎉 3 Photos Captured! Generating your QR Code...');
    setTimeout(() => {
      uploadAndGenerateQR();
    }, 600);
  } else {
    setStatus(`Photo ${photoCount} captured — show two pinching hands to draw box`);
  }
}
// Attach reset button listener
if (resetBtn) resetBtn.addEventListener('click', resetSession);

function resetSession(){
  if (activeSessionId) {
    deleteSessionFromServer(activeSessionId);
    activeSessionId = null;
  }
  savedPhotos.length = 0;
  photoCount = 0;
  refreshCounter();
  const progressEl = document.getElementById('progressIndicator');
  if (progressEl) progressEl.textContent = '● ○ ○';
  appState = 'idle';
  box = null;
  lockedBox = null;
  stableAnchor = null;
  clickBtn.classList.remove('show');
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (qrTimerInterval) { clearInterval(qrTimerInterval); qrTimerInterval = null; }
  if (countdownEl) countdownEl.style.display = 'none';

  const qrModal = document.getElementById('qrModal');
  if (qrModal) qrModal.classList.add('hidden');
  const qrcodeContainer = document.getElementById('qrcode');
  if (qrcodeContainer) qrcodeContainer.innerHTML = '';

  setStatus('Session reset – show both hands to start');
}

function applyFilmEffect(canvasEl){
  const c = canvasEl.getContext('2d');
  const w = canvasEl.width, h = canvasEl.height;
  const tmp = document.createElement('canvas'); tmp.width=w; tmp.height=h;
  tmp.getContext('2d').drawImage(canvasEl,0,0);
  c.filter = 'grayscale(1) contrast(1.18) brightness(1.04)';
  c.drawImage(tmp,0,0);
  c.filter = 'none';
  const imgData = c.getImageData(0,0,w,h);
  const d = imgData.data;
  for(let i=0;i<d.length;i+=4){
    const n = (Math.random()-0.5) * CONFIG.GRAIN_AMOUNT;
    d[i]   = clampByte(d[i]+n);
    d[i+1] = clampByte(d[i+1]+n);
    d[i+2] = clampByte(d[i+2]+n);
  }
  c.putImageData(imgData,0,0);
  const cx=w/2, cy=h/2, minDim=Math.min(w,h);
  const grad = c.createRadialGradient(cx,cy,minDim*0.42, cx,cy,minDim*0.92);
  grad.addColorStop(0,'rgba(0,0,0,0)');
  grad.addColorStop(1,'rgba(0,0,0,0.32)');
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = grad;
  c.fillRect(0,0,w,h);
  c.globalCompositeOperation = 'source-over';
}
let puzzleState = null;
let countdownInterval = null; // global interval for countdown
function setupPuzzle(photoCanvas){
  appState = 'puzzle';
  box = null;
  lockedBox = null;
  stableAnchor = null;
  puzzleGrid.querySelectorAll('.puzzle-tile').forEach(t=>t.remove());
  const srcW = photoCanvas.width, srcH = photoCanvas.height;
  const availW = Math.max(160, stageEl.clientWidth - 60);
  const availH = Math.max(160, stageEl.clientHeight - 90);
  const maxDim = Math.min(CONFIG.PUZZLE_MAX_DIM_PX, availW, availH);
  const scale = maxDim / Math.max(srcW, srcH);
  const gridW = Math.round(srcW*scale), gridH = Math.round(srcH*scale);
  const tileW = gridW/3, tileH = gridH/3;
  puzzleGrid.style.width = gridW+'px';
  puzzleGrid.style.height = gridH+'px';
  const dataUrl = photoCanvas.toDataURL('image/png');
  let order = [0,1,2,3,4,5,6,7,8];
  do { shuffleArray(order); } while(isIdentity(order));
  const tileEls = order.map((originalIndex, slot)=>{
    const el = document.createElement('div');
    el.className = 'puzzle-tile';
    el.style.width = tileW+'px';
    el.style.height = tileH+'px';
    el.style.backgroundImage = `url(${dataUrl})`;
    el.style.backgroundSize = `${gridW}px ${gridH}px`;
    const oc = originalIndex % 3, orow = Math.floor(originalIndex/3);
    el.style.backgroundPosition = `-${oc*tileW}px -${orow*tileH}px`;
    el.dataset.original = originalIndex;
    el.draggable = false;
    positionTile(el, slot, tileW, tileH);
    el.addEventListener('click', onPuzzleTileClick);
    puzzleGrid.appendChild(el);
    return el;
  });
  puzzleState = { order, tileEls, photoCanvas, srcW, srcH, gridW, gridH, tileW, tileH, activeDrag:null, selectedTile:null };
  puzzleOverlay.classList.add('show');
  setStatus('Click a tile, then click another tile to swap');
}
function positionTile(el, slot, tileW, tileH){
  const col = slot % 3, row = Math.floor(slot/3);
  el.style.left = (col*tileW)+'px';
  el.style.top = (row*tileH)+'px';
  el.dataset.slot = slot;
}
function shuffleArray(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
}
function isIdentity(arr){ return arr.every((v,i)=>v===i); }

function resetTilePosition(tile, slot){
  positionTile(tile, slot, puzzleState.tileW, puzzleState.tileH);
}

function swapTiles(tileA, tileB){
  const slotA = Number(tileA.dataset.slot), slotB = Number(tileB.dataset.slot);
  [puzzleState.order[slotA], puzzleState.order[slotB]] = [puzzleState.order[slotB], puzzleState.order[slotA]];
  positionTile(tileA, slotB, puzzleState.tileW, puzzleState.tileH);
  positionTile(tileB, slotA, puzzleState.tileW, puzzleState.tileH);
  tileA.dataset.slot = slotB;
  tileB.dataset.slot = slotA;
  checkPuzzleSolved();
}

function addPhotoToStrip(photoCanvas) {
  if (savedPhotos.length >= 3) return;
  savedPhotos.push(photoCanvas);
  photoCount = savedPhotos.length;
  refreshCounter();

  // Update progress indicator dots
  const progressEl = document.getElementById('progressIndicator');
  if (progressEl) {
    const dots = ['● ○ ○', '● ● ○', '● ● ●'];
    progressEl.textContent = dots[Math.min(photoCount - 1, 2)];
  }

  const slotIndex = savedPhotos.length - 1;
  const slotEl = document.getElementById(`slot${slotIndex}`);
  if (slotEl) {
    slotEl.classList.remove('empty');
    slotEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = photoCanvas.toDataURL('image/png');
    img.alt = `Photo ${slotIndex + 1}`;
    slotEl.appendChild(img);
  }

  if (savedPhotos.length >= 3) {
    if (downloadBtn) downloadBtn.disabled = false;
  }
}

function checkPuzzleSolved(){
  if(!puzzleState) return;
  if(puzzleState.order.every((val,index)=>val===index)){
    puzzleOverlay.classList.remove('show');
    successOverlay.classList.add('show');
    setStatus('Puzzle solved!');

    if (puzzleState.photoCanvas) {
      addPhotoToStrip(puzzleState.photoCanvas);
    }

    setTimeout(()=>{
      successOverlay.classList.remove('show');
      if (savedPhotos.length >= 3) {
        appState = 'done';
        setStatus('Strip complete — download it!');
      } else {
        appState = 'idle';
        setStatus('Show two pinching hands to draw a box');
      }
    }, CONFIG.SUCCESS_OVERLAY_MS);
  }
}

function clearSelectedTile(){
  if(!puzzleState || !puzzleState.selectedTile) return;
  puzzleState.selectedTile.classList.remove('selected');
  puzzleState.selectedTile = null;
}

function onPuzzleTileClick(event){
  if(appState !== 'puzzle' || !puzzleState) return;
  const tile = event.target.closest('.puzzle-tile');
  if(!tile) return;
  event.preventDefault();
  if(puzzleState.selectedTile && puzzleState.selectedTile !== tile){
    swapTiles(puzzleState.selectedTile, tile);
    clearSelectedTile();
    setStatus('Tile swapped — select another tile or solve the puzzle');
    return;
  }
  if(puzzleState.selectedTile === tile){
    clearSelectedTile();
    setStatus('Tile selection cleared');
    return;
  }
  clearSelectedTile();
  puzzleState.selectedTile = tile;
  tile.classList.add('selected');
  setStatus('Tile selected — click another tile to swap');
}

function startPuzzleDrag(tile, event){
  const rect = tile.getBoundingClientRect();
  const gridRect = puzzleGrid.getBoundingClientRect();
  puzzleState.activeDrag = {
    tile,
    startSlot: Number(tile.dataset.slot),
    startLeft: parseFloat(tile.style.left),
    startTop: parseFloat(tile.style.top),
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    gridRect,
    dragging: false,
    startX: event.clientX,
    startY: event.clientY
  };
  tile.classList.add('selected');
}

function onPuzzlePointerDown(event){
  if(appState !== 'puzzle' || !puzzleState) return;
  const tile = event.target.closest('.puzzle-tile');
  if(!tile) return;
  event.preventDefault();

  if(puzzleState.selectedTile && puzzleState.selectedTile !== tile){
    swapTiles(puzzleState.selectedTile, tile);
    clearSelectedTile();
    return;
  }

  if(puzzleState.selectedTile === tile){
    clearSelectedTile();
    return;
  }

  clearSelectedTile();
  puzzleState.selectedTile = tile;
  startPuzzleDrag(tile, event);
}

function onPuzzlePointerMove(event){
  if(!puzzleState || !puzzleState.activeDrag) return;
  const drag = puzzleState.activeDrag;
  const moveX = event.clientX - drag.startX;
  const moveY = event.clientY - drag.startY;
  if(!drag.dragging && Math.hypot(moveX, moveY) > 8){
    drag.dragging = true;
    drag.tile.style.transition = 'none';
    drag.tile.style.zIndex = '10';
  }
  if(!drag.dragging) return;
  event.preventDefault();
  const x = Math.min(Math.max(event.clientX - drag.gridRect.left - drag.offsetX, 0), puzzleState.gridW - puzzleState.tileW);
  const y = Math.min(Math.max(event.clientY - drag.gridRect.top - drag.offsetY, 0), puzzleState.gridH - puzzleState.tileH);
  drag.tile.style.left = `${x}px`;
  drag.tile.style.top = `${y}px`;
}

function onPuzzlePointerUp(event){
  if(!puzzleState || !puzzleState.activeDrag) return;
  event.preventDefault();
  const drag = puzzleState.activeDrag;
  if(!drag.dragging){
    drag.tile.style.left = `${drag.startLeft}px`;
    drag.tile.style.top = `${drag.startTop}px`;
    drag.tile.classList.add('selected');
    puzzleState.activeDrag = null;
    return;
  }
  const prevVisibility = drag.tile.style.visibility;
  drag.tile.style.visibility = 'hidden';
  const dropTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest('.puzzle-tile');
  drag.tile.style.visibility = prevVisibility;
  if(dropTarget && dropTarget !== drag.tile){
    swapTiles(drag.tile, dropTarget);
  } else {
    resetTilePosition(drag.tile, drag.startSlot);
  }
  drag.tile.style.transition = '';
  drag.tile.style.zIndex = '';
  puzzleState.activeDrag = null;
}

function onPuzzleMouseDown(event){
  if(event.button !== 0) return;
  onPuzzlePointerDown(event);
}

function onPuzzleMouseMove(event){
  onPuzzlePointerMove(event);
}

function onPuzzleMouseUp(event){
  onPuzzlePointerUp(event);
}

function onPuzzleTouchStart(event){
  if(event.touches.length !== 1) return;
  onPuzzlePointerDown(event.touches[0]);
}

function onPuzzleTouchMove(event){
  if(!puzzleState || !puzzleState.activeDrag) return;
  onPuzzlePointerMove(event.touches[0]);
}

function onPuzzleTouchEnd(event){
  if(event.changedTouches.length !== 1) return;
  onPuzzlePointerUp(event.changedTouches[0]);
}

function resetPhotoStrip() {
  savedPhotos.length = 0;
  photoCount = 0;
  refreshCounter();
  if (downloadBtn) downloadBtn.disabled = true;
  for (let i = 0; i < 3; i++) {
    const slotEl = document.getElementById(`slot${i}`);
    if (slotEl) {
      slotEl.classList.add('empty');
      slotEl.textContent = `PHOTO 0${i + 1}`;
    }
  }
  appState = 'idle';
  box = null;
  lockedBox = null;
  puzzleOverlay.classList.remove('show');
  successOverlay.classList.remove('show');
  setStatus('Show two pinching hands to draw a box');
}

function drawCanvasRoundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

let shopLogoImg = null;
function initShopLogo() {
  const logoCandidates = ['logo-clean.png', 'Nutridelight.jpeg', 'Nutridelight.jpg', 'Nutridelight.png', 'logo.png', 'shop-logo.png', 'logo.svg', 'logo.jpg'];
  let currentIdx = 0;

  function tryNextLogo() {
    if (currentIdx >= logoCandidates.length) {
      console.warn('[ShopLogo] No logo file found from candidates:', logoCandidates);
      return;
    }
    const candidate = logoCandidates[currentIdx];
    console.log(`[ShopLogo] Trying to load: ${candidate}`);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      shopLogoImg = img;
      console.log(`[ShopLogo] ✅ Loaded successfully: ${candidate} (${img.naturalWidth}x${img.naturalHeight})`);
    };
    img.onerror = (e) => {
      console.log(`[ShopLogo] ❌ Failed to load: ${candidate}`, e);
      currentIdx++;
      tryNextLogo();
    };
    img.src = candidate;
  }

  tryNextLogo();
}
initShopLogo();

let borderTemplateImg = null;
function initBorderTemplate() {
  const img = new Image();
  img.onload = () => {
    borderTemplateImg = img;
    console.log(`[BorderTemplate] ✅ Loaded successfully: border-green.png (${img.naturalWidth}x${img.naturalHeight})`);
  };
  img.onerror = (e) => {
    console.warn('[BorderTemplate] Failed to load border-green.png', e);
  };
  img.src = 'border-green.png';
}
initBorderTemplate();

function generateStripCanvas() {
  if (savedPhotos.length === 0) return null;

  // EXACT 1080 x 1920 (9:16) resolution canvas
  const CANVAS_WIDTH = 1080;
  const CANVAS_HEIGHT = 1920;

  const stripCanvas = document.createElement('canvas');
  stripCanvas.width = CANVAS_WIDTH;
  stripCanvas.height = CANVAS_HEIGHT;
  const sctx = stripCanvas.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';

  const PHOTO_BORDER  = 'rgba(42, 90, 24, 0.20)';

  // Protected vertical zones:
  // Top: Nutri Delight logo ends at Y = 344
  const photosRegionTop = 350;
  // Bottom: Footer "POWERED BY" branding begins at Y = 1762
  // Protected footer area: leave guaranteed clear empty space before footer
  const photosRegionBottom = 1715;
  const availablePhotosHeight = photosRegionBottom - photosRegionTop; // 1365 px

  const basePhotoW = 608;
  const defaultGap = 20;

  // Calculate photo heights preserving exact original aspect ratios
  let photoHeights = savedPhotos.map(p => Math.round((basePhotoW / p.width) * p.height));
  let totalPhotosHeight = photoHeights.reduce((s, h) => s + h, 0);
  const numGaps = Math.max(1, savedPhotos.length - 1);

  let effectivePhotoW = basePhotoW;
  let effectivePhotoX = (CANVAS_WIDTH - effectivePhotoW) / 2;
  let gap = defaultGap;

  // Ensure complete 3-photo block fits inside the available photo-content region
  if (totalPhotosHeight > availablePhotosHeight) {
    const scale = availablePhotosHeight / totalPhotosHeight;
    effectivePhotoW = Math.round(basePhotoW * scale);
    effectivePhotoX = (CANVAS_WIDTH - effectivePhotoW) / 2;
    photoHeights = savedPhotos.map(p => Math.round((effectivePhotoW / p.width) * p.height));
    totalPhotosHeight = photoHeights.reduce((s, h) => s + h, 0);
    gap = 0;
  } else {
    const remainingForGaps = availablePhotosHeight - totalPhotosHeight;
    gap = Math.min(defaultGap, Math.max(0, Math.floor(remainingForGaps / numGaps)));
  }

  const totalBlockHeight = totalPhotosHeight + (savedPhotos.length - 1) * gap;
  // Center vertically inside the designated photo-content region [photosRegionTop, photosRegionBottom]
  let currentY = Math.round(photosRegionTop + (availablePhotosHeight - totalBlockHeight) / 2);

  savedPhotos.forEach((p, i) => {
    const h = photoHeights[i];
    sctx.drawImage(p, effectivePhotoX, currentY, effectivePhotoW, h);
    sctx.strokeStyle = PHOTO_BORDER;
    sctx.lineWidth = 1.5;
    sctx.strokeRect(effectivePhotoX, currentY, effectivePhotoW, h);
    currentY += h + gap;
  });

  return stripCanvas;
}

// ==========================================================
// POST-PROCESSING STEP: COMPOSE FINAL 1080 x 1920 CANVAS
// Applies the green + cream Nutri Delight border design from
// reference image (organic green waves, corner leaves, rays,
// footer branding) and composites the locked 3-photo strip.
// The old brown borders and brown decorations are completely removed.
// ==========================================================
function composeFinalCanvas() {
  const rawStrip = generateStripCanvas();
  if (!rawStrip) return null;

  const FINAL_WIDTH = 1080;
  const FINAL_HEIGHT = 1920;

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = FINAL_WIDTH;
  finalCanvas.height = FINAL_HEIGHT;
  const fctx = finalCanvas.getContext('2d');
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';

  const BG_COLOR = '#F8F9EE';

  // 1. Clean cream main background
  fctx.fillStyle = BG_COLOR;
  fctx.fillRect(0, 0, FINAL_WIDTH, FINAL_HEIGHT);

  // 2. Draw NEW GREEN/CREAM NUTRI DELIGHT BORDER (from reference design)
  if (borderTemplateImg && borderTemplateImg.complete && borderTemplateImg.naturalWidth > 0) {
    fctx.drawImage(borderTemplateImg, 0, 0, FINAL_WIDTH, FINAL_HEIGHT);
  }

  // 3. Draw existing generated photo strip as locked content layer
  fctx.drawImage(rawStrip, 0, 0, FINAL_WIDTH, FINAL_HEIGHT);

  // 4. Draw high-resolution NUTRI DELIGHT SHOP LOGO centered at top
  const logoCenterY = 177;
  const logoSize = 334;

  if (shopLogoImg && shopLogoImg.complete && shopLogoImg.naturalWidth > 0) {
    const scale = Math.min(
      logoSize / shopLogoImg.naturalWidth,
      logoSize / shopLogoImg.naturalHeight
    );
    const drawW = Math.round(shopLogoImg.naturalWidth * scale);
    const drawH = Math.round(shopLogoImg.naturalHeight * scale);
    const drawX = Math.round((FINAL_WIDTH - drawW) / 2);
    const drawY = Math.round(logoCenterY - drawH / 2);

    fctx.drawImage(shopLogoImg, drawX, drawY, drawW, drawH);
    console.log(`[FinalCanvas] ✅ Nutri Delight logo drawn at (${drawX}, ${drawY}) size ${drawW}x${drawH}`);
  } else {
    fctx.textAlign = 'center';
    fctx.textBaseline = 'middle';
    fctx.font = '700 48px "Poppins", sans-serif';
    fctx.fillStyle = '#4a8c2a';
    fctx.fillText('Nutri Delight', FINAL_WIDTH / 2, logoCenterY);
    console.log('[FinalCanvas] ⚠️ Nutri Delight text fallback drawn');
  }

  return finalCanvas;
}

function downloadStrip() {
  if (savedPhotos.length === 0) {
    setStatus('No photos captured yet — show hands to capture photos!');
    return;
  }
  const finalCanvas = composeFinalCanvas();
  if (!finalCanvas) return;
  const link = document.createElement('a');
  link.download = `gesturesnap_strip_${Date.now()}.png`;
  link.href = finalCanvas.toDataURL('image/png');
  link.click();
}

async function uploadAndGenerateQR() {
  const captureFb = document.getElementById('captureFeedback');
  if (captureFb) {
    captureFb.classList.remove('show');
    captureFb.classList.add('hidden');
  }

  const finalCanvas = composeFinalCanvas();
  if (!finalCanvas) return;

  const qrStripPreview = document.getElementById('qrStripPreview');
  const qrModal = document.getElementById('qrModal');
  const qrcodeContainer = document.getElementById('qrcode');

  if (qrStripPreview) {
    qrStripPreview.src = finalCanvas.toDataURL('image/png');
  }

  if (qrcodeContainer) {
    qrcodeContainer.innerHTML = '<span style="color:#888;font-size:13px;font-weight:600;">Generating QR Code...</span>';
  }

  if (qrModal) {
    qrModal.classList.remove('hidden');
  }

  try {
    const dataUrl = finalCanvas.toDataURL('image/jpeg', 0.90);
    const requestUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8080'
      ? 'https://gesturesnap2.netlify.app/api/upload'
      : '/api/upload';
    console.log(`[Upload Diagnostic] Sending POST request to ${requestUrl} (Payload length: ${dataUrl.length} chars)`);

    const res = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*'
      },
      body: JSON.stringify({ image: dataUrl })
    });

    const statusStr = `${res.status} ${res.statusText}`;
    console.log(`[Upload Diagnostic] Response Status: ${statusStr}`);
    console.log(`[Upload Diagnostic] Response URL: ${res.url}`);

    const resHeadersObj = {};
    if (res.headers && res.headers.forEach) {
      res.headers.forEach((val, key) => { resHeadersObj[key] = val; });
    }
    console.log(`[Upload Diagnostic] Response Headers:`, resHeadersObj);

    const errText = await res.text();
    console.log(`[Upload Diagnostic] Response Body:`, errText);

    if (!res.ok) {
      throw new Error(`Upload response status ${statusStr}: ${errText || '[Empty Response Body]'}`);
    }

    let json;
    try {
      json = JSON.parse(errText);
    } catch(e) {
      throw new Error(`Invalid JSON response (Status ${statusStr}): ${errText}`);
    }

    if (json && json.success) {
      activeSessionId = json.id || json.session_id;
      let fullQrUrl = json.fullQrUrl;
      if (!fullQrUrl && json.downloadUrl) {
        fullQrUrl = window.location.origin + json.downloadUrl;
      } else if (!fullQrUrl && json.id) {
        fullQrUrl = `https://gesturesnap2.netlify.app/download.html?id=${encodeURIComponent(json.id)}`;
      }

      console.log("QR URL:", fullQrUrl);

      if (qrcodeContainer && fullQrUrl) {
        qrcodeContainer.innerHTML = '';
        new QRCode(qrcodeContainer, {
          text: fullQrUrl,
          width: 170,
          height: 170,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.H
        });
        setStatus('QR Code generated! Scan with your phone.');
      }
      const expiryDuration = (json.expires_in && typeof json.expires_in === 'number') ? json.expires_in : 60;
      startQrCountdown(expiryDuration);
    } else {
      throw new Error((json && json.error) || `Upload error: ${errText}`);
    }
  } catch (err) {
    console.error('Backend upload error:', err);
    if (qrcodeContainer) {
      qrcodeContainer.innerHTML = `<div style="color:#ff4d4d;font-size:13px;font-weight:600;padding:15px;text-align:center;">Upload Failed<br><span style="font-size:11px;color:#aaa;">${err.message || 'Error generating QR'}</span></div>`;
      setStatus('Upload failed — please check connection/settings.');
    }
    startQrCountdown(60);
  }
}

function attachPuzzleControls(){
  if (resetBtn) resetBtn.addEventListener('click', resetSession);
  if (downloadBtn) downloadBtn.addEventListener('click', downloadStrip);
  const modalDownloadBtn = document.getElementById('modalDownloadBtn');
  if (modalDownloadBtn) modalDownloadBtn.addEventListener('click', downloadStrip);
  const closeQrModalBtn = document.getElementById('closeQrModalBtn');
  if (closeQrModalBtn) {
    closeQrModalBtn.addEventListener('click', () => {
      const qrModal = document.getElementById('qrModal');
      if (qrModal) qrModal.classList.add('hidden');
    });
  }
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  themeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      themeButtons.forEach(b => b.classList.remove('active-toggle'));
      btn.classList.add('active-toggle');
      const theme = btn.dataset.theme;
      document.body.setAttribute('data-theme', theme);
      if (stripFrame) stripFrame.setAttribute('data-theme', theme);
    });
  });
}

function init(){
  attachPuzzleControls();
  // Set initial default theme
  document.body.setAttribute('data-theme', 'retro');
  if (stripFrame) stripFrame.setAttribute('data-theme', 'retro');

  if(typeof Hands === 'undefined' || typeof Camera === 'undefined'){
    setStatus('Camera unavailable — MediaPipe scripts failed to load');
    console.error('MediaPipe Hands/Camera is not available');
    return;
  }

  const hands = new Hands({
    locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.5
  });

  hands.onResults(onResults);

  camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({image: video});
    },
    width: 1280,
    height: 720
  });

  camera.start().then(() => {
    setStatus('Camera ready — show a hand to begin');
  }).catch(err => {
    setStatus('Unable to access camera');
    console.error('Camera start failed:', err);
  });
}
init();
})();