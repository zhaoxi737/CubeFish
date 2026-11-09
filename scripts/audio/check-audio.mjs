#!/usr/bin/env node
/**
 * CubeFish 宣传片音频自检
 * ---------------------------------------------------------------------------
 * 只读：不生成、不修改任何 wav。
 *   node scripts/audio/check-audio.mjs
 *
 * 检查项：
 *   1. RIFF/WAVE 头、PCM 格式、44.1kHz / 16-bit / stereo
 *   2. bgm 时长是否 = 1824 帧（60.8s）±1 帧
 *   3. bgm 峰值是否 ≤ 0.95、是否出现削波样本（±32767）
 *   4. 打印 bgm 的时长 / 峰值 / RMS / 各段落响度
 *   5. 打印每个 sfx 的时长与峰值，检查 0.1–0.8s（riser 1.6s 为需求特例）
 *
 * 退出码 0 = 全过；1 = 有失败项。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const FPS = 30;
const TOTAL_FRAMES = 1824;
const EXPECTED_SEC = TOTAL_FRAMES / FPS; // 60.8
const PEAK_LIMIT = 0.95;
const SFX_DIR_NAME = 'sfx';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const AUDIO_DIR = join(ROOT, 'video', 'public', 'audio');
const BGM_PATH = join(AUDIO_DIR, 'bgm.wav');
const SFX_DIR = join(AUDIO_DIR, SFX_DIR_NAME);

const failures = [];
const check = (ok, label, detail) => {
  if (ok) console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
};

function parseWav(path) {
  const buf = readFileSync(path);
  if (buf.length < 44) throw new Error(`${path} 小于 44 字节，不是 WAV`);
  const riff = buf.toString('ascii', 0, 4);
  const wave = buf.toString('ascii', 8, 12);
  const fmt = buf.toString('ascii', 12, 16);
  if (riff !== 'RIFF' || wave !== 'WAVE' || fmt !== 'fmt ') {
    throw new Error(`${path} RIFF/WAVE/fmt 标识不正确`);
  }
  const audioFormat = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const byteRate = buf.readUInt32LE(28);
  const blockAlign = buf.readUInt16LE(32);
  const bits = buf.readUInt16LE(34);
  const dataTag = buf.toString('ascii', 36, 40);
  const dataBytes = buf.readUInt32LE(40);
  if (dataTag !== 'data') throw new Error(`${path} 缺少 data chunk`);
  if (buf.length !== 44 + dataBytes) throw new Error(`${path} 文件长度与 data chunk 不符`);
  const frames = dataBytes / (channels * 2);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let peak = 0;
  let peakAt = 0;
  let clipped = 0;
  let sumSq = 0;
  let sum = 0;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const l = buf.readInt16LE(o) / 32767;
    const r = buf.readInt16LE(o + 2) / 32767;
    o += 4;
    L[i] = l;
    R[i] = r;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) {
      peak = a;
      peakAt = i;
    }
    if (Math.abs(l) >= 32767 / 32767 || Math.abs(r) >= 32767 / 32767) clipped++;
    sumSq += l * l + r * r;
    sum += l + r;
  }
  return {
    path, frames, channels, sampleRate, bits, audioFormat, byteRate, blockAlign,
    L, R, peak, peakAt, clipped,
    rms: Math.sqrt(sumSq / (frames * 2)),
    dc: sum / (frames * 2),
  };
}

function db(x) {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}
function fmtDb(x) {
  return Number.isFinite(db(x)) ? `${db(x).toFixed(1)} dBFS` : '-inf dBFS';
}
function sectionRms(wav, aFrame, bFrame) {
  const a = Math.round((aFrame / FPS) * SR);
  const b = Math.min(wav.frames, Math.round((bFrame / FPS) * SR));
  let sumSq = 0;
  let peak = 0;
  for (let i = a; i < b; i++) {
    const l = wav.L[i];
    const r = wav.R[i];
    sumSq += l * l + r * r;
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > peak) peak = m;
  }
  const n = Math.max(1, b - a);
  return { rms: Math.sqrt(sumSq / (n * 2)), peak };
}

// ---------------------------------------------------------------------------
console.log('CubeFish 音频自检');
console.log(`  目录: ${AUDIO_DIR}\n`);

if (!existsSync(BGM_PATH)) {
  console.error(`缺少 ${BGM_PATH}`);
  process.exit(1);
}

// ---- BGM ----
const bgm = parseWav(BGM_PATH);
console.log('[bgm.wav]');
check(bgm.audioFormat === 1, 'PCM 格式', `audioFormat=${bgm.audioFormat}`);
check(bgm.channels === 2, '立体声', `channels=${bgm.channels}`);
check(bgm.sampleRate === SR, '采样率 44100', `${bgm.sampleRate} Hz`);
check(bgm.bits === 16, '16-bit', `${bgm.bits} bit`);
check(bgm.byteRate === SR * 4 && bgm.blockAlign === 4, 'byteRate/blockAlign 正确');

const durSec = bgm.frames / SR;
const durFrames = (durSec * FPS);
const frameErr = Math.abs(durFrames - TOTAL_FRAMES);
console.log(
  `  时长      : ${durSec.toFixed(6)} s = ${durFrames.toFixed(3)} 帧 @${FPS}fps ` +
    `(目标 ${TOTAL_FRAMES} 帧 = ${EXPECTED_SEC}s，误差 ${frameErr.toFixed(3)} 帧)`,
);
console.log(
  `  峰值      : ${bgm.peak.toFixed(4)} (${fmtDb(bgm.peak)}) @ ${(bgm.peakAt / SR).toFixed(3)}s ` +
    `= 第 ${((bgm.peakAt / SR) * FPS).toFixed(1)} 帧`,
);
console.log(`  RMS       : ${bgm.rms.toFixed(4)} (${fmtDb(bgm.rms)})`);
console.log(`  波峰因数  : ${(db(bgm.peak) - db(bgm.rms)).toFixed(1)} dB`);
console.log(`  直流偏移  : ${bgm.dc.toFixed(6)} | 削波样本数: ${bgm.clipped}`);
console.log('');
check(frameErr <= 1, 'bgm 时长 = 1824 帧 ±1 帧', `${durFrames.toFixed(3)} 帧`);
check(bgm.peak <= PEAK_LIMIT + 1e-6, 'bgm 峰值 ≤ 0.95', bgm.peak.toFixed(4));
check(bgm.clipped === 0, 'bgm 无削波样本（±32767）', `${bgm.clipped} 个`);
check(Math.abs(bgm.dc) < 1e-4, 'bgm 直流偏移可忽略', bgm.dc.toExponential(2));

console.log('\n  分段响度（RMS / 峰值）:');
const SECTIONS = [
  ['S0 钩子', 0, 144],
  ['S1 核心流程', 144, 480],
  ['S2 轻量化', 480, 576],
  ['S3 功能卡', 576, 960],
  ['S4 AI 段', 960, 1536],
  ['S5 结尾', 1536, 1824],
];
const sectionLevels = {};
for (const [name, a, b] of SECTIONS) {
  const s = sectionRms(bgm, a, b);
  sectionLevels[name] = s;
  console.log(`    ${name.padEnd(12)} 帧 ${String(a).padStart(4)}–${String(b).padEnd(4)}  RMS ${fmtDb(s.rms).padStart(10)}  peak ${s.peak.toFixed(3)}`);
}
// 结构直觉检查：drop 应该明显比留白段响
const r = (k) => sectionLevels[k].rms;
check(r('S1 核心流程') > r('S0 钩子'), '结构：主歌比前奏响', `${fmtDb(r('S1 核心流程'))} > ${fmtDb(r('S0 钩子'))}`);
check(r('S2 轻量化') < r('S1 核心流程') * 0.85, '结构：轻量化段明显留白', `${fmtDb(r('S2 轻量化'))} < ${fmtDb(r('S1 核心流程'))}`);
check(r('S3 功能卡') > r('S2 轻量化'), '结构：功能卡段回到完整 groove', `${fmtDb(r('S3 功能卡'))} > ${fmtDb(r('S2 轻量化'))}`);
check(r('S5 结尾') < r('S4 AI 段'), '结构：结尾鼓停后收下来', `${fmtDb(r('S5 结尾'))} < ${fmtDb(r('S4 AI 段'))}`);

// ---- SFX ----
console.log('\n[sfx/]');
if (!existsSync(SFX_DIR)) {
  check(false, 'sfx 目录存在', SFX_DIR);
} else {
  const files = readdirSync(SFX_DIR).filter((f) => f.endsWith('.wav')).sort();
  const seen = [];
  for (const f of files) {
    const wav = parseWav(join(SFX_DIR, f));
    const d = wav.frames / SR;
    seen.push(f);
    const minOk = d >= 0.1 - 1e-6;
    const maxOk = f === 'riser.wav' ? d <= 1.6 + 1e-6 : d <= 0.8 + 1e-6;
    const peakOk = wav.peak <= PEAK_LIMIT + 1e-6;
    const clipOk = wav.clipped === 0;
    const ok = minOk && maxOk && peakOk && clipOk;
    console.log(
      `  ${ok ? '✅' : '❌'} ${f.padEnd(12)} ${d.toFixed(3)} s | peak ${wav.peak.toFixed(3)} (${fmtDb(wav.peak)}) | ` +
        `${wav.frames} 帧 | ${wav.channels}ch/${wav.bits}bit/${wav.sampleRate}Hz`,
    );
    if (!ok) failures.push(`sfx/${f} 规格不符`);
  }
  const EXPECTED_SFX = ['click.wav', 'hit.wav', 'riser.wav', 'sparkle.wav', 'stab.wav', 'thud.wav', 'tick.wav', 'type.wav', 'whoosh.wav'];
  const missing = EXPECTED_SFX.filter((x) => !seen.includes(x));
  check(missing.length === 0, '9 个音效齐全', missing.length ? `缺: ${missing.join(', ')}` : `${files.length} 个文件`);
}

console.log('');
if (failures.length) {
  console.log(`自检失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
console.log('自检全部通过 ✅');
