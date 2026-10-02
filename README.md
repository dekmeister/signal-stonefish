# Signal Stonefish

Signal Stonefish is a single-page, JavaScript-only demo of what **SNR**
(signal-to-noise ratio) and **SINAD** (signal-to-noise-and-distortion)
actually sound and look like.

Pick a voice clip (three voices to choose from), a music clip, a 1 kHz test tone, or your own file. Add noise
(set as SNR) and distortion (set as THD on the standard 1 kHz test tone), then:

- **listen**: play/pause/stop, with the sound updating live as you change settings
- **see the waveform**: a whole-clip overview plus a zoomed view with original, degraded and added (noise + distortion) traces
- **see the spectrum**: a Welch-averaged FFT showing the noise floor and distortion harmonics
- **read the measured** SNR, (S+N)/N, THD (test tone), SDR (this clip) and SINAD

Noise types are white, pink and 50 Hz hum. Distortion types are soft clip,
hard clip, one-sided clip (AM detector) and bit-depth reduction. Audio
bandwidth can be limited to FM, AM, telephone or a preset's passband.

Presets cover common radio receiver limits: VHF AM airband (TSO-C169a /
DO-186B, EN 300 676, ICAO), land mobile and marine FM (TIA-603, EN 300 086,
EN 301 025, DAQ levels), FM/AM broadcast, HF SSB (including MIL-STD-188-141C)
and the ITU-T G.712 telephone channel.

## Files

| Path | What |
|---|---|
| `index.html` | The whole app: HTML, CSS and JS inline, no dependencies |
| `audio/voice.wav`, `audio/music.wav` | Bundled clips (CC BY; see `audio/SOURCES.md`) |
| `audio/SOURCES.md` | Where each clip came from, its licence and attribution |

The page looks for `audio/voice.{wav,mp3,ogg,flac,m4a,opus}` and the same
names for `music`. Clips are mixed to mono, trimmed to 20 s and normalised to
−3 dBFS peak.

## Running

Browsers block `fetch()` from `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly still works with the test tone and your own files.

## How the measurement works

1. **Everything is in-band.** The reference is the original passed through the
   same zero-phase audio filter, so a narrow bandwidth is not counted as
   distortion (frequency response is a separate spec), and noise is filtered too.
2. **Distortion is a fixed non-linearity**, as in a real receiver. Its strength
   is searched until a 1 kHz test tone at −6 dBFS shows the requested THD
   (in dBc), measured within the audio band. The same non-linearity is then
   applied unchanged to the clip. SDR (this clip) is what it actually does to
   the current sound.
3. **Noise is scaled** so that in-band `P(signal) / P(noise)` equals the SNR setting.
4. **SINAD** = `P(output) / P(output − g·reference)`, where `g` is the
   least-squares gain.

## Licence

Code: MIT (see `LICENSE`). Audio clips: CC BY, credited in `audio/SOURCES.md`
and in the page's "What do these mean?" popup.
