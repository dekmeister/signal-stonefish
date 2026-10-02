# CLAUDE.md: Signal Stonefish

An educational single page showing what SNR, SINAD, THD and (S+N)/N mean on real
audio (voice, music, a 1 kHz tone or a user file). It has live playback, waveform
and FFT plots, and presets for radio receiver limits. The remote is
`git@github.com:dekmeister/signal-stonefish.git`.

## Layout
- `index.html` holds everything: HTML, CSS and JS inline. No libraries, no build step.
  - The DSP sits in the first half of the script (noise, distortion, band filters, FFT).
  - The UI wiring and `PRESETS` sit at the end.
- `audio/` holds the CC BY clips. `audio/SOURCES.md` has their attribution, and the page's
  "What do these mean?" popup credits them too. Keep those credits if the clips change.

## Design rules (from the user)
- Simple and plain. Light mode only. Avoid the "AI-generated" look (no card grids, pills or tinted tiles).
- Everything fits on one iPad-landscape screen (about 1024×690) without scrolling.
  Explanations go in the popup, not on the page.
- Keep page text minimal.
- **No hidden processing.** Anything that changes the sound or the numbers must be visible
  or explained in the UI. Don't add invisible machinery.
- Sliders: moving right means more noise or distortion.
- Values can be typed into the number boxes as well as set with the sliders.

## Testing
- Serve the folder with `python3 -m http.server <port>`. `file://` blocks loading the clips.
- Headless check: `chromium --headless=new --no-sandbox --virtual-time-budget=15000 --screenshot=… --window-size=1024,690`.
  - `decodeAudioData` hangs in headless Chromium, so test on a copy without `audio/`;
    the page then falls back to the tone.
  - Script tests by injecting a `<script>` into that copy and reading results with `--dump-dom`.
- Stop servers with a bracketed pattern, e.g. `pkill -f "m http.serve[r] 8000"`.
  Otherwise pkill matches its own shell and kills it.

## Open question
How distortion is controlled (as of 2026-10-02). It is currently a THD target, reached by a hidden
search on a −6 dBFS test tone. The proposed alternative is that the slider sets the physical
setting directly (clip level, drive or bits), and THD and SDR are shown as measurements.
The uncommitted μ-law option and its telephone preset change depend on this decision.
