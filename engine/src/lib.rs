use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use std::io::Cursor;
use std::slice;
use std::sync::Arc;

const MAX_EVENT_NODES: usize = 1024;
const EVENT_LIMIT: usize = 32;

struct Graph {
    hashes: Vec<u32>,
    offsets: Vec<u32>,
    destinations: Vec<u16>,
    weights: Vec<i16>,
}

struct ActiveNote {
    kind: u8,
    note: i32,
    remaining_samples: usize,
}

struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u32) -> Self {
        let mut state = (seed as u64) ^ 0x9E37_79B9_7F4A_7C15;
        if state == 0 {
            state = 0xD1B5_4A32_D192_ED03;
        }
        Self { state }
    }

    fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        (x >> 16) as u32
    }

    fn next_f32(&mut self) -> f32 {
        ((self.next_u32() >> 8) as f32) / 16_777_216.0
    }
}

pub struct Engine {
    piano: Synthesizer,
    voice: Synthesizer,
    hashes: Vec<u32>,
    offsets: Vec<u32>,
    destinations: Vec<u16>,
    weights: Vec<i16>,
    potential: Vec<f32>,
    input: Vec<f32>,
    refractory: Vec<u8>,
    spikes: Vec<usize>,
    active_notes: Vec<ActiveNote>,
    events: Vec<u32>,
    rng: Rng,
    tick_counter: u64,
    tick_interval: usize,
    tick_accumulator: usize,
    sample_rate: usize,
    piano_left: Vec<f32>,
    piano_right: Vec<f32>,
    voice_left: Vec<f32>,
    voice_right: Vec<f32>,
    output: Vec<f32>,
}

impl Engine {
    fn new(
        piano_bytes: &[u8],
        voice_bytes: &[u8],
        graph_bytes: &[u8],
        sample_rate: usize,
        seed: u32,
    ) -> Option<Self> {
        let graph = parse_graph(graph_bytes)?;
        if graph.hashes.is_empty() || graph.hashes.len() > MAX_EVENT_NODES {
            return None;
        }

        let mut piano_cursor = Cursor::new(piano_bytes);
        let mut voice_cursor = Cursor::new(voice_bytes);
        let piano_font = Arc::new(SoundFont::new(&mut piano_cursor).ok()?);
        let voice_font = Arc::new(SoundFont::new(&mut voice_cursor).ok()?);
        let settings = SynthesizerSettings::new(sample_rate as i32);
        let mut piano = Synthesizer::new(&piano_font, &settings).ok()?;
        let mut voice = Synthesizer::new(&voice_font, &settings).ok()?;
        piano.set_master_volume(0.72);
        voice.set_master_volume(0.48);

        let node_count = graph.hashes.len();
        let mut rng = Rng::new(seed);
        let mut potential = vec![0.0; node_count];
        for value in &mut potential {
            *value = rng.next_f32() * 0.22;
        }

        Some(Self {
            piano,
            voice,
            hashes: graph.hashes,
            offsets: graph.offsets,
            destinations: graph.destinations,
            weights: graph.weights,
            potential,
            input: vec![0.0; node_count],
            refractory: vec![0; node_count],
            spikes: Vec::with_capacity(64),
            active_notes: Vec::with_capacity(64),
            events: Vec::with_capacity(EVENT_LIMIT),
            rng,
            tick_counter: 0,
            tick_interval: (sample_rate / 60).max(1),
            tick_accumulator: 0,
            sample_rate,
            piano_left: vec![0.0; 128],
            piano_right: vec![0.0; 128],
            voice_left: vec![0.0; 128],
            voice_right: vec![0.0; 128],
            output: vec![0.0; 256],
        })
    }

    fn tick(&mut self) {
        self.tick_counter = self.tick_counter.wrapping_add(1);
        let node_count = self.hashes.len();
        if node_count == 0 {
            return;
        }

        let drive_count = 1 + usize::from((self.rng.next_u32() & 3) == 0);
        for _ in 0..drive_count {
            let index = (self.rng.next_u32() as usize) % node_count;
            self.potential[index] += 0.72 + self.rng.next_f32() * 0.62;
        }

        self.spikes.clear();
        for i in 0..node_count {
            let noise = (self.rng.next_f32() - 0.5) * 0.018;
            let mut value = self.potential[i] * 0.91 + self.input[i] + noise;
            self.input[i] = 0.0;

            if self.refractory[i] > 0 {
                self.refractory[i] -= 1;
                value *= 0.55;
            } else if value > 1.0 {
                self.spikes.push(i);
                value = 0.0;
                self.refractory[i] = 2;
            }

            self.potential[i] = value.clamp(-1.5, 1.6);
        }

        for spike_index in 0..self.spikes.len() {
            let src = self.spikes[spike_index];
            let start = self.offsets[src] as usize;
            let end = self.offsets[src + 1] as usize;
            for edge in start..end {
                let dst = self.destinations[edge] as usize;
                if dst >= node_count {
                    continue;
                }
                let weight = self.weights[edge] as f32 / 32768.0;
                self.input[dst] = (self.input[dst] + weight).clamp(-1.25, 1.25);
            }
        }

        self.emit_music_events();
    }

    fn emit_music_events(&mut self) {
        let spike_count = self.spikes.len();
        if spike_count == 0 {
            return;
        }

        let density = spike_count.min(16) as f32;
        let piano_chance = (0.05 + density * 0.012).min(0.24);
        if self.rng.next_f32() < piano_chance {
            let mut note_count = 1usize;
            if spike_count >= 3 && self.rng.next_f32() < 0.28 {
                note_count += 1;
            }
            if spike_count >= 7 && self.rng.next_f32() < 0.12 {
                note_count += 1;
            }

            for _ in 0..note_count.min(4) {
                if self.events.len() >= EVENT_LIMIT {
                    break;
                }
                let node = self.spikes[(self.rng.next_u32() as usize) % spike_count];
                let mixed = self.hashes[node]
                    ^ self.rng.next_u32().rotate_left((node as u32) & 31)
                    ^ (self.tick_counter as u32).rotate_left(11);
                let note = 36 + (mixed % 49) as i32;
                let velocity = 45 + (self.rng.next_u32() % 72) as i32;
                let duration_ms = 160 + (self.rng.next_u32() % 1200) as usize;
                self.trigger_note(0, node, note, velocity, duration_ms);
            }
        }

        let voice_chance = (0.004 + density * 0.0018).min(0.035);
        if self.rng.next_f32() < voice_chance && self.events.len() < EVENT_LIMIT {
            let node = self.spikes[(self.rng.next_u32() as usize) % spike_count];
            let mixed = self.hashes[node]
                .wrapping_add(self.rng.next_u32())
                ^ (self.tick_counter as u32).rotate_right(7);
            let note = 43 + (mixed % 37) as i32;
            let velocity = 42 + (self.rng.next_u32() % 64) as i32;
            let duration_ms = 700 + (self.rng.next_u32() % 3000) as usize;
            self.trigger_note(1, node, note, velocity, duration_ms);
        }
    }

    fn trigger_note(&mut self, kind: u8, node: usize, note: i32, velocity: i32, duration_ms: usize) {
        if self.active_notes.len() >= 64 {
            return;
        }

        if kind == 0 {
            self.piano.note_on(0, note, velocity);
        } else {
            self.voice.note_on(0, note, velocity);
        }

        let remaining_samples = (duration_ms * self.sample_rate / 1000).max(1);
        self.active_notes.push(ActiveNote {
            kind,
            note,
            remaining_samples,
        });

        let duration_bucket = ((duration_ms + 49) / 50).clamp(1, 127) as u32;
        let packed = ((note as u32) & 0x7f)
            | (((kind as u32) & 0x01) << 7)
            | (((node as u32) & 0x03ff) << 8)
            | (((velocity as u32) & 0x7f) << 18)
            | ((duration_bucket & 0x7f) << 25);
        self.events.push(packed);
    }

    fn advance_note_offs(&mut self, frames: usize) {
        let mut index = 0usize;
        while index < self.active_notes.len() {
            if self.active_notes[index].remaining_samples <= frames {
                let ended = self.active_notes.swap_remove(index);
                if ended.kind == 0 {
                    self.piano.note_off(0, ended.note);
                } else {
                    self.voice.note_off(0, ended.note);
                }
            } else {
                self.active_notes[index].remaining_samples -= frames;
                index += 1;
            }
        }
    }

    fn ensure_buffers(&mut self, frames: usize) {
        if self.piano_left.len() < frames {
            self.piano_left.resize(frames, 0.0);
            self.piano_right.resize(frames, 0.0);
            self.voice_left.resize(frames, 0.0);
            self.voice_right.resize(frames, 0.0);
        }
        let stereo = frames * 2;
        if self.output.len() < stereo {
            self.output.resize(stereo, 0.0);
        }
    }

    fn render(&mut self, frames: usize) -> *const f32 {
        self.events.clear();
        self.tick_accumulator += frames;
        while self.tick_accumulator >= self.tick_interval {
            self.tick_accumulator -= self.tick_interval;
            self.tick();
        }

        self.advance_note_offs(frames);
        self.ensure_buffers(frames);

        self.piano.render(
            &mut self.piano_left[..frames],
            &mut self.piano_right[..frames],
        );
        self.voice.render(
            &mut self.voice_left[..frames],
            &mut self.voice_right[..frames],
        );

        for i in 0..frames {
            let left = self.piano_left[i] * 0.78 + self.voice_left[i] * 0.62;
            let right = self.piano_right[i] * 0.78 + self.voice_right[i] * 0.62;
            self.output[i * 2] = soft_clip(left);
            self.output[i * 2 + 1] = soft_clip(right);
        }

        self.output.as_ptr()
    }
}

fn soft_clip(value: f32) -> f32 {
    value / (1.0 + value.abs())
}

fn read_u16(data: &[u8], offset: &mut usize) -> Option<u16> {
    let bytes = data.get(*offset..*offset + 2)?;
    *offset += 2;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_i16(data: &[u8], offset: &mut usize) -> Option<i16> {
    let bytes = data.get(*offset..*offset + 2)?;
    *offset += 2;
    Some(i16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: &mut usize) -> Option<u32> {
    let bytes = data.get(*offset..*offset + 4)?;
    *offset += 4;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn parse_graph(data: &[u8]) -> Option<Graph> {
    if data.get(0..4)? != b"FLYM" {
        return None;
    }

    let mut offset = 4usize;
    let version = read_u16(data, &mut offset)?;
    let _flags = read_u16(data, &mut offset)?;
    if version != 1 {
        return None;
    }

    let viz_count = read_u32(data, &mut offset)? as usize;
    let node_count = read_u32(data, &mut offset)? as usize;
    let edge_count = read_u32(data, &mut offset)? as usize;
    if node_count == 0 || node_count > MAX_EVENT_NODES {
        return None;
    }

    offset = offset.checked_add(viz_count.checked_mul(4)?)?;
    if offset > data.len() {
        return None;
    }

    let mut hashes = Vec::with_capacity(node_count);
    for _ in 0..node_count {
        let _x = read_i16(data, &mut offset)?;
        let _y = read_i16(data, &mut offset)?;
        hashes.push(read_u32(data, &mut offset)?);
    }

    let mut offsets = Vec::with_capacity(node_count + 1);
    for _ in 0..=node_count {
        offsets.push(read_u32(data, &mut offset)?);
    }
    if offsets.last().copied()? as usize != edge_count {
        return None;
    }

    let mut destinations = Vec::with_capacity(edge_count);
    let mut weights = Vec::with_capacity(edge_count);
    for _ in 0..edge_count {
        let destination = read_u16(data, &mut offset)?;
        let weight = read_i16(data, &mut offset)?;
        if destination as usize >= node_count {
            return None;
        }
        destinations.push(destination);
        weights.push(weight);
    }

    Some(Graph {
        hashes,
        offsets,
        destinations,
        weights,
    })
}

#[no_mangle]
pub extern "C" fn fm_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let mut buffer = Vec::<u8>::with_capacity(size);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn fm_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    let _ = Vec::from_raw_parts(ptr, 0, size);
}

#[no_mangle]
pub unsafe extern "C" fn fm_create(
    piano_ptr: *const u8,
    piano_len: usize,
    voice_ptr: *const u8,
    voice_len: usize,
    graph_ptr: *const u8,
    graph_len: usize,
    sample_rate: u32,
    seed: u32,
) -> *mut Engine {
    if piano_ptr.is_null()
        || voice_ptr.is_null()
        || graph_ptr.is_null()
        || piano_len == 0
        || voice_len == 0
        || graph_len == 0
        || sample_rate < 8_000
    {
        return std::ptr::null_mut();
    }

    let piano = slice::from_raw_parts(piano_ptr, piano_len);
    let voice = slice::from_raw_parts(voice_ptr, voice_len);
    let graph = slice::from_raw_parts(graph_ptr, graph_len);

    match Engine::new(piano, voice, graph, sample_rate as usize, seed) {
        Some(engine) => Box::into_raw(Box::new(engine)),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn fm_destroy(engine: *mut Engine) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}

#[no_mangle]
pub unsafe extern "C" fn fm_render(engine: *mut Engine, frames: usize) -> *const f32 {
    if engine.is_null() || frames == 0 || frames > 4096 {
        return std::ptr::null();
    }
    (*engine).render(frames)
}

#[no_mangle]
pub unsafe extern "C" fn fm_event_count(engine: *const Engine) -> usize {
    if engine.is_null() {
        return 0;
    }
    let engine = &*engine;
    engine.events.len()
}

#[no_mangle]
pub unsafe extern "C" fn fm_event(engine: *const Engine, index: usize) -> u32 {
    if engine.is_null() {
        return 0;
    }
    let engine = &*engine;
    engine.events.get(index).copied().unwrap_or(0)
}
