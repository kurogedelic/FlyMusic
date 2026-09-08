class FlyMusicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasm = null;
    this.handle = 0;
    this.ready = false;
    this.bpm = 84;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'init') this.initialize(event.data);
      if (event.data?.type === 'tempo') this.setTempo(event.data.bpm);
      if (event.data?.type === 'reset') this.resetNeural(event.data.seed);
    };
  }

  setTempo(bpm) {
    const value = Math.max(40, Math.min(200, Math.round(Number(bpm) || 84)));
    this.bpm = value;
    if (this.ready && this.wasm?.fm_set_tempo && this.handle) {
      this.wasm.fm_set_tempo(this.handle, value);
    }
  }

  resetNeural(seed) {
    if (this.ready && this.wasm?.fm_reset_neural && this.handle) {
      this.wasm.fm_reset_neural(this.handle, Number(seed) >>> 0);
    }
  }

  async initialize(data) {
    try {
      const result = await WebAssembly.instantiate(data.wasm, {});
      this.wasm = result.instance.exports;

      if (
        !this.wasm.memory
        || !this.wasm.fm_alloc
        || !this.wasm.fm_create
        || !this.wasm.fm_set_tempo
        || !this.wasm.fm_reset_neural
      ) {
        throw new Error('FlyMusic WASM exports are incomplete.');
      }

      const piano = this.copyIntoWasm(data.piano);
      const voice = this.copyIntoWasm(data.voice);
      const graph = this.copyIntoWasm(data.graph);

      this.handle = this.wasm.fm_create(
        piano.ptr,
        piano.length,
        voice.ptr,
        voice.length,
        graph.ptr,
        graph.length,
        Math.round(sampleRate),
        data.seed >>> 0,
      );

      this.wasm.fm_free(piano.ptr, piano.length);
      this.wasm.fm_free(voice.ptr, voice.length);
      this.wasm.fm_free(graph.ptr, graph.length);

      if (!this.handle) throw new Error('FlyMusic engine initialization failed.');

      this.bpm = Math.max(40, Math.min(200, Math.round(Number(data.bpm) || this.bpm)));
      this.wasm.fm_set_tempo(this.handle, this.bpm);
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (error) {
      this.ready = false;
      this.port.postMessage({ type: 'error', message: String(error?.message || error) });
    }
  }

  copyIntoWasm(buffer) {
    const bytes = new Uint8Array(buffer);
    const ptr = this.wasm.fm_alloc(bytes.byteLength);
    if (!ptr) throw new Error('WASM allocation failed.');
    new Uint8Array(this.wasm.memory.buffer, ptr, bytes.byteLength).set(bytes);
    return { ptr, length: bytes.byteLength };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const left = output[0];
    const right = output[1];

    if (!this.ready || !this.wasm || !this.handle) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    try {
      const frames = left.length;
      const ptr = this.wasm.fm_render(this.handle, frames);
      if (!ptr) {
        left.fill(0);
        right.fill(0);
        return true;
      }

      const rendered = new Float32Array(this.wasm.memory.buffer, ptr, frames * 2);
      for (let i = 0; i < frames; i += 1) {
        left[i] = rendered[i * 2];
        right[i] = rendered[i * 2 + 1];
      }

      const count = Math.min(32, this.wasm.fm_event_count(this.handle) >>> 0);
      if (count > 0) {
        const events = new Array(count);
        for (let i = 0; i < count; i += 1) {
          events[i] = this.wasm.fm_event(this.handle, i) >>> 0;
        }
        this.port.postMessage({ type: 'events', events });
      }
    } catch (error) {
      left.fill(0);
      right.fill(0);
      this.ready = false;
      this.port.postMessage({ type: 'error', message: String(error?.message || error) });
    }

    return true;
  }
}

registerProcessor('flymusic-processor', FlyMusicProcessor);
