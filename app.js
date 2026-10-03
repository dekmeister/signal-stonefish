"use strict";
// Signal Stonefish: state, loading, the processing chain, playback, plots and controls.
// Needs dsp.js loaded first (helpers, noise, distortion, band filters, FFT).

// ---------- small helpers ----------
const $ = id => document.getElementById(id);
const fmtDb = v => !isFinite(v) ? (v > 0 ? "∞" : "−∞") : v.toFixed(1) + " dB";
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- state ----------
const MAX_SECONDS = 20;
const S = {
  ac: null, sr: 48000,
  sources: {},          // name -> Float32Array (mono, normalised)
  srcName: null, x: null, peak: 1,
  noiseCache: {},
  res: null,            // { out, err, ... }
  buffers: {},
  play: { node: null, gain: null, startedAt: 0, pos: 0 },
  zoomLen: 0.02, zoomCenter: null,
  overviewCache: null,
};
function audioCtx() {
  if (!S.ac) { S.ac = new (window.AudioContext || window.webkitAudioContext)(); S.sr = S.ac.sampleRate; }
  return S.ac;
}

// ---------- source loading ----------
function toMono(buf) {
  const n = Math.min(buf.length, Math.round(MAX_SECONDS * buf.sampleRate));
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  // remove DC, normalise to -3 dBFS peak
  let mean = 0; for (let i = 0; i < n; i++) mean += out[i]; mean /= n || 1;
  for (let i = 0; i < n; i++) out[i] -= mean;
  const p = peakOf(out) || 1, g = Math.pow(10, -3 / 20) / p;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}
function makeTone() {
  const sr = S.sr, n = Math.round(5 * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / sr);
  return x;
}
async function fetchBundled(name) {
  for (const ext of ["wav", "mp3", "ogg", "flac", "m4a", "opus"]) {
    try {
      const r = await fetch(`audio/${name}.${ext}`);
      if (r.ok) return { data: await r.arrayBuffer(), file: `${name}.${ext}` };
    } catch (_) { /* file:// or network error: try the next */ }
  }
  return null;
}
async function decode(arrayBuf) {
  const buf = await audioCtx().decodeAudioData(arrayBuf);
  return toMono(buf);
}

// ---------- the processing chain ----------
// Everything is measured against the band-limited original, so bandwidth loss is not counted
// as distortion (frequency response is its own spec), and SNR/SINAD are in-band figures.
function processAudio() {
  const x = S.x; if (!x) return;
  const n = x.length;
  const st = {
    snrOn: $("snrOn").checked, snr: +$("snrNum").value, noise: noiseSeg.value,
    thdOn: $("thdOn").checked, thd: +$("thdNum").value, dist: distSeg.value, band: bandSeg.value,
  };
  const band = BANDS[st.band];
  // reference: the clean source through the audio filter
  const bKey = String(band);
  if (!S.xb || S.xb.x !== x || S.xb.key !== bKey) S.xb = { x, key: bKey, xb: band ? bandLimit(x, band) : x };
  const xb = S.xb.xb, P = power(xb);
  // 1–2. distortion then the audio filter; cached so noise-only changes are instant
  const zKey = [st.thdOn, st.thd, st.dist, bKey].join("|");
  if (!S.zc || S.zc.key !== zKey || S.zc.x !== x) {
    let z = x, distInfo = "", thdTone = -Infinity;
    if (st.thdOn) {
      const { t, pinned } = solveDist(st.dist, st.thd, band);
      z = new Float32Array(n);
      DIST[st.dist].apply(x, t, z);
      distInfo = (pinned ? "maximum this type can reach in this band · " : "") + DIST[st.dist].describe(t, x);
      thdTone = toneThd(st.dist, t, band);
    }
    z = band ? bandLimit(z, band) : Float32Array.from(z);
    gainMatch(z, xb);
    let Pd = 0; for (let i = 0; i < n; i++) { const d = z[i] - xb[i]; Pd += d * d; }
    S.zc = { key: zKey, x, z, distInfo, thdTone, Pd: Pd / n };
  }
  const { z, distInfo, thdTone, Pd } = S.zc;
  // 3. additive noise, band-limited by the same audio filter, scaled to the in-band SNR
  const out = new Float32Array(n);
  let Pn = 0;
  if (st.snrOn) {
    const base = getBandNoise(st.noise, n, band), k = Math.sqrt(P / Math.pow(10, st.snr / 10));
    for (let i = 0; i < n; i++) out[i] = z[i] + k * base[i];
    Pn = k * k;
  } else out.set(z);
  // SINAD: everything that isn't the (band-limited) original
  const g = dot(out, xb) / dot(xb, xb), err = new Float32Array(n);
  for (let i = 0; i < n; i++) err[i] = out[i] - g * xb[i];
  const Pe = power(err), Pout = power(out);
  S.res = {
    out, err, distInfo, st, thdTone,
    snr: Pn ? dB(P / Pn) : Infinity,
    sdr: Pd > 1e-12 * P ? dB(P / Pd) : Infinity,
    sinad: Pe > 1e-12 * P ? dB(Pout / Pe) : Infinity,
  };
  S.spec = null;
  buildBuffer();
  if (S.play.node) play(); // swap the new audio in straight away
  updateReadouts();
  cancelAnimationFrame(S.drawReq);
  S.drawReq = requestAnimationFrame(drawAll); // plots follow a frame later
}

// ---------- playback ----------
function buildBuffer() {
  const out = S.res.out;
  // steady level per source; only turned down if the output would clip
  const g = Math.min(0.6 / S.peak, 0.95 / (peakOf(out) || 1));
  const b = audioCtx().createBuffer(1, out.length, S.sr), d = b.getChannelData(0);
  for (let i = 0; i < out.length; i++) d[i] = out[i] * g;
  S.buffer = b;
}
const FADE = 0.03; // short crossfade avoids clicks when settings change mid-play
function playPos() {
  const p = S.play;
  if (!p.node) return p.pos;
  const dur = S.x.length / S.sr;
  return ((audioCtx().currentTime - p.startedAt) % dur + dur) % dur;
}
function fadeOut({ node, gain }) {
  const t = audioCtx().currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0, t + FADE);
  node.stop(t + FADE + 0.01);
}
// iOS/iPadOS treats Web Audio as "ambient" audio, which the hardware silent switch mutes.
// Ask for a "playback" session instead (Safari 16.4+), and on older iOS get the same
// effect by playing a silent <audio> clip, which is an inaudible side effect only.
function playbackSession() {
  try { navigator.audioSession.type = "playback"; } catch (_) {}
  if (S.silent === undefined) {
    try {
      const n = 800, b = new DataView(new ArrayBuffer(44 + n)), w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF"); b.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); b.setUint32(16, 16, true);
      b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 8000, true);
      b.setUint32(28, 8000, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true);
      w(36, "data"); b.setUint32(40, n, true);
      for (let i = 0; i < n; i++) b.setUint8(44 + i, 128); // 8-bit silence
      S.silent = new Audio(URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
      S.silent.loop = true;
    } catch (_) { S.silent = null; }
  }
  if (S.silent) S.silent.play().catch(() => {});
}
function play() {
  if (!S.buffer) return;
  playbackSession();
  const ac = audioCtx(); ac.resume();
  const pos = playPos(), t = ac.currentTime;
  if (S.play.node) fadeOut(S.play);
  const node = ac.createBufferSource(), gain = ac.createGain();
  node.buffer = S.buffer; node.loop = true;
  node.connect(gain).connect(ac.destination);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(1, t + FADE);
  node.start(t, pos);
  Object.assign(S.play, { node, gain, startedAt: t - pos });
  updateTransport();
  requestAnimationFrame(tick);
}
function pause() {
  if (S.play.node) { S.play.pos = playPos(); fadeOut(S.play); S.play.node = null; }
  if (S.silent) S.silent.pause();
  updateTransport(); drawOverview();
}
function stop() { pause(); S.play.pos = 0; drawOverview(); }
function updateTransport() {
  $("playBtn").classList.toggle("on", !!S.play.node);
  $("pauseBtn").classList.toggle("on", !S.play.node && S.play.pos > 0);
}
function tick() { if (S.play.node) { drawOverview(); requestAnimationFrame(tick); } }

// ---------- canvas plumbing ----------
function prep(canvas) {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w: r.width, h: r.height };
}
const colors = () => ({ orig: cssVar("--orig"), deg: cssVar("--deg"), err: cssVar("--err"),
  grid: cssVar("--grid"), muted: cssVar("--muted"), text: cssVar("--text"), accent: cssVar("--accent") });

// overview: min/max envelopes cached to an offscreen canvas, playhead drawn on top
function renderOverviewCache() {
  const cv = $("overview"), { w, h } = prep(cv), dpr = window.devicePixelRatio || 1;
  const off = document.createElement("canvas"); off.width = cv.width; off.height = cv.height;
  const c = off.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const col = colors(), x = S.x, y = S.res.out, n = x.length, cols = Math.floor(w), mid = h / 2;
  let scale = Math.max(peakOf(x), peakOf(y)) || 1; scale = (h / 2 - 2) / scale;
  const env = (a, color, alpha) => {
    c.fillStyle = color; c.globalAlpha = alpha; c.beginPath();
    const mins = [];
    for (let px = 0; px < cols; px++) {
      const i0 = Math.floor(px * n / cols), i1 = Math.max(i0 + 1, Math.floor((px + 1) * n / cols));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1; i++) { const v = a[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      c.lineTo(px, mid - mx * scale); mins.push(mn);
    }
    for (let px = cols - 1; px >= 0; px--) c.lineTo(px, mid - mins[px] * scale);
    c.closePath(); c.fill(); c.globalAlpha = 1;
  };
  env(y, col.deg, 0.75);
  env(x, col.orig, 0.9);
  S.overviewCache = off;
}
function drawOverview() {
  const cv = $("overview"); if (!S.res) return;
  const { c, w, h } = prep(cv);
  if (!S.overviewCache || S.overviewCache.width !== cv.width) renderOverviewCache();
  c.clearRect(0, 0, w, h);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(S.overviewCache, 0, 0); c.restore();
  const dur = S.x.length / S.sr, col = colors();
  // zoom window
  const z0 = zoomStart(), x0 = z0 / S.x.length * w, x1 = (z0 + zoomSamples()) / S.x.length * w;
  c.fillStyle = col.accent; c.globalAlpha = 0.18;
  c.fillRect(Math.min(x0, w - 3), 0, Math.max(3, x1 - x0), h); c.globalAlpha = 1;
  c.strokeStyle = col.accent; c.lineWidth = 1; c.strokeRect(Math.min(x0, w - 3) + 0.5, 0.5, Math.max(3, x1 - x0) - 1, h - 1);
  // playhead
  if (S.play.node || S.play.pos > 0) {
    const px = playPos() / dur * w;
    c.strokeStyle = col.text; c.lineWidth = 1.5; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.stroke();
  }
}

function zoomSamples() { return Math.min(S.x.length, Math.max(8, Math.round(S.zoomLen * S.sr))); }
function zoomStart() {
  const len = zoomSamples();
  return Math.max(0, Math.min(S.x.length - len, Math.round(S.zoomCenter - len / 2)));
}
function drawZoom() {
  const { c, w, h } = prep($("zoom")); c.clearRect(0, 0, w, h);
  if (!S.res) return;
  const col = colors(), i0 = zoomStart(), len = zoomSamples();
  const tr = [[S.x, col.orig, 3], [S.res.out, col.deg, 1.5], [S.res.err, col.err, 1.2]];
  let pk = 0;
  for (const [a] of tr) for (let i = i0; i < i0 + len; i++) pk = Math.max(pk, Math.abs(a[i]));
  pk = Math.max(pk, 1e-4) * 1.1;
  const mid = h / 2, sy = (h / 2) / pk;
  // grid
  c.strokeStyle = col.grid; c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid); c.stroke();
  for (let k = 1; k < 10; k++) { const gx = Math.round(k * w / 10) + 0.5; c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
  for (const [a, color, lw] of tr) {
    c.strokeStyle = color; c.lineWidth = lw; c.lineJoin = "round"; c.beginPath();
    for (let i = 0; i < len; i++) {
      const px = len > 1 ? i * w / (len - 1) : 0, py = mid - a[i0 + i] * sy;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.stroke();
  }
  const t0 = i0 / S.sr;
  $("zoomLabel").innerHTML = `<b>Zoom</b> · ${t0.toFixed(3)}–${((i0 + len) / S.sr).toFixed(3)} s`;
}

// ---------- spectrum plot ----------
const SPEC = { fmin: 20, dbMin: -150, dbMax: 0, pad: { l: 42, r: 10, t: 10, b: 24 } };
function drawSpectrum() {
  const { c, w, h } = prep($("spectrum")); c.clearRect(0, 0, w, h);
  if (!S.res) return;
  if (S.specOrigFor !== S.x) { S.specOrig = welch(S.x); S.specOrigFor = S.x; }
  if (!S.spec) S.spec = { orig: S.specOrig, deg: welch(S.res.out), err: welch(S.res.err) };
  const col = colors(), P = SPEC.pad, fmax = S.sr / 2;
  const pw = w - P.l - P.r, ph = h - P.t - P.b;
  const fx = f => P.l + Math.log(f / SPEC.fmin) / Math.log(fmax / SPEC.fmin) * pw;
  const dy = v => P.t + (SPEC.dbMax - Math.max(SPEC.dbMin, Math.min(SPEC.dbMax, v))) / (SPEC.dbMax - SPEC.dbMin) * ph;
  // grid
  c.font = "11px system-ui, sans-serif"; c.lineWidth = 1;
  for (let v = SPEC.dbMin; v <= SPEC.dbMax; v += 25) {
    const y = Math.round(dy(v)) + 0.5;
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(P.l, y); c.lineTo(w - P.r, y); c.stroke();
    c.fillStyle = col.muted; c.textAlign = "right"; c.fillText(v, P.l - 6, y + 4);
  }
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > fmax) continue;
    const x = Math.round(fx(f)) + 0.5;
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, h - P.b); c.stroke();
    c.fillStyle = col.muted; c.textAlign = "center"; c.fillText(f >= 1000 ? f / 1000 + "k" : f, x, h - 7);
  }
  c.save(); c.translate(11, P.t + ph / 2); c.rotate(-Math.PI / 2); c.textAlign = "center"; c.fillText("dBFS", 0, 0); c.restore();
  // traces: max of bins per pixel column so narrow peaks survive
  const binHz = S.sr / NFFT;
  const trace = (spec, color, lw) => {
    c.strokeStyle = color; c.lineWidth = lw; c.lineJoin = "round"; c.beginPath();
    let started = false;
    for (let px = 0; px <= pw; px++) {
      const fa = SPEC.fmin * Math.pow(fmax / SPEC.fmin, px / pw), fb = SPEC.fmin * Math.pow(fmax / SPEC.fmin, (px + 1) / pw);
      const ka = Math.max(1, Math.floor(fa / binHz)), kb = Math.min(spec.length - 1, Math.max(ka, Math.floor(fb / binHz)));
      let v = -Infinity; for (let k = ka; k <= kb; k++) if (spec[k] > v) v = spec[k];
      const y = dy(v);
      started ? c.lineTo(P.l + px, y) : (c.moveTo(P.l + px, y), started = true);
    }
    c.stroke();
  };
  c.save(); c.beginPath(); c.rect(P.l, P.t, pw, ph); c.clip();
  trace(S.spec.orig, col.orig, 2.5);
  trace(S.spec.deg, col.deg, 1.4);
  trace(S.spec.err, col.err, 1.1);
  if (S.specHover) {
    c.strokeStyle = col.muted; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(S.specHover.x + 0.5, P.t); c.lineTo(S.specHover.x + 0.5, h - P.b); c.stroke(); c.setLineDash([]);
  }
  c.restore();
}
function onSpecHover(e) {
  if (!S.spec) return;
  const r = $("spectrum").getBoundingClientRect(), x = e.clientX - r.left, P = SPEC.pad, pw = r.width - P.l - P.r;
  if (x < P.l || x > P.l + pw) { S.specHover = null; $("specReadout").textContent = ""; drawSpectrum(); return; }
  const f = SPEC.fmin * Math.pow((S.sr / 2) / SPEC.fmin, (x - P.l) / pw), k = Math.round(f / (S.sr / NFFT));
  S.specHover = { x };
  const v = a => a[k].toFixed(0);
  $("specReadout").textContent = `${f >= 1000 ? (f / 1000).toFixed(2) + " kHz" : f.toFixed(0) + " Hz"}  clean ${v(S.spec.orig)}  heard ${v(S.spec.deg)}  N+D ${v(S.spec.err)} dBFS`;
  drawSpectrum();
}

function drawAll() { S.overviewCache = null; drawOverview(); drawZoom(); drawSpectrum(); }

// ---------- controls ----------
function sel(id, onChange) {
  const el = $(id);
  el.addEventListener("change", () => onChange && onChange(el.value));
  return { get value() { return el.value; }, set(v) { el.value = v; } };
}
function seg(id, initial, onChange) {
  const root = $(id);
  const api = {
    value: initial,
    set(v, silent) {
      api.value = v;
      root.querySelectorAll("button[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
      if (!silent && onChange) onChange(v);
    },
  };
  root.addEventListener("click", e => {
    const b = e.target.closest("button[data-v]");
    if (b) api.set(b.dataset.v);
  });
  api.set(initial, true);
  return api;
}

function updateReadouts() {
  const r = S.res;
  $("tSnr").textContent = fmtDb(r.snr);
  $("tSnn").textContent = fmtDb(isFinite(r.snr) ? dB(1 + Math.pow(10, r.snr / 10)) : Infinity);
  $("tThd").textContent = isFinite(r.thdTone)
    ? `${r.thdTone.toFixed(1)} dBc · ${(100 * Math.pow(10, r.thdTone / 20)).toPrecision(2)}%` : "–";
  $("tSdr").textContent = fmtDb(r.sdr);
  $("tSinad").textContent = fmtDb(r.sinad);
  $("tNote").textContent = r.st.thdOn ? r.distInfo : "";
}

let pending = false;
function schedule() {
  updateLabels();
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; processAudio(); }, 15);
}
function updateLabels() {
  $("snrCtl").classList.toggle("off", !$("snrOn").checked);
  $("thdCtl").classList.toggle("off", !$("thdOn").checked);
}
function manual() { $("preset").value = ""; $("presetNote").textContent = ""; }

// picking a type also switches that control on
const noiseSeg = sel("noise", () => { $("snrOn").checked = true; manual(); schedule(); });
const distSeg = sel("dist", () => { $("thdOn").checked = true; manual(); schedule(); });
const bandSeg = sel("band", () => { manual(); schedule(); });
const zoomSeg = seg("zoomSeg", "0.02", v => { S.zoomLen = +v; drawOverview(); drawZoom(); });
// the number box holds the value; the slider follows it (and pins at its ends for typed values outside its range)
const LIMITS = { snr: [-60, 140], thd: [-140, 0] };
function setVal(id, v) { $(id + "Num").value = v; $(id).value = v; }
for (const id of ["snr", "thd"]) {
  const changed = () => { $(id + "On").checked = true; manual(); schedule(); };
  $(id).addEventListener("input", () => { $(id + "Num").value = $(id).value; changed(); });
  $(id + "Num").addEventListener("input", () => {
    const v = parseFloat($(id + "Num").value);
    if (!isFinite(v) || v < LIMITS[id][0] || v > LIMITS[id][1]) return; // wait until the typed value is sensible
    $(id).value = v; changed();
  });
  $(id + "Num").addEventListener("change", () => { // on enter/blur, tidy anything invalid back to a valid value
    const v = parseFloat($(id + "Num").value);
    $(id + "Num").value = isFinite(v) ? Math.min(LIMITS[id][1], Math.max(LIMITS[id][0], v)) : $(id).value;
    $(id).value = $(id + "Num").value; changed();
  });
}
for (const id of ["snrOn", "thdOn"]) $(id).addEventListener("change", () => { manual(); schedule(); });
$("playBtn").addEventListener("click", play);
$("pauseBtn").addEventListener("click", pause);
$("stopBtn").addEventListener("click", stop);
document.addEventListener("keydown", e => { // space toggles play/pause
  if (e.code !== "Space" || e.target.closest("input, select, textarea, dialog")) return;
  e.preventDefault();
  S.play.node ? pause() : play();
});
$("aboutBtn").addEventListener("click", () => $("about").showModal());
$("about").addEventListener("click", e => { if (e.target === $("about")) $("about").close(); }); // click backdrop to close

// band: "full" | a BANDS key | [lowHz, highHz]
const PRESETS = [
  { group: "Comparisons" },
  { id: "clean",   name: "Clean", snrOn: false, thdOn: false, band: "full" },
  { id: "noise20", name: "Noise only (SNR 20 dB)", snrOn: true, snr: 20, noise: "white", thdOn: false, band: "full" },
  { id: "dist20",  name: "Distortion only (10% THD)", snrOn: false, thdOn: true, thd: -20, dist: "hard", band: "full" },
  { id: "hum",     name: "Mains hum", snrOn: true, snr: 30, noise: "hum", thdOn: false, band: "full" },
  { id: "faint",   name: "Barely audible (−60 dB)", snrOn: true, snr: 60, noise: "white", thdOn: true, thd: -60, dist: "bits", band: "full" },
  // Radio limits. Threshold figures are the spec's own number (ETSI SINAD is psophometrically weighted; used as-is).
  // (S+N)/N figures are converted to SNR: 6 → 4.7, 10 → 9.5, 3 → 0 dB.
  { group: "Airband (VHF AM)" },
  { id: "air-thr", name: "Airborne Rx threshold", snrOn: true, snr: 4.7, noise: "white", thdOn: false, band: [350, 2500],
    note: "TSO-C169a / DO-186B sensitivity point: 6 dB (S+N)/N. Audio passband 350–2500 Hz." },
  { id: "air-dist", name: "Airborne Rx max distortion", snrOn: false, thdOn: true, thd: -18.4, dist: "asym", band: [350, 2500],
    note: "Worst audio distortion an airborne receiver may have: 12% THD (DO-186B era)." },
  { id: "air-gnd", name: "Ground Rx threshold", snrOn: true, snr: 11.7, noise: "white", thdOn: false, band: [300, 3400],
    note: "ETSI EN 300 676-1 ground radio sensitivity: 12 dB SINAD (25 kHz channel)." },
  { id: "air-icao", name: "ICAO coverage edge", snrOn: true, snr: 15, noise: "white", thdOn: false, band: [350, 2500],
    note: "ICAO Annex 10 planning ratio at the edge of a service volume: 15 dB." },
  { id: "air-good", name: "Strong signal", snrOn: true, snr: 40, noise: "white", thdOn: true, thd: -26, dist: "asym", band: [350, 2500],
    note: "Clean airband audio: 40 dB (S+N)/N noise floor with the 5% distortion limit (EN 300 676)." },
  { group: "Land mobile & marine (VHF/UHF FM)" },
  { id: "fm-12", name: "12 dB SINAD reference", snrOn: true, snr: 11.7, noise: "white", thdOn: false, band: [300, 3000],
    note: "TIA-603 reference sensitivity, the figure on every two-way radio spec sheet. Roughly DAQ 2: understandable with effort." },
  { id: "fm-14", name: "14 dB SINAD (interference tests)", snrOn: true, snr: 13.8, noise: "white", thdOn: false, band: [300, 3000],
    note: "The degraded level used for adjacent-channel, blocking and intermod tests (EN 300 086 / EN 301 025)." },
  { id: "fm-17", name: "17 dB SINAD (DAQ 3)", snrOn: true, snr: 16.9, noise: "white", thdOn: false, band: [300, 3000],
    note: "TSB-88 coverage design target: speech understandable with slight effort." },
  { id: "fm-20", name: "20 dB SINAD (ETSI / marine)", snrOn: true, snr: 20, noise: "white", thdOn: false, band: [300, 3000],
    note: "ETSI EN 300 086 and EN 301 025 (marine VHF) maximum usable sensitivity. About DAQ 3.4." },
  { id: "fm-25", name: "25 dB SINAD (DAQ 4)", snrOn: true, snr: 25, noise: "white", thdOn: false, band: [300, 3000],
    note: "Speech easily understood. Public-safety coverage target." },
  { id: "fm-good", name: "Strong signal", snrOn: true, snr: 40, noise: "white", thdOn: true, thd: -20, dist: "soft", band: [300, 3000],
    note: "TIA-603 strong-signal limits: hum and noise 40 dB down, distortion ≤ 10%." },
  { group: "Broadcast" },
  { id: "bc-fm-us", name: "FM usable sensitivity", snrOn: true, snr: 30, noise: "white", thdOn: false, band: [30, 15000],
    note: "IHF usable sensitivity for an FM tuner: 30 dB, where audio becomes listenable." },
  { id: "bc-fm-good", name: "FM good reception", snrOn: true, snr: 50, noise: "white", thdOn: true, thd: -34, dist: "soft", band: [30, 15000],
    note: "50 dB quieting with 2% distortion (DIN 45500): good hi-fi FM." },
  { id: "bc-am-thr", name: "AM (MW) sensitivity", snrOn: true, snr: 26, noise: "white", thdOn: false, band: [100, 2000],
    note: "ITU-R BS.703 reference receiver: 26 dB S/N, audio −3 dB at 2 kHz." },
  { id: "bc-am-good", name: "AM (MW) good signal", snrOn: true, snr: 40, noise: "white", thdOn: true, thd: -30.5, dist: "hard", band: [100, 4500],
    note: "Strong local MW station: 40 dB S/N, 3% distortion, 4.5 kHz audio (9 kHz channels)." },
  { group: "HF SSB" },
  { id: "hf-10", name: "SSB threshold", snrOn: true, snr: 9.5, noise: "white", thdOn: false, band: [300, 2700],
    note: "Standard SSB sensitivity point: 10 dB (S+N)/N, on amateur, aviation and marine spec sheets." },
  { id: "hf-mil", name: "Military HF threshold", snrOn: true, snr: 9.5, noise: "white", thdOn: true, thd: -25, dist: "soft", band: [300, 3050],
    note: "MIL-STD-188-141C: 10 dB SINAD at sensitivity, distortion at least 25 dB down." },
  { id: "hf-mds", name: "Ham MDS (barely there)", snrOn: true, snr: 0, noise: "white", thdOn: false, band: [300, 2700],
    note: "ARRL minimum discernible signal: 3 dB (S+N)/N, i.e. signal equal to noise." },
  { group: "Telephone" },
  { id: "tel-g712", name: "Telephone channel (G.712)", snrOn: true, snr: 46, noise: "white", thdOn: true, thd: -33, dist: "mulaw", band: [300, 3400],
    note: "ITU-T G.712: 300–3400 Hz, 33 dB signal-to-quantisation-distortion. Noise level is inferred." },
];
{
  const sel = $("preset");
  sel.add(new Option("—", ""));
  let parent = sel;
  for (const p of PRESETS) {
    if (p.group) { parent = document.createElement("optgroup"); parent.label = p.group; sel.append(parent); continue; }
    parent.append(new Option(p.name, p.id));
  }
}
$("preset").addEventListener("change", e => {
  const p = PRESETS.find(q => q.id === e.target.value); if (!p) return;
  $("snrOn").checked = p.snrOn; $("thdOn").checked = p.thdOn;
  if (p.snr != null) setVal("snr", p.snr);
  if (p.thd != null) setVal("thd", p.thd);
  if (p.noise) noiseSeg.set(p.noise);
  if (p.dist) distSeg.set(p.dist);
  if (Array.isArray(p.band)) {
    BANDS.custom = p.band;
    const opt = $("band").querySelector('option[value="custom"]');
    opt.textContent = `${p.band[0]}–${p.band[1]} Hz`; opt.hidden = false;
    bandSeg.set("custom");
  } else bandSeg.set(p.band);
  $("presetNote").textContent = p.note || "";
  schedule();
});

// overview: click / drag to move the zoom window
function overviewPick(e) {
  if (!S.x) return;
  const r = $("overview").getBoundingClientRect();
  S.zoomCenter = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.x.length;
  drawOverview(); drawZoom();
}
$("overview").addEventListener("pointerdown", e => { $("overview").setPointerCapture(e.pointerId); overviewPick(e); });
$("overview").addEventListener("pointermove", e => { if (e.buttons) overviewPick(e); });
$("spectrum").addEventListener("mousemove", onSpecHover);
$("spectrum").addEventListener("mouseleave", () => { S.specHover = null; $("specReadout").textContent = ""; drawSpectrum(); });
let rsz; window.addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(drawAll, 100); });

// ---------- sources ----------
function selectSource(name) {
  const x = S.sources[name]; if (!x) return;
  const wasPlaying = !!S.play.node;
  stop(); S.zc = null;
  S.srcName = name; S.x = x; S.peak = peakOf(x);
  // start the zoom on the loudest moment, where clipping is most visible
  let im = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[im])) im = i;
  S.zoomCenter = name === "tone" ? x.length / 2 : im;
  $("src").value = name;
  processAudio();
  if (wasPlaying) play();
}
$("src").addEventListener("change", e => selectSource(e.target.value));
$("fileBtn").addEventListener("click", () => $("fileIn").click());
$("fileIn").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  $("srcStatus").textContent = "Decoding…";
  try {
    S.sources.file = await decode(await f.arrayBuffer());
    const opt = $("src").querySelector('option[value="file"]');
    opt.hidden = false; opt.disabled = false; opt.textContent = f.name;
    $("srcStatus").textContent = "";
    selectSource("file");
  } catch (err) {
    $("srcStatus").textContent = `Couldn't decode ${f.name}.`;
  }
  e.target.value = "";
});

(async function init() {
  audioCtx();
  updateLabels();
  S.sources.tone = makeTone();
  for (const name of ["voice", "voice-woman", "voice-deep", "music"]) {
    const opt = $("src").querySelector(`option[value="${name}"]`);
    const got = await fetchBundled(name);
    if (got) { try { S.sources[name] = await decode(got.data); continue; } catch (_) {} }
    opt.disabled = true; opt.textContent += " (missing)";
  }
  if (location.protocol === "file:" && (!S.sources.voice || !S.sources.music))
    $("srcStatus").textContent = "Serve over HTTP to load the bundled clips.";
  selectSource(S.sources.voice ? "voice" : S.sources.music ? "music" : "tone");
})();
