const brainCanvas = document.querySelector('#brain');
const rollCanvas = document.querySelector('#roll');
const playButton = document.querySelector('#play');
const stopButton = document.querySelector('#stop');
const tempoButtons = [...document.querySelectorAll('.tempo-button')];
const tempoDisplay = document.querySelector('#tempo-display');
const startScreen = document.querySelector('#start-screen');
const startButton = document.querySelector('#start-button');
const gameToggle = document.querySelector('#game-toggle');
const stage = document.querySelector('#stage');
const game = document.querySelector('#game');
const fly = document.querySelector('#fly');
const swatter = document.querySelector('#swatter');
const joystick = document.querySelector('#joystick');
const stick = document.querySelector('#stick');
const hitButton = document.querySelector('#hit-button');

const brainCtx = brainCanvas.getContext('2d');
const rollCtx = rollCanvas.getContext('2d');
const ASSET_VERSION = '24';
const DATA_URL = new URL(`./data/fly.bin?v=${ASSET_VERSION}`, import.meta.url);
const WASM_URL = new URL(`./engine.wasm?v=${ASSET_VERSION}`, import.meta.url);
const PIANO_URL = new URL(`./sf2/piano.sf2?v=${ASSET_VERSION}`, import.meta.url);
const VOICE_URL = new URL(`./sf2/voice.sf2?v=${ASSET_VERSION}`, import.meta.url);
const DRUM_URL = new URL(`./sf2/drums.sf2?v=${ASSET_VERSION}`, import.meta.url);
const WORKLET_URL = new URL(`./audio-worklet.js?v=${ASSET_VERSION}`, import.meta.url);

let flyData = null;
let activeUntil = new Float64Array(0);
let notes = [];
let audioContext = null;
let audioNode = null;
let audioReady = false;
let audioStarting = false;
let tempoBpm = 120;

let gameEnabled = false;
let joystickPointer = null;
let joystickX = 0;
let joystickY = 0;
let swatterX = 0.5;
let swatterY = 0.5;
let flyX = 0.32;
let flyY = 0.28;
let flyVx = 0.07;
let flyVy = 0.045;
let nextFlyDrift = 0;
let lastGameFrame = performance.now();
let lastHit = 0;

stopButton.disabled = true;

const japanese = (navigator.languages?.[0] || navigator.language || 'en')
  .toLowerCase()
  .startsWith('ja');
const strings = japanese
  ? {
      intro: 'ショウジョウバエの脳の接続マップから音楽を生成します。',
      start: 'タップでスタート',
      slower: '遅く',
      faster: '早く',
      play: '再生',
      stop: '停止',
      game: 'ハエ叩き',
      hit: '叩く',
    }
  : {
      intro: 'Music generated from the mapped connections of a fruit fly brain.',
      start: 'TAP TO START',
      slower: 'SLOWER',
      faster: 'FASTER',
      play: 'PLAY',
      stop: 'STOP',
      game: 'Fly swatter',
      hit: 'HIT',
    };

document.documentElement.lang = japanese ? 'ja' : 'en';
for (const element of document.querySelectorAll('[data-i18n]')) {
  const key = element.dataset.i18n;
  if (strings[key]) element.textContent = strings[key];
}
for (const element of document.querySelectorAll('[data-i18n-label]')) {
  const key = element.dataset.i18nLabel;
  if (strings[key]) {
    element.setAttribute('aria-label', strings[key]);
    element.title = strings[key];
  }
}
gameToggle.setAttribute('aria-label', strings.game);
gameToggle.title = strings.game;
hitButton.setAttribute('aria-label', strings.hit);

function blockGesture(event) {
  event.preventDefault();
}

document.addEventListener('gesturestart', blockGesture, { passive: false });
document.addEventListener('gesturechange', blockGesture, { passive: false });
document.addEventListener('gestureend', blockGesture, { passive: false });
document.addEventListener('dblclick', blockGesture, { passive: false });
document.addEventListener('contextmenu', blockGesture, { passive: false });
document.addEventListener('selectstart', blockGesture, { passive: false });
document.addEventListener('dragstart', blockGesture, { passive: false });
document.addEventListener('touchmove', blockGesture, { passive: false });
document.addEventListener('touchstart', (event) => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });

function updateTempoDisplay() {
  tempoDisplay.textContent = `♩ = ${tempoBpm}`;
}

function setTempo(bpm) {
  tempoBpm = Math.max(40, Math.min(240, Math.round(bpm / 10) * 10));
  updateTempoDisplay();
  if (audioNode) audioNode.port.postMessage({ type: 'tempo', bpm: tempoBpm });
}

for (const button of tempoButtons) {
  button.addEventListener('click', () => {
    setTempo(tempoBpm + Number(button.dataset.delta || 0));
  });
}
updateTempoDisplay();

function fetchArrayBuffer(url) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return response.arrayBuffer();
  });
}

const flyDataPromise = fetchArrayBuffer(DATA_URL)
  .then((buffer) => {
    flyData = parseFlyData(buffer);
    activeUntil = new Float64Array(flyData.nodeCount);
    return buffer;
  })
  .catch((error) => {
    console.error(error);
    throw error;
  });

function parseFlyData(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  offset = 4;
  if (magic !== 'FLYM') throw new Error('Invalid FlyMusic data file.');

  const version = view.getUint16(offset, true); offset += 2;
  offset += 2;
  if (version !== 1) throw new Error(`Unsupported FlyMusic data version: ${version}`);

  const vizCount = view.getUint32(offset, true); offset += 4;
  const nodeCount = view.getUint32(offset, true); offset += 4;
  const edgeCount = view.getUint32(offset, true); offset += 4;

  const viz = new Int16Array(vizCount * 2);
  for (let i = 0; i < viz.length; i += 1) {
    viz[i] = view.getInt16(offset, true);
    offset += 2;
  }

  const nodes = new Int16Array(nodeCount * 2);
  for (let i = 0; i < nodeCount; i += 1) {
    nodes[i * 2] = view.getInt16(offset, true); offset += 2;
    nodes[i * 2 + 1] = view.getInt16(offset, true); offset += 2;
    offset += 4;
  }

  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i <= nodeCount; i += 1) {
    offsets[i] = view.getUint32(offset, true);
    offset += 4;
  }

  const edgesOffset = offset;
  const lines = [];
  const targetLines = 500;
  const stride = Math.max(1, Math.floor(edgeCount / targetLines));
  let seen = 0;

  outer:
  for (let src = 0; src < nodeCount; src += 1) {
    for (let edge = offsets[src]; edge < offsets[src + 1]; edge += 1) {
      if ((seen++ % stride) === 0) {
        const dst = view.getUint16(edgesOffset + edge * 4, true);
        lines.push(src, dst);
        if (lines.length >= targetLines * 2) break outer;
      }
    }
  }

  return { viz, nodes, lines, nodeCount };
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

const resizeObserver = new ResizeObserver(() => {
  resizeCanvas(brainCanvas);
  resizeCanvas(rollCanvas);
});
resizeObserver.observe(brainCanvas);
resizeObserver.observe(rollCanvas);
resizeCanvas(brainCanvas);
resizeCanvas(rollCanvas);

function pointToCanvas(x16, y16, width, height) {
  const margin = Math.min(width, height) * 0.055;
  return [
    margin + ((x16 + 32767) / 65534) * (width - margin * 2),
    margin + ((y16 + 32767) / 65534) * (height - margin * 2),
  ];
}

function renderBrain(now) {
  const w = brainCanvas.width;
  const h = brainCanvas.height;
  brainCtx.clearRect(0, 0, w, h);
  if (!flyData) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  brainCtx.strokeStyle = 'rgba(255,255,255,0.13)';
  brainCtx.lineWidth = Math.max(1, dpr * 0.5);
  brainCtx.beginPath();

  for (let i = 0; i < flyData.lines.length; i += 2) {
    const src = flyData.lines[i];
    const dst = flyData.lines[i + 1];
    const a = pointToCanvas(flyData.nodes[src * 2], flyData.nodes[src * 2 + 1], w, h);
    const b = pointToCanvas(flyData.nodes[dst * 2], flyData.nodes[dst * 2 + 1], w, h);
    brainCtx.moveTo(a[0], a[1]);
    brainCtx.lineTo(b[0], b[1]);
  }
  brainCtx.stroke();

  const dot = Math.max(1, Math.round(dpr));
  brainCtx.fillStyle = 'rgba(255,255,255,0.48)';
  for (let i = 0; i < flyData.viz.length; i += 2) {
    const p = pointToCanvas(flyData.viz[i], flyData.viz[i + 1], w, h);
    brainCtx.fillRect(Math.round(p[0]), Math.round(p[1]), dot, dot);
  }

  const nodeDot = Math.max(2, Math.round(dpr * 1.2));
  brainCtx.fillStyle = '#fff';
  for (let node = 0; node < flyData.nodeCount; node += 1) {
    if (activeUntil[node] <= now) continue;
    const p = pointToCanvas(flyData.nodes[node * 2], flyData.nodes[node * 2 + 1], w, h);
    brainCtx.fillRect(
      Math.round(p[0] - nodeDot),
      Math.round(p[1] - nodeDot),
      nodeDot * 2,
      nodeDot * 2,
    );
  }
}

function renderRoll(now) {
  const w = rollCanvas.width;
  const h = rollCanvas.height;
  const windowMs = 12000;
  const minNote = 36;
  const maxNote = 84;
  const range = maxNote - minNote + 1;
  const rowH = h / range;
  const startWindow = now - windowMs;

  rollCtx.clearRect(0, 0, w, h);
  notes = notes.filter((event) => event.time + event.duration > startWindow);

  for (const event of notes) {
    const x = ((event.time - startWindow) / windowMs) * w;
    const y = ((maxNote - event.note) / range) * h;

    if (event.drum) {
      const radius = Math.max(2, Math.min(6, rowH * 0.62));
      rollCtx.fillStyle = '#fff';
      rollCtx.beginPath();
      rollCtx.arc(x, y + rowH * 0.5, radius, 0, Math.PI * 2);
      rollCtx.fill();
      continue;
    }

    const width = Math.max(2, (event.duration / windowMs) * w);
    const height = Math.max(2, rowH * 0.78);
    if (event.kind === 0) {
      rollCtx.fillStyle = '#fff';
      rollCtx.fillRect(x, y, width, height);
    } else {
      rollCtx.strokeStyle = '#fff';
      rollCtx.lineWidth = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      rollCtx.strokeRect(x, y, width, height);
    }
  }
}

function randomSeed() {
  const seed = new Uint32Array(1);
  crypto.getRandomValues(seed);
  return seed[0];
}

function resetBrain() {
  activeUntil.fill(0);
  if (audioNode) audioNode.port.postMessage({ type: 'reset', seed: randomSeed() });
}

function resetFlyMotion() {
  flyX = 0.16 + Math.random() * 0.68;
  flyY = 0.12 + Math.random() * 0.58;
  const angle = Math.random() * Math.PI * 2;
  const speed = 0.055 + Math.random() * 0.045;
  flyVx = Math.cos(angle) * speed;
  flyVy = Math.sin(angle) * speed;
  nextFlyDrift = 0;
}

function setGameEnabled(enabled) {
  gameEnabled = enabled;
  game.hidden = !enabled;
  game.setAttribute('aria-hidden', String(!enabled));
  gameToggle.setAttribute('aria-pressed', String(enabled));
  joystickX = 0;
  joystickY = 0;
  stick.style.transform = '';
  if (enabled) {
    swatterX = 0.5;
    swatterY = 0.5;
    resetFlyMotion();
  }
}

gameToggle.addEventListener('click', () => setGameEnabled(!gameEnabled));

function updateJoystick(event) {
  event.preventDefault();
  const rect = joystick.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = event.clientX - cx;
  const dy = event.clientY - cy;
  const radius = rect.width * 0.34;
  const distance = Math.hypot(dx, dy) || 1;
  const scale = Math.min(1, radius / distance);
  const x = dx * scale;
  const y = dy * scale;
  joystickX = x / radius;
  joystickY = y / radius;
  stick.style.transform = `translate(${x}px, ${y}px)`;
}

joystick.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  joystickPointer = event.pointerId;
  joystick.setPointerCapture(event.pointerId);
  updateJoystick(event);
});
joystick.addEventListener('pointermove', (event) => {
  if (event.pointerId === joystickPointer) updateJoystick(event);
});

function releaseJoystick(event) {
  event.preventDefault();
  if (event.pointerId !== joystickPointer) return;
  joystickPointer = null;
  joystickX = 0;
  joystickY = 0;
  stick.style.transform = '';
}
joystick.addEventListener('pointerup', releaseJoystick);
joystick.addEventListener('pointercancel', releaseJoystick);

function performHit(event) {
  event?.preventDefault();
  if (!gameEnabled) return;

  const now = performance.now();
  if (now - lastHit < 180) return;
  lastHit = now;

  swatter.classList.remove('hitting');
  void swatter.offsetWidth;
  swatter.classList.add('hitting');
  setTimeout(() => swatter.classList.remove('hitting'), 110);

  const rect = stage.getBoundingClientRect();
  const dx = (swatterX - flyX) * rect.width;
  const dy = (swatterY - flyY) * rect.height;
  if (Math.hypot(dx, dy) <= 56) {
    resetBrain();
    resetFlyMotion();
  }
}

hitButton.addEventListener('pointerdown', performHit);

function animateGame(now) {
  if (!gameEnabled) {
    lastGameFrame = now;
    return;
  }

  const dt = Math.min(0.05, Math.max(0, (now - lastGameFrame) / 1000));
  lastGameFrame = now;
  const rect = stage.getBoundingClientRect();
  const speedX = rect.width > 0 ? 240 / rect.width : 0;
  const speedY = rect.height > 0 ? 240 / rect.height : 0;

  swatterX = Math.max(0.04, Math.min(0.96, swatterX + joystickX * speedX * dt));
  swatterY = Math.max(0.06, Math.min(0.90, swatterY + joystickY * speedY * dt));

  if (now >= nextFlyDrift) {
    flyVx += (Math.random() - 0.5) * 0.035;
    flyVy += (Math.random() - 0.5) * 0.035;
    const speed = Math.hypot(flyVx, flyVy) || 0.001;
    const target = Math.max(0.035, Math.min(0.115, speed));
    flyVx = (flyVx / speed) * target;
    flyVy = (flyVy / speed) * target;
    nextFlyDrift = now + 800 + Math.random() * 1200;
  }

  flyX += flyVx * dt;
  flyY += flyVy * dt;

  if (flyX < 0.07) { flyX = 0.07; flyVx = Math.abs(flyVx); }
  if (flyX > 0.93) { flyX = 0.93; flyVx = -Math.abs(flyVx); }
  if (flyY < 0.07) { flyY = 0.07; flyVy = Math.abs(flyVy); }
  if (flyY > 0.83) { flyY = 0.83; flyVy = -Math.abs(flyVy); }

  swatter.style.left = `${swatterX * 100}%`;
  swatter.style.top = `${swatterY * 100}%`;
  fly.style.left = `${flyX * 100}%`;
  fly.style.top = `${flyY * 100}%`;
}

let lastFrame = 0;
function animate(now) {
  if (now - lastFrame >= 32) {
    lastFrame = now;
    renderBrain(now);
    renderRoll(now);
  }
  animateGame(now);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function handleEvents(encodedEvents) {
  const now = performance.now();
  for (const raw of encodedEvents) {
    const value = raw >>> 0;
    const note = value & 0x7f;
    const kind = (value >>> 7) & 0x01;
    const node = (value >>> 8) & 0x03ff;
    const velocity = (value >>> 18) & 0x7f;
    const durationBucket = (value >>> 25) & 0x7f;
    const duration = Math.max(50, durationBucket * 50);
    const drum = kind === 0 && durationBucket <= 3;

    if (node < activeUntil.length) activeUntil[node] = now + 140;
    notes.push({ time: now, note, kind, velocity, duration, drum });
  }
}

async function initializeAudio() {
  if (audioReady || audioStarting) return;
  audioStarting = true;
  playButton.disabled = true;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = audioContext || new AudioContextClass({ latencyHint: 'interactive' });

    const unlock = audioContext.createBufferSource();
    unlock.buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    unlock.connect(audioContext.destination);
    unlock.start(0);

    await audioContext.resume();
    await audioContext.audioWorklet.addModule(WORKLET_URL);

    const [wasmBuffer, pianoBuffer, voiceBuffer, drumBuffer, graphBuffer] = await Promise.all([
      fetchArrayBuffer(WASM_URL),
      fetchArrayBuffer(PIANO_URL),
      fetchArrayBuffer(VOICE_URL),
      fetchArrayBuffer(DRUM_URL),
      flyDataPromise.then((buffer) => buffer.slice(0)),
    ]);

    audioNode = new AudioWorkletNode(audioContext, 'flymusic-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    audioNode.port.onmessage = (event) => {
      if (event.data?.type === 'events') {
        handleEvents(event.data.events);
      } else if (event.data?.type === 'ready') {
        audioReady = true;
        audioStarting = false;
        playButton.disabled = false;
        stopButton.disabled = false;
        setTempo(tempoBpm);
      } else if (event.data?.type === 'error') {
        console.error(event.data.message || 'FlyMusic audio engine failed.');
        audioStarting = false;
        playButton.disabled = false;
        startButton.disabled = false;
        startScreen.hidden = false;
      }
    };

    audioNode.connect(audioContext.destination);
    audioNode.port.postMessage({
      type: 'init',
      wasm: wasmBuffer,
      piano: pianoBuffer,
      voice: voiceBuffer,
      drums: drumBuffer,
      graph: graphBuffer,
      seed: randomSeed(),
      bpm: tempoBpm,
    }, [wasmBuffer, pianoBuffer, voiceBuffer, drumBuffer, graphBuffer]);
  } catch (error) {
    console.error(error);
    audioStarting = false;
    playButton.disabled = false;
    startButton.disabled = false;
    startScreen.hidden = false;
  }
}

startButton.addEventListener('click', () => {
  if (audioStarting || audioReady) return;
  startButton.disabled = true;
  startScreen.hidden = true;
  initializeAudio();
});

playButton.addEventListener('click', async () => {
  if (!audioContext || !audioReady) {
    await initializeAudio();
    return;
  }
  try {
    await audioContext.resume();
    playButton.disabled = false;
    stopButton.disabled = false;
  } catch (error) {
    console.error(error);
  }
});

stopButton.addEventListener('click', async () => {
  if (!audioContext) return;
  try {
    await audioContext.suspend();
    stopButton.disabled = true;
    playButton.disabled = false;
  } catch (error) {
    console.error(error);
  }
});
