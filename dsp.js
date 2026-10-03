"use strict";
// Signal Stonefish: the signal processing. Pure number-crunching on Float32Arrays, no DOM.
// Loaded before app.js. It reads the sample rate and caches from the shared state object `S`,
// which app.js defines; nothing here runs until app.js calls it.

// ---------- small helpers ----------
const dB = r => 10 * Math.log10(r);
function power(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return s / a.length; }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function peakOf(a) { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; }
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}


// ---------- noise generators (unit RMS, deterministic) ----------
function getNoise(type, n) {
  const key = type + ":" + n;
  if (S.noiseCache[key]) return S.noiseCache[key];
  const rnd = mulberry32(12345), a = new Float32Array(n);
  const gauss = () => {
    let u = 0; while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  if (type === "white") {
    for (let i = 0; i < n; i++) a[i] = gauss();
  } else if (type === "pink") { // Paul Kellet's refined pink filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = gauss();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      a[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    }
  } else { // mains hum: 50 Hz fundamental plus a buzzy set of harmonics
    const h = [[1, 1], [2, 0.5], [3, 0.6], [5, 0.3], [7, 0.15], [9, 0.08]];
    for (let i = 0; i < n; i++) {
      let v = 0; const t = i / S.sr;
      for (const [k, amp] of h) v += amp * Math.sin(2 * Math.PI * 50 * k * t + k);
      a[i] = v;
    }
  }
  const g = 1 / Math.sqrt(power(a));
  for (let i = 0; i < n; i++) a[i] *= g;
  S.noiseCache[key] = a;
  return a;
}

// noise passes through the receiver's audio filter too, so band-limit it the same way (unit RMS again after)
function getBandNoise(type, n, band) {
  if (!band) return getNoise(type, n);
  const key = type + ":" + n + ":" + band.join("-");
  if (!S.noiseCache[key]) {
    const a = bandLimit(getNoise(type, n), band), g = 1 / Math.sqrt(power(a) || 1);
    for (let i = 0; i < n; i++) a[i] *= g;
    S.noiseCache[key] = a;
  }
  return S.noiseCache[key];
}

// ---------- distortion: t in [0,1], 0 = gentle, 1 = harsh ----------
// The non-linearity is fixed in absolute terms, like a real receiver's. Its strength is set by
// the THD it gives on the standard 1 kHz test tone (A_REF, -6 dBFS), measured within the audio band.
const A_REF = 0.5;
const DIST = {
  soft: {
    k: t => Math.pow(10, -3 + 6 * t) / A_REF,
    apply(x, t, y) { const k = this.k(t); for (let i = 0; i < x.length; i++) y[i] = Math.tanh(k * x[i]); },
    describe(t) { return `tanh drive ×${(this.k(t) * A_REF).toPrecision(2)} at test-tone level`; },
  },
  hard: {
    c: t => A_REF * Math.pow(10, -3 * t),
    apply(x, t, y) { const c = this.c(t); for (let i = 0; i < x.length; i++) y[i] = x[i] > c ? c : x[i] < -c ? -c : x[i]; },
    describe(t, x) {
      const c = this.c(t); let k = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > c) k++;
      return `clips at ${(100 * c / A_REF).toPrecision(2)}% of test-tone peak · ${(100 * k / x.length).toFixed(1)}% of this clip's samples clipped`;
    },
  },
  asym: { // clips one polarity only, like an overdriven AM envelope detector: adds even harmonics too
    k: t => Math.pow(10, -3 + 6 * t) / A_REF,
    apply(x, t, y) { const k = this.k(t); for (let i = 0; i < x.length; i++) y[i] = x[i] > 0 ? Math.tanh(k * x[i]) / k : x[i]; },
    describe(t) { return `positive peaks compressed, drive ×${(this.k(t) * A_REF).toPrecision(2)} at test-tone level`; },
  },
  mulaw: { // G.711-style logarithmic (μ-law) quantiser: error scales with level, so quiet sounds survive
    bits: t => 16 - 14 * t,
    apply(x, t, y) {
      const q = Math.pow(2, 1 - this.bits(t)), MU = 255, L = Math.log1p(MU);
      for (let i = 0; i < x.length; i++) {
        const v = Math.max(-1, Math.min(1, x[i])), c = Math.sign(v) * Math.log1p(MU * Math.abs(v)) / L;
        const cq = Math.round(c / q) * q;
        y[i] = Math.sign(cq) * Math.expm1(Math.abs(cq) * L) / MU;
      }
    },
    describe(t) { return `≈ ${this.bits(t).toFixed(1)}-bit μ-law (G.711 is 8-bit)`; },
  },
  bits: {
    bits: t => 24 - 23 * t,
    apply(x, t, y) { const q = Math.pow(2, 1 - this.bits(t)); for (let i = 0; i < x.length; i++) y[i] = Math.round(x[i] / q) * q; },
    describe(t) { return `≈ ${this.bits(t).toFixed(1)}-bit quantiser`; },
  },
};
// residual power ratio D/S of y against reference x, after least-squares gain matching
function distRatio(x, y) {
  const g = dot(y, x) / dot(x, x);
  let pd = 0, ps = 0;
  for (let i = 0; i < x.length; i++) { const d = y[i] - g * x[i]; pd += d * d; ps += g * g * x[i] * x[i]; }
  return ps > 0 ? pd / ps : Infinity;
}
function testTone(band) { // 1 kHz at A_REF, and its band-limited version (the THD reference)
  if (!S.tt || S.tt.sr !== S.sr) {
    const n = Math.round(0.25 * S.sr), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = A_REF * Math.sin(2 * Math.PI * 1000 * i / S.sr);
    S.tt = { sr: S.sr, x, banded: {} };
  }
  if (!band) return { x: S.tt.x, ref: S.tt.x };
  const key = band.join("-");
  if (!S.tt.banded[key]) S.tt.banded[key] = bandLimit(S.tt.x, band);
  return { x: S.tt.x, ref: S.tt.banded[key] };
}
// THD in dBc of the test tone through non-linearity type at strength t, then the audio filter.
// Measured on the middle half, clear of the filter's start-up transients.
function toneThd(type, t, band) {
  const { x, ref } = testTone(band), y = new Float32Array(x.length);
  DIST[type].apply(x, t, y);
  const yb = band ? bandLimit(y, band) : y, a = x.length >> 2, b = 3 * a;
  return dB(distRatio(ref.subarray(a, b), yb.subarray(a, b)));
}
// Find the strength whose test-tone THD is closest to the target. A coarse scan finds the first
// crossing (quantisation THD moves in jumps, so it isn't monotonic), then bisection refines it.
function solveDist(type, targetDbc, band) {
  const N = 64, at = t => toneThd(type, t, band);
  let best = { t: 0, err: Infinity }, prev = 0, crossed = false;
  const consider = (t, v) => { const e = Math.abs(v - targetDbc); if (e < best.err) best = { t, err: e }; };
  for (let i = 0; i <= N; i++) {
    const t = i / N, v = at(t);
    consider(t, v);
    if (v >= targetDbc) {
      crossed = true;
      let lo = prev, hi = t;
      for (let it = 0; it < 24; it++) {
        const mid = (lo + hi) / 2, m = at(mid);
        consider(mid, m);
        if (m < targetDbc) lo = mid; else hi = mid;
      }
      break;
    }
    prev = t;
  }
  return { t: best.t, pinned: !crossed && best.err > 0.5 };
}
function gainMatch(z, x) { // scale z so its linear part equals x exactly
  const g = dot(z, x) / dot(x, x);
  if (g !== 0 && isFinite(g)) for (let i = 0; i < z.length; i++) z[i] /= g;
}

// ---------- bandwidth: zero-phase (forward-backward) RBJ biquads ----------
const BANDS = { fm: [30, 15000], am: [100, 5000], tel: [300, 3400] };
function biquad(x, type, f0, sr) {
  const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  let b0, b1, b2;
  if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  b0 /= a0; b1 /= a0; b2 /= a0; const A1 = a1 / a0, A2 = a2 / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - A1 * y1 - A2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
function filtfilt(x, type, f0, sr) {
  const y = biquad(x, type, f0, sr).reverse();
  return biquad(y, type, f0, sr).reverse();
}
function bandLimit(x, [lo, hi]) {
  let y = filtfilt(x, "hp", lo, S.sr);
  if (hi < S.sr * 0.45) y = filtfilt(y, "lp", hi, S.sr);
  return y;
}

// ---------- FFT ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, ang = -2 * Math.PI / len;
    for (let j = 0; j < half; j++) {
      const wr = Math.cos(ang * j), wi = Math.sin(ang * j);
      for (let i = j; i < n; i += len) {
        const k = i + half, vr = re[k] * wr - im[k] * wi, vi = re[k] * wi + im[k] * wr;
        re[k] = re[i] - vr; im[k] = im[i] - vi; re[i] += vr; im[i] += vi;
      }
    }
  }
}
const NFFT = 4096;
const HANN = (() => { const w = new Float64Array(NFFT); for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT); return w; })();
function welch(x) {
  const hop = NFFT / 2, frames = Math.max(1, Math.floor((x.length - NFFT) / hop) + 1);
  const step = Math.max(1, Math.ceil(frames / 60));
  const acc = new Float64Array(NFFT / 2 + 1), re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  let count = 0, wsum = 0;
  for (let i = 0; i < NFFT; i++) wsum += HANN[i];
  for (let f = 0; f < frames; f += step) {
    const o = f * hop;
    for (let i = 0; i < NFFT; i++) { re[i] = (x[o + i] || 0) * HANN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= NFFT / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  const ref = (wsum / 2) * (wsum / 2); // a full-scale sine peaks at 0 dBFS
  const out = new Float64Array(acc.length);
  for (let k = 0; k < acc.length; k++) out[k] = dB(acc[k] / count / ref + 1e-30);
  return out;
}
