# FlyMusic

FlyMusic turns the publicly released FlyWire FAFB v783 fruit-fly connectome into an endless stream of sound in the browser. A lightweight recurrent activity model follows directed, weighted FlyWire connections in WebAssembly. Neural events are mapped directly to note onsets for two SoundFont voices: piano and choir. No scale, chord progression, melody, or beat grid is imposed.

## Data

FlyWire FAFB v783 (Female Adult Fly Brain), 139,255 proofread neurons.

- Codex: https://codex.flywire.ai/?dataset=fafb
- Public release information: https://home.flywire.ai/guidelines
- Raw build inputs: `coordinates.csv.gz` and `connections.csv.gz` from the FAFB v783 Codex data release.
- FlyWire public-release data license: CC BY-NC 4.0.
- Dorkenwald, S. et al. *Neuronal wiring diagram of an adult brain.* Nature 634, 124–138 (2024). https://doi.org/10.1038/s41586-024-07558-y
- Schlegel, P. et al. *Whole-brain annotation and multi-connectome cell typing of Drosophila.* Nature 634, 139–152 (2024). https://doi.org/10.1038/s41586-024-07686-5

The recurrent activity model is a generative model layered on measured anatomy. It is not a biological simulation of a living fly.

## Assets and licenses

- FlyMusic source code: MIT License.
- FlyWire-derived build data: CC BY-NC 4.0.
- RustySynth 1.3.6: MIT License — https://github.com/sinshu/rustysynth
- FreePats FM Synthesized Piano #2: CC0 1.0 — https://freepats.zenvoid.org/ElectricPiano/synthesized-piano.html
- FreePats Synth Pad Choir: CC0 1.0 — https://freepats.zenvoid.org/Synthesizer/synth-pad.html

## Copyright

Copyright © 2026 kurogedelic
