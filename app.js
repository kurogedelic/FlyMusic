const brainCanvas = document.querySelector('#brain');
const rollCanvas = document.querySelector('#roll');
const playButton = document.querySelector('#play');
const stopButton = document.querySelector('#stop');

const brainCtx = brainCanvas.getContext('2d');
const rollCtx = rollCanvas.getContext('2d');
const DATA_URL = new URL('./data/fly.bin', import.meta.url);
const WASM_URL = new URL('./engine.wasm', import.meta.url);
const PIANO_URL = new URL('./sf2/piano.sf2', import.meta.url);
const VOICE_URL = new URL('./sf2/voice.sf2', import.meta.url);
const WORKLET_URL = new URL('./audio-worklet.js', import.meta.url);

let flyBuffer = null;
let flyData = null;
let activeUntil = new Float64Array(0);
let notes = [];
let audioContext = null;
let audioNode = null;
let audioReady = false;
let audioStarting = false;

stopButton.disabled = true;

function fetchArrayBuffer(url) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return response.arrayBuffer();
  });
}

const flyDataPromise = fetchArrayBuffer(DATA_URL).then((buffer) => {
  flyBuffer = buffer;
  flyData = parseFlyData(buffer);
  activeUntil = new Float64Array(flyData.nodeCount);
  return buffer;
}).catch((error) => {
  console.error(error);
  throw error;
});

function parseFlyData(buffer) {
  const view = new DataView(buffer);
  let offset = 0;

  const magic = String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
  offset += 4;
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
  const hashes = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i += 1) {
    nodes[i * 2] = view.getInt16(offset, true); offset += 2;
    nodes[i * 2 + 1] = view.getInt16(offset, true); offset += 2;
    hashes[i] = view.getUint32(offset, true); offset += 4;
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
        const edgePos = edgesOffset + edge * 4;
        const dst = view.getUint16(edgePos, true);
        lines.push(src, dst);
        if (lines.length >= targetLines * 2) break outer;
      }
    }
  }

  return { viz, nodes, hashes, lines, nodeCount, edgeCount };
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
  const usableW = width - margin * 2;
  const usableH = height - margin * 2;
  const x = margin + ((x16 + 32767) / 65534) * usableW;
  const y = margin + ((y16 + 32767) / 65534) * usableH;
  return [x, y];
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
    const [x1, y1] = pointToCanvas(flyData.nodes[src * 2], flyData.nodes[src * 2 + 1], w, h);
    const [x2, y2] = pointToCanvas(flyData.nodes[dst * 2], flyData.nodes[dst * 2 + 1], w, h);
    brainCtx.moveTo(x1, y1);
    brainCtx.lineTo(x2, y2);
  }
  brainCtx.stroke();

  const dot = Math.max(1, Math.round(dpr));
  brainCtx.fillStyle = 'rgba(255,255,255,0.48)';
  for (let i = 0; i < flyData.viz.length; i += 2) {
    const [x, y] = pointToCanvas(flyData.viz[i], flyData.viz[i + 1], w, h);
    brainCtx.fillRect(Math.round(x), Math.round(y), dot, dot);
  }

  const nodeDot = Math.max(1, Math.round(dpr * 1.1));
  brainCtx.fillStyle = '#fff';
  for (let node = 0; node < flyData.nodeCount; node += 1) {
    if (activeUntil[node] <= now) continue;
    const [x, y] = pointToCanvas(flyData.nodes[node * 2], flyData.nodes[node * 2 + 1], w, h);
    brainCtx.fillRect(Math.round(x - nodeDot), Math.round(y - nodeDot), nodeDot * 2 + 1, nodeDot * 2 + 1);
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
    const width = Math.max(2, (event.duration / windowMs) * w);
    const y = ((maxNote - event.note) / range) * h;
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

let lastFrame = 0;
function animate(now) {
  if (now - lastFrame >= 32) {
    lastFrame = now;
    renderBrain(now);
    renderRoll(now);
  }
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

    if (node < activeUntil.length) activeUntil[node] = now + 140;
    notes.push({ time: now, note, kind, velocity, duration });
  }
}

async function initializeAudio() {
  if (audioReady || audioStarting) return;
  audioStarting = true;
  playButton.disabled = true;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: 'interactive' });
    const resumePromise = audioContext.resume();

    await Promise.all([
      resumePromise,
      audioContext.audioWorklet.addModule(WORKLET_URL),
    ]);

    const [wasmBuffer, pianoBuffer, voiceBuffer, graphBuffer] = await Promise.all([
      fetchArrayBuffer(WASM_URL),
      fetchArrayBuffer(PIANO_URL),
      fetchArrayBuffer(VOICE_URL),
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
      } else if (event.data?.type === 'error') {
        console.error(event.data.message || 'FlyMusic audio engine failed.');
        audioStarting = false;
        playButton.disabled = false;
      }
    };

    audioNode.connect(audioContext.destination);

    const seedArray = new Uint32Array(1);
    crypto.getRandomValues(seedArray);
    audioNode.port.postMessage({
      type: 'init',
      wasm: wasmBuffer,
      piano: pianoBuffer,
      voice: voiceBuffer,
      graph: graphBuffer,
      seed: seedArray[0],
    }, [wasmBuffer, pianoBuffer, voiceBuffer, graphBuffer]);
  } catch (error) {
    console.error(error);
    audioStarting = false;
    playButton.disabled = false;
  }
}

playButton.addEventListener('click', async () => {
  if (!audioContext) {
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
