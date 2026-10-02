# SNR & SINAD by ear

A single-page, JavaScript-only demo of what **SNR** (signal-to-noise ratio) and
**SINAD** (signal-to-noise-and-distortion) actually sound and look like.

Pick a voice clip, a music clip, a 1 kHz test tone, or your own file. Then add
noise and/or distortion to a chosen level in dB and:

- **listen**: play/pause/stop, with the sound updating live as you change settings
- **see the waveform**: a whole-clip overview plus a zoomed view with original, degraded and added (noise + distortion) traces
- **see the spectrum**: a Welch-averaged FFT showing the noise floor and distortion harmonics
- **read the measured** SNR, (S+N)/N, SDR, THD % and SINAD, worked out from the processed audio

Extras: white, pink and 50 Hz hum noise; soft clip, hard clip and bit-depth
distortion; FM, AM and telephone bandwidth limits; and presets such as
"20 dB SINAD: all noise vs all distortion".

## Files

| Path | What |
|---|---|
| `index.html` | The whole app: HTML, CSS and JS inline, no dependencies |
| `audio/voice.*` | Default voice clip (you supply it; see below) |
| `audio/music.*` | Default music clip (you supply it; see below) |

The page looks for `audio/voice.{wav,mp3,ogg,flac,m4a,opus}` and the same
names for `music`. If a file is missing, its button is greyed out, and the test
tone and "Your file…" still work. Clips are mixed to mono, trimmed to 20 s and
normalised to −3 dBFS peak, so 10–20 s excerpts work best.

Places to find suitable clips:
- Speech: [LibriVox](https://librivox.org/) (public domain audiobooks)
- Music: [Free Music Archive](https://freemusicarchive.org/) or [Musopen](https://musopen.org/), filtered to CC0 or public domain

## Running

Browsers block `fetch()` from `file://`, so serve the folder over HTTP:

```bash
cd /mnt/server/Projects/2026/audio-comparision
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly still works with the test tone and your own files.

## How the measurement works

1. Distortion is a memoryless non-linearity. Its strength (drive, clip level
   or bit depth) is found by bisection so the measured SDR matches the slider.
2. The result is gain-matched back to the original, so the linear part is
   exactly the original signal.
3. A bandwidth limit, if selected, uses zero-phase biquads. The signal it
   removes counts as distortion.
4. Noise is scaled so `P(signal) / P(noise)` equals the SNR setting.
5. SINAD = `P(output) / P(output − g·original)`, where `g` is the
   least-squares gain.
