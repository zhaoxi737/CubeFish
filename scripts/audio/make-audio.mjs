#!/usr/bin/env node
/**
 * CubeFish / 方块鱼 宣传片音频生成器
 * ---------------------------------------------------------------------------
 * 纯 Node.js 标准库，不使用任何第三方包 / 素材 / ffmpeg。
 * 44.1 kHz / 16-bit / stereo PCM（手写 RIFF 头）。
 * 所有声音 = 方波 / 三角波 / 正弦 / 白噪声 + ADSR 包络 + 简单滤波。
 *
 * 确定性：不使用 Math.random()，噪声来自 mulberry32(固定种子) 的单条序列，
 *         同一份代码跑两次输出字节完全一致。
 *
 * 用法：
 *   node scripts/audio/make-audio.mjs
 *
 * 产物：
 *   video/public/audio/bgm.wav                     60.8s（1824 帧 @30fps）
 *   video/public/audio/sfx/{tick,thud,sparkle,whoosh,riser,stab,click,type,hit}.wav
 *
 * 时间轴：150 BPM → 1 拍 12 帧 = 0.4s，1 小节 48 帧 = 1.6s，38 小节 = 1824 帧。
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ===========================================================================
// 0. 全局常量 / 时间轴
// ===========================================================================
const SR = 44100;
const FPS = 30;
const BPM = 150;                       // ← 改速度只改这里，但要同步改时间轴（见 README）
const TOTAL_FRAMES = 1824;             // 60.8s @30fps，38 小节
const SPF = SR / FPS;                  // 每帧采样数 = 1470
const TOTAL_SAMPLES = Math.round(TOTAL_FRAMES * SPF);
const BEAT_FRAMES = Math.round((60 / BPM) * FPS); // 150 BPM → 12 帧
const BAR_FRAMES = BEAT_FRAMES * 4;               // → 48 帧
const TAU = Math.PI * 2;

// 段落边界（帧）
const S0 = 0;      // 钩子 0–144
const S1 = 144;    // 核心流程 144–480
const S2 = 480;    // 轻量化 480–576
const S3 = 576;    // 四个功能卡 576–960
const S4 = 960;    // AI 段 960–1536
const S5 = 1536;   // 结尾 1536–1824
const END = TOTAL_FRAMES;
const LAND_FRAME = 70;                 // 像素鱼拼合 → 上升音 + 落定
const STAB_FRAMES = [576, 672, 768, 864];
const DATA_FRAMES = [1080, 1200, 1320, 1440];
const FINAL_FRAME = 1776;              // 品牌重击

const FADE_IN_FRAMES = 6;
const FADE_OUT_FRAMES = 40;
const PEAK_TARGET = 0.949;             // bgm 峰值上限 ≤0.95（int16 舍入后仍 ≤0.95）
const SFX_PEAK_TARGET = 0.9;

const MTOF_A4 = 440;
const mtof = (midi) => MTOF_A4 * Math.pow(2, (midi - 69) / 12);
const SAMP = (frame) => Math.round(frame * SPF);   // 帧 → 采样点（整数）
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const inRange = (f, a, b) => f >= a && f < b;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const AUDIO_DIR = join(ROOT, 'video', 'public', 'audio');
const SFX_DIR = join(AUDIO_DIR, 'sfx');

// ===========================================================================
// 1. 基础工具：带种子伪随机 / 振荡器 / 包络 / 滤波器
// ===========================================================================
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xc0bef15);           // 固定种子
const noise = () => rng() * 2 - 1;

/** 带限方波/锯齿的去混叠残差（polyBLEP） */
function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** 占空比可调方波 */
function pulseWave(t, dt, duty) {
  const naive = t < duty ? 1 : -1;
  return naive + polyBlep(t, dt) - polyBlep((t + 1 - duty) % 1, dt);
}

function panGains(pan) {
  const p = clamp(pan, -1, 1);
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

function createBus(len) {
  return { len, L: new Float64Array(len), R: new Float64Array(len) };
}

/** 二阶 RBJ 滤波器（时间可重设，用于 whoosh / riser 的扫频） */
function makeBiquad(type, freq, q = 0.707) {
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const set = (f) => {
    const w0 = (TAU * Math.min(f, SR * 0.45)) / SR;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    if (type === 'bp') {
      b0 = alpha / a0; b1 = 0; b2 = -alpha / a0;
    } else if (type === 'hp') {
      b0 = (1 + cw) / 2 / a0; b1 = -(1 + cw) / a0; b2 = b0;
    } else {
      b0 = (1 - cw) / 2 / a0; b1 = (1 - cw) / a0; b2 = b0;
    }
    a1 = (-2 * cw) / a0;
    a2 = (1 - alpha) / a0;
  };
  set(freq);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    set,
    process(x) {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x;
      y2 = y1; y1 = y;
      return y;
    },
  };
}

/**
 * 通用单音渲染：振荡器 + 包络 + 可选滑音 / 颤音 / 低通 / 延迟发送。
 * 时间单位统一用“帧”，内部换算采样点，保证和画面 30fps 严格对齐。
 */
function addOsc(bus, o) {
  const start = SAMP(o.startFrame ?? 0);
  if (start < 0 || start >= bus.len) return;
  const durSamples = Math.max(1, Math.round((o.durFrames ?? 6) * SPF));
  const n = Math.min(durSamples, bus.len - start);

  const f0 = (o.freq ?? mtof(o.midi ?? 57)) * Math.pow(2, (o.detuneCents ?? 0) / 1200);
  const fEnd = o.freqEnd != null
    ? o.freqEnd * Math.pow(2, (o.detuneCents ?? 0) / 1200)
    : null;
  const glideStep = fEnd != null ? Math.pow(fEnd / f0, 1 / Math.max(1, n - 1)) : 1;

  const [gl, gr] = panGains(o.pan ?? 0);
  const gain = o.gain ?? 0.1;
  const attack = o.attack ?? 0.004;
  const tau = Math.max(1e-4, o.decayTau ?? 0.15);
  const sustain = o.sustain ?? 0;
  const release = o.release ?? 0.008;
  const duty = o.duty ?? 0.5;
  const kind = o.kind ?? 'square';
  const vib = o.vibrato ?? null;
  const cut = o.cutoff ?? 0;
  const cutA = cut > 0 ? 1 - Math.exp((-TAU * cut) / SR) : 1;

  const relS = Math.max(1, Math.round(release * SR));
  const attInc = attack > 0 ? 1 / (attack * SR) : 1;
  const decStep = Math.exp(-1 / (tau * SR));

  const L = bus.L, R = bus.R;
  const sendBus = o.send?.bus ?? null;
  const sendGain = o.send ? (o.send.gain ?? 0.5) : 0;
  const SL = sendBus ? sendBus.L : null;
  const SRr = sendBus ? sendBus.R : null;

  let phase = 0;
  let ampEnv = attack > 0 ? 0 : 1;
  let dec = 1;
  let lp = 0;
  let freq = f0;

  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let instFreq = freq;
    if (fEnd != null) freq *= glideStep;
    if (vib && t > (vib.delay ?? 0)) {
      instFreq *= Math.pow(2, ((vib.depth ?? 6) * Math.sin(TAU * (vib.rate ?? 5.2) * t)) / 1200);
    }
    const dt = Math.min(0.45, Math.max(1e-6, instFreq / SR));

    let v;
    if (kind === 'square') v = pulseWave(phase, dt, duty);
    else if (kind === 'triangle') v = 1 - 4 * Math.abs(phase - 0.5);
    else if (kind === 'saw') v = 2 * phase - 1 - polyBlep(phase, dt);
    else v = Math.sin(TAU * phase);

    phase += dt;
    if (phase >= 1) phase -= 1;

    if (ampEnv < 1) {
      ampEnv += attInc;
      if (ampEnv > 1) ampEnv = 1;
    }
    let env = ampEnv * (sustain + (1 - sustain) * dec);
    dec *= decStep;
    const tail = n - i;
    if (tail <= relS) env *= tail / relS;

    let s = v * env;
    if (cut > 0) {
      lp += cutA * (s - lp);
      s = lp;
    }
    const out = s * gain;
    const idx = start + i;
    L[idx] += out * gl;
    R[idx] += out * gr;
    if (sendBus) {
      const sg = out * sendGain;
      SL[idx] += sg * gl;
      SRr[idx] += sg * gr;
    }
  }
}

/** 双层轻微 detune（左右微偏）——方波主旋律的“两层” */
function addOscPair(bus, o) {
  const d = o.detune ?? 6;
  const sp = o.panSpread ?? 0.3;
  const basePan = o.pan ?? 0;
  addOsc(bus, { ...o, detuneCents: -d, pan: clamp(basePan - sp, -1, 1) });
  addOsc(bus, { ...o, detuneCents: d, pan: clamp(basePan + sp, -1, 1) });
}

// ===========================================================================
// 2. 编曲素材：和弦 / 低音型 / 旋律
// ===========================================================================
// A 小调：Am – F – C – G，每个和弦 2 小节（96 帧）
const CHORDS = [
  { name: 'Am', bass: 45, sub: 33, triad: [57, 60, 64], arp: [69, 72, 76, 81, 76, 72, 69, 72] },
  { name: 'F',  bass: 41, sub: 29, triad: [53, 57, 60], arp: [65, 69, 72, 77, 72, 69, 65, 69] },
  { name: 'C',  bass: 48, sub: 36, triad: [55, 60, 64], arp: [67, 72, 76, 79, 76, 72, 67, 72] },
  { name: 'G',  bass: 43, sub: 31, triad: [55, 59, 62], arp: [67, 71, 74, 79, 74, 71, 67, 71] },
];
const CHORD_FRAMES = BAR_FRAMES * 2; // 96 帧
const chordAt = (frame) => CHORDS[Math.floor(frame / CHORD_FRAMES) % 4];

const BASS_RIFF = {
  Am: [45, 45, 57, 45, 52, 45, 57, 52],
  F:  [41, 41, 53, 41, 48, 41, 53, 48],
  C:  [48, 48, 60, 48, 55, 48, 60, 55],
  G:  [43, 43, 55, 43, 50, 43, 55, 50],
};

// [小节, 拍, 时值(拍), MIDI, 力度]
const MELODY_S1 = [
  [3, 0, 0.5, 69, 1], [3, 0.5, 0.5, 72, 0.8], [3, 1, 1.5, 77, 0.9], [3, 2.5, 0.5, 76, 0.75], [3, 3, 0.5, 72, 0.8], [3, 3.5, 0.5, 69, 0.75],
  [4, 0, 0.5, 67, 0.9], [4, 0.5, 0.5, 72, 0.8], [4, 1, 1, 76, 0.9], [4, 2, 0.5, 74, 0.8], [4, 2.5, 0.5, 76, 0.85], [4, 3, 1, 79, 0.9],
  [5, 0, 0.5, 71, 0.9], [5, 0.5, 0.5, 74, 0.8], [5, 1, 1, 79, 0.9], [5, 2, 0.5, 74, 0.8], [5, 2.5, 0.5, 71, 0.8], [5, 3, 1, 74, 0.85],
  [6, 0, 0.5, 76, 0.9], [6, 0.5, 0.5, 72, 0.8], [6, 1, 1, 69, 0.9], [6, 2, 0.5, 72, 0.8], [6, 2.5, 0.5, 76, 0.85], [6, 3, 1, 81, 0.95],
  [7, 0, 0.5, 72, 0.9], [7, 0.5, 0.5, 77, 0.85], [7, 1, 1, 81, 0.95], [7, 2, 0.5, 79, 0.85], [7, 2.5, 0.5, 77, 0.8], [7, 3, 1, 76, 0.85],
  [8, 0, 0.5, 76, 0.9], [8, 0.5, 0.5, 79, 0.85], [8, 1, 1, 84, 0.95], [8, 2, 0.5, 83, 0.9], [8, 2.5, 0.5, 79, 0.85], [8, 3, 1, 76, 0.9],
  [9, 0, 0.5, 74, 0.9], [9, 0.5, 0.5, 79, 0.85], [9, 1, 1.5, 83, 0.95], [9, 2.5, 0.5, 79, 0.8], [9, 3, 1, 74, 0.85],
];

const MELODY_S3 = [
  [12, 0, 0.5, 72, 1], [12, 0.5, 0.5, 76, 0.85], [12, 1, 1, 79, 0.95], [12, 2, 0.5, 76, 0.85], [12, 2.5, 0.5, 79, 0.85], [12, 3, 1, 84, 0.95],
  [13, 0, 0.5, 83, 0.9], [13, 0.5, 0.5, 79, 0.85], [13, 1, 1, 76, 0.9], [13, 2, 0.5, 79, 0.85], [13, 2.5, 0.5, 76, 0.8], [13, 3, 1, 72, 0.9],
  [14, 0, 0.5, 74, 0.95], [14, 0.5, 0.5, 79, 0.85], [14, 1, 1, 83, 0.95], [14, 2, 0.5, 81, 0.85], [14, 2.5, 0.5, 79, 0.85], [14, 3, 1, 74, 0.9],
  [15, 0, 0.5, 79, 0.9], [15, 0.5, 0.5, 83, 0.9], [15, 1, 1, 86, 1], [15, 2, 0.5, 83, 0.9], [15, 2.5, 0.5, 81, 0.85], [15, 3, 1, 79, 0.9],
  [16, 0, 0.5, 76, 0.95], [16, 0.5, 0.5, 81, 0.9], [16, 1, 1, 84, 0.95], [16, 2, 0.5, 83, 0.85], [16, 2.5, 0.5, 81, 0.85], [16, 3, 1, 76, 0.9],
  [17, 0, 0.5, 81, 0.9], [17, 0.5, 0.5, 84, 0.9], [17, 1, 1, 88, 1], [17, 2, 0.5, 84, 0.9], [17, 2.5, 0.5, 81, 0.85], [17, 3, 1, 76, 0.9],
  [18, 0, 0.5, 77, 0.95], [18, 0.5, 0.5, 81, 0.9], [18, 1, 1, 84, 0.95], [18, 2, 0.5, 81, 0.85], [18, 2.5, 0.5, 77, 0.8], [18, 3, 1, 84, 0.9],
  [19, 0, 0.5, 81, 0.9], [19, 0.5, 0.5, 77, 0.8], [19, 1, 1, 84, 0.95], [19, 2, 0.5, 81, 0.85], [19, 2.5, 0.5, 79, 0.8], [19, 3, 0.5, 77, 0.75],
];

// S4 主旋律（中音区，故意稀疏，给高音层和“数据音型”让路）
const MELODY_S4 = [
  [20, 0, 1.5, 67, 0.8], [20, 2, 1.5, 76, 0.8],
  [21, 0, 1.5, 72, 0.8], [21, 2, 1.5, 67, 0.8],
  [22, 0, 1.5, 74, 0.8], [22, 2, 1.5, 71, 0.8],
  [23, 0, 1.5, 67, 0.8], [23, 2, 1.5, 74, 0.8],
  [24, 0, 1.5, 76, 0.8], [24, 2, 1.5, 72, 0.8],
  [25, 0, 1.5, 69, 0.8], [25, 2, 1.5, 76, 0.8],
  [26, 0, 1.5, 72, 0.8], [26, 2, 1.5, 69, 0.8],
  [27, 0, 1.5, 65, 0.8], [27, 2, 1.5, 72, 0.8],
  [28, 0, 1.5, 67, 0.8], [28, 2, 1.5, 76, 0.8],
  [29, 0, 1.5, 72, 0.8], [29, 2, 1.5, 67, 0.8],
  [30, 0, 1.5, 74, 0.8], [30, 2, 1.5, 71, 0.8],
  [31, 0, 1.5, 67, 0.8], [31, 2, 1.5, 74, 0.8],
];

// S4 高音层（“加一层更高的旋律”，长音 + 延迟回声）
const HIGH_S4 = [
  [20, 0, 2, 79], [20, 2, 2, 84],
  [21, 0, 2, 88], [21, 2, 2, 84],
  [22, 0, 2, 83], [22, 2, 2, 86],
  [23, 0, 2, 79], [23, 2, 2, 83],
  [24, 0, 2, 81], [24, 2, 2, 88],
  [25, 0, 2, 84], [25, 2, 2, 81],
  [26, 0, 2, 81], [26, 2, 2, 84],
  [27, 0, 2, 84], [27, 2, 2, 81],
  [28, 0, 2, 79], [28, 2, 2, 84],
  [29, 0, 2, 88], [29, 2, 2, 84],
  [30, 0, 2, 83], [30, 2, 2, 86],
  [31, 0, 2, 79], [31, 2, 2, 83],
];

// ===========================================================================
// 3. 混音总线
// ===========================================================================
const mix = createBus(TOTAL_SAMPLES);
const send = createBus(TOTAL_SAMPLES); // 延迟回声发送（主旋律 / 高音层 / stab / 数据音型）

// ===========================================================================
// 4. 乐器声部
// ===========================================================================

/** 方波主旋律：两层 detune，左右微偏；长音加颤音 */
function playLead([bar, beat, durBeats, midi, vel], gain = 0.062, octave = 0) {
  const startFrame = bar * BAR_FRAMES + beat * BEAT_FRAMES;
  if (startFrame >= END) return;
  const durFrames = Math.max(1.5, durBeats * BEAT_FRAMES - 0.6);
  const tau = clamp(0.1 + durBeats * 0.05, 0.1, 0.3);
  addOscPair(mix, {
    kind: 'square',
    duty: 0.25,
    startFrame,
    durFrames,
    midi: midi + octave * 12,
    gain: gain * vel,
    attack: 0.0035,
    decayTau: tau,
    sustain: 0,
    release: 0.012,
    vibrato: durBeats >= 1.5 ? { rate: 5.1, depth: 6, delay: 0.16 } : null,
    send: { bus: send, gain: 0.55 },
  });
}

/** 三角波贝斯（附极轻方波咬字层） */
function playBass(midi, frame, slotFrames) {
  addOsc(mix, {
    kind: 'triangle', startFrame: frame, durFrames: slotFrames - 0.6, midi,
    gain: 0.23, pan: 0, attack: 0.003, decayTau: 0.42, sustain: 0.55,
    release: 0.012, cutoff: 1500,
  });
  addOsc(mix, {
    kind: 'square', duty: 0.5, startFrame: frame, durFrames: 2.6, midi,
    gain: 0.032, pan: 0, attack: 0.002, decayTau: 0.05, sustain: 0,
    release: 0.008, cutoff: 900,
  });
}

/** 8-bit 琶音。cutoff 用来做 S2 的“变轻”和 S4 的“滤波器渐开”。 */
function playArp(frame, { gain, cutoff, duty, pan }) {
  const chord = chordAt(frame);
  const step = Math.round(frame / (BEAT_FRAMES / 2));
  const midi = chord.arp[((step % 8) + 8) % 8];
  addOsc(mix, {
    kind: 'square', duty, startFrame: frame, durFrames: 5.2, midi,
    gain, pan, attack: 0.002, decayTau: 0.09, sustain: 0, release: 0.01,
    cutoff, send: { bus: send, gain: 0.35 },
  });
}

/** 和弦 pad：三角波铺底，双 detune 铺宽 */
function renderPads() {
  for (let seg = 0; seg < END; seg += CHORD_FRAMES) {
    const allowed = seg < S2 || seg >= S3; // 480–576（轻量化）只留 arp + sub
    if (!allowed) continue;
    const chord = chordAt(seg);
    // 相邻和弦重叠一点释放尾巴；到留白/结尾处收干
    const contiguous = (seg + CHORD_FRAMES < S2) || (seg >= S3 && seg + CHORD_FRAMES < END);
    const durFrames = CHORD_FRAMES + (contiguous ? 9 : 0);
    const noteGain = seg < S1 ? 0.05 : seg >= S5 ? 0.085 : 0.032;
    for (let n = 0; n < 3; n++) {
      addOscPair(mix, {
        kind: 'triangle',
        startFrame: seg,
        durFrames,
        midi: chord.triad[n],
        gain: noteGain / 2,
        pan: [-0.42, 0, 0.42][n],
        detune: 4,
        panSpread: 0.12,
        attack: 0.16,
        decayTau: 1.4,
        sustain: 0.7,
        release: 0.3,
        cutoff: 2400,
      });
    }
    addOsc(mix, {
      kind: 'sine', startFrame: seg, durFrames, midi: chord.triad[0] + 12,
      gain: 0.012, pan: 0, attack: 0.35, decayTau: 2, sustain: 0.6, release: 0.35,
    });
  }
}

/** 正弦 sub：144–1536 每段和弦一根低音；轻量化段更明显 */
function renderSubs() {
  for (let seg = 0; seg < END; seg += CHORD_FRAMES) {
    const start = Math.max(seg, S1);
    const end = Math.min(seg + CHORD_FRAMES, S5);
    if (end - start < 6) continue;
    const chord = chordAt(start);
    const inLight = start >= S2 && start < S3;
    addOsc(mix, {
      kind: 'sine',
      startFrame: start,
      durFrames: end - start,
      midi: chord.sub,
      gain: inLight ? 0.2 : 0.15,
      pan: 0,
      attack: start === seg ? 0.06 : 0.02,
      decayTau: 3,
      sustain: 0.92,
      release: 0.16,
    });
  }
}

/** 三角波贝斯：144–480、576–1536 的八分音符 riff */
function renderBass() {
  for (let bar = 0; bar < TOTAL_FRAMES / BAR_FRAMES; bar++) {
    const barFrame = bar * BAR_FRAMES;
    const on = inRange(barFrame, S1, S2) || inRange(barFrame, S3, S5);
    if (!on) continue;
    const riff = BASS_RIFF[chordAt(barFrame).name];
    for (let slot = 0; slot < 8; slot++) {
      if (riff[slot] == null) continue;
      playBass(riff[slot], barFrame + slot * (BEAT_FRAMES / 2), BEAT_FRAMES / 2);
    }
  }
}

// ---------------------------------------------------------------------------
// 鼓组（白噪声 + 正弦，全部合成）
// ---------------------------------------------------------------------------
function addKick(frame, gain = 0.45) {
  const start = SAMP(frame);
  const dur = Math.round(0.3 * SR);
  const n = Math.min(dur, mix.len - start);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 46 + 108 * Math.exp(-t / 0.028);
    phase += f / SR;
    const env = Math.min(1, t / 0.0015) * Math.exp(-t / 0.075);
    let v = Math.sin(TAU * phase) * env;
    if (i < 240) v += noise() * 0.3 * (1 - i / 240);
    mix.L[start + i] += v * gain;
    mix.R[start + i] += v * gain;
  }
}

function addSnare(frame, gain = 0.24) {
  const start = SAMP(frame);
  const dur = Math.round(0.22 * SR);
  const n = Math.min(dur, mix.len - start);
  const bpL = makeBiquad('bp', 1900, 0.9);
  const bpR = makeBiquad('bp', 2100, 0.9); // 左右独立噪声 → 自然的军鼓宽度
  let body = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t / 0.055) * Math.min(1, t / 0.001);
    body += 185 / SR;
    const tone = Math.sin(TAU * body) * Math.exp(-t / 0.04) * 0.55;
    const vL = (bpL.process(noise()) * env + tone) * gain;
    const vR = (bpR.process(noise()) * env + tone) * gain;
    mix.L[start + i] += vL;
    mix.R[start + i] += vR;
  }
}

function addHat(frame, gain = 0.05, open = false, pan = 0.12) {
  const start = SAMP(frame);
  const dur = Math.round((open ? 0.2 : 0.06) * SR);
  const n = Math.min(dur, mix.len - start);
  const hp = makeBiquad('hp', 7200, 0.707);
  const tau = open ? 0.05 : 0.012;
  const [gl, gr] = panGains(pan);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = hp.process(noise()) * Math.exp(-t / tau) * Math.min(1, t / 0.0008) * gain;
    mix.L[start + i] += v * gl;
    mix.R[start + i] += v * gr;
  }
}

function addCrash(frame, gain = 0.1) {
  const start = SAMP(frame);
  const dur = Math.round(0.9 * SR);
  const n = Math.min(dur, mix.len - start);
  const hp = makeBiquad('hp', 4200, 0.707);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const v = hp.process(noise()) * Math.exp(-t / 0.3) * Math.min(1, t / 0.002) * gain;
    mix.L[start + i] += v;
    mix.R[start + i] += v;
  }
}

/** 144（drop）/ 576（功能卡段）/ 960（AI 段）用鼓与重音铺出段落感 */
function renderDrums() {
  for (let bar = 0; bar < TOTAL_FRAMES / BAR_FRAMES; bar++) {
    const barFrame = bar * BAR_FRAMES;
    const on = inRange(barFrame, S1, S2) || inRange(barFrame, S3, S5);
    if (!on) continue;
    if (barFrame === S1 || barFrame === S3 || barFrame === S4) {
      addCrash(barFrame, barFrame === S1 ? 0.13 : 0.09);
    }
    for (let beat = 0; beat < 4; beat++) {
      addKick(barFrame + beat * BEAT_FRAMES, beat === 0 ? 0.5 : 0.42);
      if (beat === 1 || beat === 3) addSnare(barFrame + beat * BEAT_FRAMES, 0.25);
    }
    if (bar % 2 === 1) addKick(barFrame + BEAT_FRAMES * 3.5, 0.24); // 每两小节一个切分 ghost kick
    for (let eighth = 0; eighth < 8; eighth++) {
      const f = barFrame + eighth * (BEAT_FRAMES / 2);
      const pan = eighth % 2 === 0 ? -0.3 : 0.3;
      addHat(f, eighth % 2 === 0 ? 0.055 : 0.038, false, pan);
      if (eighth === 7 && bar % 2 === 1) addHat(f, 0.04, true, 0.15);
    }
  }
}

// ---------------------------------------------------------------------------
// 卡点 / 特殊事件
// ---------------------------------------------------------------------------

/** 功能卡卡点：576 / 672 / 768 / 864 各一次和弦重击 */
function renderStabs() {
  for (const f of STAB_FRAMES) {
    const chord = chordAt(f);
    const tones = [chord.triad[0], chord.triad[1], chord.triad[2], chord.triad[0] + 12];
    tones.forEach((midi, i) => {
      addOscPair(mix, {
        kind: 'square', duty: 0.25, startFrame: f, durFrames: 22, midi,
        gain: 0.055, pan: [-0.3, 0.05, 0.3, 0][i],
        detune: 5, panSpread: 0.12,
        attack: 0.002, decayTau: 0.1, sustain: 0, release: 0.01,
        send: { bus: send, gain: 0.6 },
      });
    });
    addKick(f, 0.5);
    addOsc(mix, {
      kind: 'sine', startFrame: f, durFrames: 20, midi: chord.sub,
      gain: 0.24, attack: 0.002, decayTau: 0.12, release: 0.01,
    });
  }
}

/** 通用上升音（锯齿扫频 + 带通噪声），给 70 帧落定与 1776 重击做铺垫 */
function addRiser(startFrame, endFrame, f0, f1, gain) {
  const start = SAMP(startFrame);
  const n = Math.min(SAMP(endFrame) - start, mix.len - start);
  if (n <= 0) return;
  const bp = makeBiquad('bp', 700, 0.8);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const f = f0 * Math.pow(f1 / f0, p);
    const dt = f / SR;
    const saw = 2 * phase - 1 - polyBlep(phase, dt);
    phase += dt;
    if (phase >= 1) phase -= 1;
    if (i % 64 === 0) bp.set(400 + 4200 * p);
    const nz = bp.process(noise()) * 0.6;
    const env = Math.pow(p, 1.8) * (i > n - 4 ? (n - i) / 4 : 1);
    const v = (saw * 0.7 + nz) * env * gain;
    mix.L[start + i] += v;
    mix.R[start + i] += v;
  }
}

/** 噪声 + 正弦渐强（转场/进副歌前的“吸气”） */
function addSwell(startFrame, endFrame, gain) {
  const start = SAMP(startFrame);
  const n = Math.min(SAMP(endFrame) - start, mix.len - start);
  if (n <= 0) return;
  const hp = makeBiquad('hp', 600, 0.707);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    if (i % 64 === 0) hp.set(300 + 5200 * p);
    const nz = hp.process(noise());
    const f = 220 * Math.pow(3.2, p);
    phase += f / SR;
    const env = Math.pow(p, 2) * (i > n - 3 ? (n - i) / 3 : 1);
    const v = (nz * 0.7 + Math.sin(TAU * phase) * 0.5) * env * gain;
    mix.L[start + i] += v;
    mix.R[start + i] += v;
  }
}

/** 第 70 帧：上升音 + 落定（像素鱼拼合；此段仍无鼓，只有低频落点） */
function renderLanding() {
  addRiser(LAND_FRAME - 18, LAND_FRAME, 180, 1800, 0.13);
  addOsc(mix, {
    kind: 'sine', freq: 140, freqEnd: 42, startFrame: LAND_FRAME, durFrames: 32,
    gain: 0.38, attack: 0.002, decayTau: 0.22, sustain: 0, release: 0.03,
  });
  const chord = chordAt(LAND_FRAME);
  [chord.triad[0], chord.triad[1], chord.triad[2], chord.triad[0] + 12].forEach((midi, i) => {
    addOsc(mix, {
      kind: 'square', duty: 0.125, startFrame: LAND_FRAME, durFrames: 26, midi,
      gain: 0.045, pan: [-0.25, 0, 0.25, 0][i],
      attack: 0.003, decayTau: 0.25, sustain: 0, release: 0.01,
      send: { bus: send, gain: 0.6 },
    });
  });
  [84, 88, 93].forEach((midi, i) => {
    addOsc(mix, {
      kind: 'sine', startFrame: LAND_FRAME + i, durFrames: 20, midi,
      gain: 0.04, pan: i - 1, attack: 0.002, decayTau: 0.12, release: 0.01,
    });
  });
}

/** 短促“数据/打字”音型：16 分音符脉冲 + 噪声小点，前置 4 音上扬 */
function renderDataBursts() {
  for (const f of DATA_FRAMES) {
    const chord = chordAt(f);
    const base = chord.triad[0] + 12;
    const third = chord.name === 'Am' ? 3 : 4;
    // 前置上扬（4 个 16 分，正好落在边界前 0.4s）
    const pickup = [0, third, 7, 12];
    for (let k = 0; k < 4; k++) {
      addOsc(mix, {
        kind: 'square', duty: 0.125, startFrame: f - 12 + k * 3, durFrames: 2.6,
        midi: base + pickup[k], gain: 0.05, pan: k % 2 === 0 ? -0.45 : 0.45,
        attack: 0.001, decayTau: 0.035, sustain: 0, release: 0.005,
        send: { bus: send, gain: 0.4 },
      });
    }
    // 主题：6 个 16 分音符
    [0, 7, 12, 7, 12, 19].forEach((s, k) => {
      const midi = base + s;
      const frame = f + k * 3;
      addOsc(mix, {
        kind: 'square', duty: 0.125, startFrame: frame, durFrames: 2.5,
        midi, gain: 0.085, pan: k % 2 === 0 ? -0.55 : 0.55,
        attack: 0.001, decayTau: 0.03, sustain: 0, release: 0.005,
        send: { bus: send, gain: 0.5 },
      });
      // 数据感噪声点
      const start = SAMP(frame);
      const bp = makeBiquad('bp', 5200, 1.2);
      const n = Math.min(Math.round(0.012 * SR), mix.len - start);
      const [gl, gr] = panGains(k % 2 === 0 ? -0.55 : 0.55);
      for (let i = 0; i < n; i++) {
        const v = bp.process(noise()) * Math.exp(-i / (0.003 * SR)) * 0.05;
        mix.L[start + i] += v * gl;
        mix.R[start + i] += v * gr;
      }
    });
  }
}

/** 结尾 1776 帧：品牌重击 + 余韵 */
function renderFinalHit() {
  const f = FINAL_FRAME;
  addSwell(f - 36, f, 0.09);
  addKick(f, 0.7);
  addOsc(mix, {
    kind: 'sine', freq: 92, freqEnd: 36, startFrame: f, durFrames: 42,
    gain: 0.55, attack: 0.002, decayTau: 0.3, release: 0.03,
  });
  [60, 64, 67, 72].forEach((midi, i) => {
    addOsc(mix, {
      kind: 'square', duty: 0.25, startFrame: f, durFrames: 40, midi,
      gain: 0.06, pan: [-0.3, 0, 0.3, 0][i],
      attack: 0.002, decayTau: 0.4, sustain: 0.05, release: 0.02,
      send: { bus: send, gain: 0.7 },
    });
  });
  [1760, 2637, 3520, 4699, 5873].forEach((freq, i) => {
    addOsc(mix, {
      kind: 'sine', freq, startFrame: f + i * 2, durFrames: 30,
      gain: 0.032, pan: i % 2 === 0 ? -0.55 : 0.55,
      attack: 0.002, decayTau: 0.18, release: 0.02,
      send: { bus: send, gain: 0.5 },
    });
  });
  addCrash(f, 0.5);
}

/** 结尾：鼓停，只剩和弦 + arp 渐慢（8 分 → 附点 8 分 → 4 分 → 2 分） */
function renderEndingArp() {
  let frame = S5;
  let k = 0;
  while (frame < FINAL_FRAME) {
    const p = (frame - S5) / (FINAL_FRAME - S5);
    const gap = 6 + 18 * Math.pow(p, 1.7);
    const chord = chordAt(frame);
    const step = Math.round(frame / (BEAT_FRAMES / 2));
    const midi = chord.arp[((step % 8) + 8) % 8];
    addOsc(mix, {
      kind: 'square', duty: 0.25, startFrame: frame,
      durFrames: Math.max(3.5, gap * 0.9), midi,
      gain: 0.115 - 0.05 * p, pan: k % 2 === 0 ? -0.28 : 0.28,
      attack: 0.002, decayTau: 0.12 + 0.1 * p, sustain: 0, release: 0.02,
      cutoff: 2800 - 1500 * p,
      send: { bus: send, gain: 0.45 },
    });
    frame += gap;
    k++;
  }
}

// ===========================================================================
// 5. 整曲渲染
// ===========================================================================
function renderBgm() {
  // --- S0 / S1 / S2 / S3 / S4：arp 主线 ---
  for (let frame = 0; frame < S5; frame += BEAT_FRAMES / 2) {
    let gain = 0.075;
    let cutoff = 0;
    let duty = 0.25;
    if (frame < S1) {
      gain = 0.118;                     // 钩子：arp 是主角
    } else if (frame < S2) {
      gain = 0.055;                     // 主歌：给主旋律让路
    } else if (frame < S3) {
      gain = 0.105; cutoff = 2600; duty = 0.125; // 轻量化：变薄、变亮
    } else if (frame < S4) {
      gain = 0.058;                     // 功能卡
    } else {
      gain = 0.055; cutoff = 1200 + 3000 * ((frame - S4) / (S5 - S4)); // AI：滤波器渐开
      duty = 0.125;
    }
    const step = Math.round(frame / (BEAT_FRAMES / 2));
    playArp(frame, { gain, cutoff, duty, pan: step % 2 === 0 ? -0.4 : 0.4 });
  }
  renderEndingArp();

  renderPads();
  renderSubs();
  renderBass();
  renderDrums();
  renderStabs();
  renderLanding();
  renderDataBursts();
  renderFinalHit();

  for (const note of MELODY_S1) playLead(note, 0.075);
  for (const note of MELODY_S3) playLead(note, 0.072);
  for (const note of MELODY_S4) playLead(note, 0.052);

  // 高音层
  for (const [bar, beat, durBeats, midi] of HIGH_S4) {
    const startFrame = bar * BAR_FRAMES + beat * BEAT_FRAMES;
    const durFrames = durBeats * BEAT_FRAMES;
    addOsc(mix, {
      kind: 'sine', startFrame, durFrames, midi, gain: 0.055, pan: -0.3,
      detuneCents: -3, attack: 0.1, decayTau: 1.0, sustain: 0.5, release: 0.22,
      send: { bus: send, gain: 0.8 },
    });
    addOsc(mix, {
      kind: 'triangle', startFrame, durFrames, midi, gain: 0.03, pan: 0.3,
      detuneCents: 3, attack: 0.1, decayTau: 1.0, sustain: 0.5, release: 0.22,
      send: { bus: send, gain: 0.8 },
    });
  }
}

// ===========================================================================
// 6. 母带处理 + WAV 写出
// ===========================================================================
/** 一阶高通，去直流（约 35Hz） */
function dcBlock(ch, len) {
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < len; i++) {
    const x = ch[i];
    y1 = x - x1 + 0.995 * y1;
    x1 = x;
    ch[i] = y1;
  }
}

/** 立体声 ping-pong 延迟（0.3s = 附点八分），带回授阻尼 */
function applyPingPong(bus, sendBus, { delaySec = 0.3, feedback = 0.32, wet = 0.55, damp = 3200 } = {}) {
  const d = Math.round(delaySec * SR);
  const len = bus.len;
  const echoL = new Float64Array(len);
  const echoR = new Float64Array(len);
  const a = 1 - Math.exp((-TAU * damp) / SR);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < len; i++) {
    const dL = i >= d ? echoL[i - d] : 0;
    const dR = i >= d ? echoR[i - d] : 0;
    lpL += a * (dR - lpL);
    lpR += a * (dL - lpR);
    echoL[i] = sendBus.L[i] + lpL * feedback;
    echoR[i] = sendBus.R[i] + lpR * feedback;
    bus.L[i] += lpL * wet;
    bus.R[i] += lpR * wet;
  }
}

/**
 * 母线软拐点压缩（立体声联动，peak 检测）。
 * 目的：把最后那记品牌重击和鼓组瞬态压住，让整曲 RMS 抬到正常宣传片水平，
 * 同时保留段落之间的强弱关系（轻量化段仍然明显留白）。
 */
function compressBus(bus, { thresholdDb = -12, ratio = 2.5, kneeDb = 6, attack = 0.004, release = 0.15 } = {}) {
  const L = bus.L;
  const R = bus.R;
  const len = bus.len;
  const aAtt = Math.exp(-1 / (attack * SR));
  const aRel = Math.exp(-1 / (release * SR));
  const halfKnee = kneeDb / 2;
  const slope = 1 - 1 / ratio;
  let env = 0;
  for (let i = 0; i < len; i++) {
    const x = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    const a = x > env ? aAtt : aRel;
    env = a * env + (1 - a) * x;
    const eDb = 20 * Math.log10(env + 1e-12);
    let gDb = 0;
    if (eDb > thresholdDb + halfKnee) {
      gDb = -(eDb - thresholdDb) * slope;
    } else if (eDb > thresholdDb - halfKnee) {
      const d = eDb - (thresholdDb - halfKnee);
      gDb = (-slope * d * d) / (2 * kneeDb);
    }
    const g = Math.pow(10, gDb / 20);
    L[i] *= g;
    R[i] *= g;
  }
}

/**
 * 软饱和（tanh）——8-bit 味道的“胶水”，同时把峰值圆一点。
 * 归一化仍放在最后一步，所以峰值一定 ≤ PEAK_TARGET。
 */
function softSaturate(bus, drive = 1.5) {
  const norm = Math.tanh(drive);
  const L = bus.L;
  const R = bus.R;
  for (let i = 0; i < bus.len; i++) {
    L[i] = Math.tanh(drive * L[i]) / norm;
    R[i] = Math.tanh(drive * R[i]) / norm;
  }
}

/** 轻微 M/S 展宽（侧信号 ×1.25）；主体仍是居中的鼓/贝斯，不影响单声道兼容 */
function widenStereo(bus, sideGain = 1.25) {
  const L = bus.L;
  const R = bus.R;
  for (let i = 0; i < bus.len; i++) {
    const m = (L[i] + R[i]) / 2;
    const s = ((L[i] - R[i]) / 2) * sideGain;
    L[i] = m + s;
    R[i] = m - s;
  }
}

function applyFades(bus) {
  const total = bus.len;
  const inN = Math.round(FADE_IN_FRAMES * SPF);
  const outN = Math.round(FADE_OUT_FRAMES * SPF);
  for (let i = 0; i < inN; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / inN);
    bus.L[i] *= g;
    bus.R[i] *= g;
  }
  for (let i = 0; i < outN; i++) {
    const idx = total - outN + i;
    const g = 0.5 + 0.5 * Math.cos((Math.PI * i) / outN);
    bus.L[idx] *= g;
    bus.R[idx] *= g;
  }
}

function peakOf(bus) {
  let p = 0;
  for (let i = 0; i < bus.len; i++) {
    const a = Math.abs(bus.L[i]);
    const b = Math.abs(bus.R[i]);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

function rmsOf(bus) {
  let sum = 0;
  for (let i = 0; i < bus.len; i++) sum += bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i];
  return Math.sqrt(sum / (bus.len * 2));
}

function normalize(bus, target) {
  const p = peakOf(bus);
  if (p <= 0) return 0;
  const s = target / p;
  for (let i = 0; i < bus.len; i++) {
    bus.L[i] *= s;
    bus.R[i] *= s;
  }
  return target;
}

/** 44 字节 RIFF 头 + 交错 int16 PCM */
function writeWav(path, bus, sampleRate = SR) {
  const frames = bus.len;
  const dataBytes = frames * 4;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);            // fmt chunk 大小
  buf.writeUInt16LE(1, 20);             // PCM
  buf.writeUInt16LE(2, 22);             // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); // byte rate
  buf.writeUInt16LE(4, 32);             // block align
  buf.writeUInt16LE(16, 34);            // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  const L = bus.L, R = bus.R;
  for (let i = 0; i < frames; i++) {
    const l = clamp(L[i], -1, 1);
    const r = clamp(R[i], -1, 1);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), o);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), o + 2);
    o += 4;
  }
  writeFileSync(path, buf);
  return buf.length;
}

// ===========================================================================
// 7. 音效
// ===========================================================================
/** 噪声瞬态：带通/高通/低通 + 指数衰减 */
function addNoiseHit(bus, { startFrame = 0, durFrames, gain, type = 'hp', freq = 3000, q = 0.7, tau = 0.03, attack = 0.0005, pan = 0 }) {
  const start = SAMP(startFrame);
  const n = Math.min(Math.round(durFrames * SPF), bus.len - start);
  const f = makeBiquad(type, freq, q);
  const [gl, gr] = panGains(pan);
  const attN = Math.max(1, Math.round(attack * SR));
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, i / attN) * Math.exp(-t / tau);
    const v = f.process(noise()) * env * gain;
    bus.L[start + i] += v * gl;
    bus.R[start + i] += v * gr;
  }
}

/**
 * 每个音效单独开一条总线：统一 DC 处理 → 尾部去咔哒 → 峰值归一化 → 写 WAV。
 * durSec 为文件时长（严格 0.1–0.8s；riser 按需求是 1.6s 的特例）。
 */
const SFX_LIST = [];
function renderSfx(name, durSec, fn) {
  const bus = createBus(Math.round(durSec * SR));
  fn(bus);
  dcBlock(bus.L, bus.len);
  dcBlock(bus.R, bus.len);
  const outN = Math.round(0.004 * SR); // 结尾 4ms 归零，避免爆音
  for (let i = 0; i < outN; i++) {
    const g = 1 - i / outN;
    bus.L[bus.len - outN + i] *= g;
    bus.R[bus.len - outN + i] *= g;
  }
  normalize(bus, SFX_PEAK_TARGET);
  const bytes = writeWav(join(SFX_DIR, `${name}.wav`), bus);
  SFX_LIST.push({ name, durSec, peak: peakOf(bus), bytes });
}

function renderSfxAll() {
  // 方块落位“咔”：方波 1kHz 起，5ms 起音，80ms 衰减
  renderSfx('tick', 0.12, (bus) => {
    addOsc(bus, {
      kind: 'square', duty: 0.5, startFrame: 0, durFrames: 0.08 * FPS,
      freq: 1000, freqEnd: 850, gain: 0.85, attack: 0.005, decayTau: 0.022,
      sustain: 0, release: 0.008,
    });
    addNoiseHit(bus, { durFrames: 0.003 * FPS, gain: 0.12, type: 'hp', freq: 6000, tau: 0.0015, attack: 0.0002 });
  });

  // 拼合重落：80Hz 低频 + 噪声瞬态
  renderSfx('thud', 0.42, (bus) => {
    addOsc(bus, {
      kind: 'sine', freq: 120, freqEnd: 70, startFrame: 0, durFrames: 0.3 * FPS,
      gain: 0.9, attack: 0.002, decayTau: 0.1, sustain: 0, release: 0.02,
    });
    addNoiseHit(bus, { durFrames: 0.05 * FPS, gain: 0.45, type: 'lp', freq: 700, q: 0.8, tau: 0.018, attack: 0.0005 });
    addNoiseHit(bus, { durFrames: 0.008 * FPS, gain: 0.25, type: 'hp', freq: 3200, tau: 0.002, attack: 0.0002 });
  });

  // 拼合后的高频闪烁：3 个正弦错开 30ms
  renderSfx('sparkle', 0.55, (bus) => {
    [2093, 2637, 3136].forEach((freq, i) => {
      addOsc(bus, {
        kind: 'sine', freq, startFrame: i * 0.9, durFrames: 0.44 * FPS,
        gain: 0.55, pan: [-0.5, 0.05, 0.55][i], attack: 0.002, decayTau: 0.1,
        sustain: 0, release: 0.02,
      });
    });
  });

  // 转场 whoosh：带通噪声 + 中心频率上升（左右声道错开一点，做出扫过的宽度）
  renderSfx('whoosh', 0.68, (bus) => {
    const n = Math.round(0.62 * SR);
    const bpL = makeBiquad('bp', 300, 1.1);
    const bpR = makeBiquad('bp', 330, 1.1);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      if (i % 64 === 0) {
        bpL.set(260 * Math.pow(12, p));
        bpR.set(290 * Math.pow(12, p));
      }
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, p * 1.15)), 1.6);
      bus.L[i] += bpL.process(noise()) * env * 0.9;
      bus.R[i] += bpR.process(noise()) * env * 0.9;
    }
  });

  // 8 拍上升（1.6s）：200Hz → 2kHz（锯齿为主 + 少量空气噪声）
  renderSfx('riser', 1.6, (bus) => {
    const n = bus.len;
    let phase = 0;
    let phase2 = 0;
    const hp = makeBiquad('hp', 500, 0.7);
    for (let i = 0; i < n; i++) {
      const p = i / n;
      const f = 200 * Math.pow(10, p); // 200 → 2000
      const dt = f / SR;
      const saw = 2 * phase - 1 - polyBlep(phase, dt);
      phase += dt;
      if (phase >= 1) phase -= 1;
      const sq = pulseWave(phase2, dt, 0.25);
      phase2 += dt;
      if (phase2 >= 1) phase2 -= 1;
      if (i % 64 === 0) hp.set(600 + 7000 * p);
      const nz = hp.process(noise()) * 0.22;
      const env = Math.pow(p, 1.5);
      const tail = i > n - 8 ? (n - i) / 8 : 1;
      const v = (saw * 0.75 + sq * 0.25 + nz) * env * tail * 0.9;
      bus.L[i] += v;
      bus.R[i] += v;
    }
  });

  // 和弦重击：3 个方波构成大三和弦，快衰减
  renderSfx('stab', 0.5, (bus) => {
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      addOsc(bus, {
        kind: 'square', duty: 0.25, freq, startFrame: 0, durFrames: 0.45 * FPS,
        gain: 0.32, pan: [-0.3, 0, 0.3][i], attack: 0.002, decayTau: 0.085,
        sustain: 0, release: 0.01,
      });
    });
    addNoiseHit(bus, { durFrames: 0.006 * FPS, gain: 0.2, type: 'hp', freq: 4500, tau: 0.002, attack: 0.0002 });
  });

  // UI 点击：很短的 2kHz 咔哒
  renderSfx('click', 0.1, (bus) => {
    addOsc(bus, {
      kind: 'square', duty: 0.5, freq: 2000, startFrame: 0, durFrames: 0.018 * FPS,
      gain: 0.7, attack: 0.001, decayTau: 0.005, sustain: 0, release: 0.004,
    });
    addNoiseHit(bus, { durFrames: 0.003 * FPS, gain: 0.2, type: 'hp', freq: 7000, tau: 0.001, attack: 0.0002 });
  });

  // 打字音：极短噪声爆点 + 1.5kHz 方波，约 60ms
  renderSfx('type', 0.12, (bus) => {
    addNoiseHit(bus, { durFrames: 0.008 * FPS, gain: 0.55, type: 'bp', freq: 3000, q: 1.0, tau: 0.003, attack: 0.0003 });
    addOsc(bus, {
      kind: 'square', duty: 0.5, freq: 1500, startFrame: 0, durFrames: 0.06 * FPS,
      gain: 0.45, attack: 0.001, decayTau: 0.014, sustain: 0, release: 0.006,
    });
  });

  // 品牌落版：低频冲击 + 金属感高频
  renderSfx('hit', 0.8, (bus) => {
    addOsc(bus, {
      kind: 'sine', freq: 95, freqEnd: 34, startFrame: 0, durFrames: 0.7 * FPS,
      gain: 0.85, attack: 0.002, decayTau: 0.22, sustain: 0, release: 0.03,
    });
    addNoiseHit(bus, { durFrames: 0.03 * FPS, gain: 0.4, type: 'lp', freq: 900, tau: 0.012, attack: 0.0004 });
    [1447, 2131, 3011, 4273, 5897].forEach((freq, i) => {
      addOsc(bus, {
        kind: 'sine', freq, startFrame: i * 0.6, durFrames: 0.5 * FPS,
        gain: 0.22, pan: [-0.6, 0.45, -0.35, 0.55, 0][i],
        attack: 0.0015, decayTau: 0.13 + i * 0.02, sustain: 0, release: 0.02,
      });
    });
    addNoiseHit(bus, { durFrames: 0.25 * FPS, gain: 0.18, type: 'hp', freq: 5000, tau: 0.09, attack: 0.001 });
  });
}

// ===========================================================================
// 8. 主流程
// ===========================================================================
function fmtDb(x) {
  return x > 0 ? `${(20 * Math.log10(x)).toFixed(1)} dBFS` : '-inf dBFS';
}
function fmtBytes(b) {
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function main() {
  const t0 = process.hrtime.bigint();
  mkdirSync(SFX_DIR, { recursive: true });

  if (BEAT_FRAMES * 4 !== BAR_FRAMES || BAR_FRAMES * 38 !== END) {
    console.warn(
      `[warn] 当前 BPM=${BPM} → 1 小节 = ${BAR_FRAMES} 帧，38 小节 = ${BAR_FRAMES * 38} 帧，与时间轴 ${END} 帧不一致。\n` +
        '       段落边界仍按帧锁定，但小节线会漂移；改速度请同步修改 video/src/timeline.json 与段落小节数。',
    );
  }

  renderBgm();

  // 母带：回声 → 去直流 → 软拐点压缩 → 淡入淡出 → 峰值归一化
  applyPingPong(mix, send, { delaySec: 0.3, feedback: 0.32, wet: 0.55, damp: 3200 });
  dcBlock(mix.L, mix.len);
  dcBlock(mix.R, mix.len);
  normalize(mix, 0.95);
  compressBus(mix, { thresholdDb: -12, ratio: 2.5, kneeDb: 6, attack: 0.004, release: 0.15 });
  softSaturate(mix, 1.5);
  widenStereo(mix, 1.25);
  applyFades(mix);
  normalize(mix, PEAK_TARGET);

  const bgmPeak = peakOf(mix);
  const bgmRms = rmsOf(mix);
  const bgmBytes = writeWav(join(AUDIO_DIR, 'bgm.wav'), mix);

  renderSfxAll();

  const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
  console.log('CubeFish 宣传片音频生成完成');
  console.log(`  BGM  video/public/audio/bgm.wav`);
  console.log(
    `       时长 ${(mix.len / SR).toFixed(3)} s = ${TOTAL_FRAMES} 帧 @${FPS}fps | ` +
      `peak ${bgmPeak.toFixed(4)} (${fmtDb(bgmPeak)}) | RMS ${bgmRms.toFixed(4)} (${fmtDb(bgmRms)}) | ${fmtBytes(bgmBytes)}`,
  );
  console.log(`  SFX  ${SFX_LIST.length} 个 -> video/public/audio/sfx/`);
  for (const s of SFX_LIST) {
    console.log(
      `       ${s.name.padEnd(8)} ${s.durSec.toFixed(3)} s | peak ${s.peak.toFixed(3)} (${fmtDb(s.peak)}) | ${fmtBytes(s.bytes)}`,
    );
  }
  console.log(`  用时 ${elapsed.toFixed(2)} s | 种子 0xc0bef15（确定性）`);
}

main();
