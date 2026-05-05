export function gcd(a, b) {
  a = BigInt(a); b = BigInt(b);
  while (b !== 0n) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a < 0n ? -a : a;
}

export function frac(n, d = 1n) {
  if (d === 0n) throw new Error("Invalid fraction.");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export function addFrac(a, b) {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function mulFrac(a, b) {
  return frac(a.n * b.n, a.d * b.d);
}

export function divFrac(a, b) {
  return frac(a.n * b.d, a.d * b.n);
}

export function floorFrac(a) {
  return a.n / a.d;
}

export function nominalFpsFor(fps) {
  if (fps.nominal) return fps.nominal;
  return BigInt(Math.round(Number(fps.n) / Number(fps.d)));
}

export function parseFps(value) {
  const presets = {
    "23.976": { rate: frac(24000n, 1001n), nominal: 24n, drop: false },
    "23.98": { rate: frac(24000n, 1001n), nominal: 24n, drop: false },
    "24": { rate: frac(24n), nominal: 24n, drop: false },
    "25": { rate: frac(25n), nominal: 25n, drop: false },
    "29.97": { rate: frac(30000n, 1001n), nominal: 30n, drop: false },
    "29.97df": { rate: frac(30000n, 1001n), nominal: 30n, drop: true },
    "30": { rate: frac(30n), nominal: 30n, drop: false },
    "48": { rate: frac(48n), nominal: 48n, drop: false },
    "50": { rate: frac(50n), nominal: 50n, drop: false },
    "59.94": { rate: frac(60000n, 1001n), nominal: 60n, drop: false },
    "59.94df": { rate: frac(60000n, 1001n), nominal: 60n, drop: true },
    "60": { rate: frac(60n), nominal: 60n, drop: false },
    "96": { rate: frac(96n), nominal: 96n, drop: false },
    "100": { rate: frac(100n), nominal: 100n, drop: false },
    "119.88": { rate: frac(120000n, 1001n), nominal: 120n, drop: false },
    "119.88df": { rate: frac(120000n, 1001n), nominal: 120n, drop: true },
    "120": { rate: frac(120n), nominal: 120n, drop: false },
  };
  if (presets[value]) return { ...presets[value], value };
  let rate;
  if (value.includes("/")) {
    const [n, d] = value.split("/").map(v => BigInt(v.trim()));
    rate = frac(n, d);
  } else {
    const parts = value.split(".");
    if (parts.length === 1) rate = frac(BigInt(parts[0]));
    else {
      const scale = 10n ** BigInt(parts[1].length);
      rate = frac(BigInt(parts[0]) * scale + BigInt(parts[1]), scale);
    }
  }
  return { ...rate, rate, nominal: nominalFpsFor(rate), drop: false, value };
}

export function fpsRate(fps) {
  return fps.rate || fps;
}

export function dropFramesFor(fps) {
  if (!fps.drop) return 0n;
  const nominal = nominalFpsFor(fps);
  if (nominal % 30n !== 0n) throw new Error("DF 只支持 29.97 / 59.94 / 119.88");
  return nominal * 2n / 30n;
}

export function timecodeSeparator(fps) {
  return fps.drop ? ";" : ":";
}

export function frameDigitsFor(fps) {
  return Math.max(2, String(nominalFpsFor(fps) - 1n).length);
}

export function timecodeDigitPositions(fps) {
  const frameDigits = frameDigitsFor(fps);
  const positions = [0, 1, 3, 4, 6, 7];
  for (let i = 0; i < frameDigits; i++) positions.push(9 + i);
  return positions;
}

export function timecodeDigitCount(fps) {
  return 6 + frameDigitsFor(fps);
}

export function fpsLabel(fps) {
  const nominal = nominalFpsFor(fps);
  const rate = fpsRate(fps);
  const label = rate.d === 1001n && rate.n % 1000n === 0n
    ? (Number(rate.n / 1000n) / 1000).toFixed(2)
    : Number(nominal).toFixed(2);
  return `${label}${fps.drop ? " DF" : ""} FPS`;
}


export function fpsEquivalent(a, b, tolerance = 0.0002) {
  const rateA = fpsRate(a);
  const rateB = fpsRate(b);
  const valueA = Number(rateA.n) / Number(rateA.d);
  const valueB = Number(rateB.n) / Number(rateB.d);
  return Math.abs(valueA - valueB) <= tolerance && Boolean(a.drop) === Boolean(b.drop);
}

export function fpsValueEquivalent(aValue, bValue) {
  return fpsEquivalent(parseFps(aValue), parseFps(bValue));
}

export function ixmlRateToFpsValue(ixmlInfo) {
  const rawRate = ixmlInfo?.timecodeRate?.value;
  if (!rawRate) return null;
  const flag = (ixmlInfo?.timecodeFlag?.value || "").toUpperCase();
  const drop = flag === "DF" || flag === "DROP" || flag === "DROPFRAME";
  let numeric = null;

  try {
    if (rawRate.includes("/")) {
      const [n, d] = rawRate.split("/").map(value => Number(value.trim()));
      if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) numeric = n / d;
    } else {
      const match = rawRate.match(/\d+(?:\.\d+)?/);
      if (match) numeric = Number(match[0]);
    }
  } catch (error) {
    return null;
  }

  if (!Number.isFinite(numeric)) return null;
  if (Math.abs(numeric - 24) < 0.0002) return "24";
  if (Math.abs(numeric - 25) < 0.0002) return "25";
  if (Math.abs(numeric - 30) < 0.0002) return "30";
  if (Math.abs(numeric - 48) < 0.0002) return "48";
  if (Math.abs(numeric - 50) < 0.0002) return "50";
  if (Math.abs(numeric - 60) < 0.0002) return "60";
  if (Math.abs(numeric - 96) < 0.0002) return "96";
  if (Math.abs(numeric - 100) < 0.0002) return "100";
  if (Math.abs(numeric - 120) < 0.0002) return "120";
  if (Math.abs(numeric - 24000 / 1001) < 0.0002) return "23.976";
  if (Math.abs(numeric - 30000 / 1001) < 0.0002) return drop ? "29.97df" : "29.97";
  if (Math.abs(numeric - 60000 / 1001) < 0.0002) return drop ? "59.94df" : "59.94";
  if (Math.abs(numeric - 120000 / 1001) < 0.0002) return drop ? "119.88df" : "119.88";
  return null;
}


export function parseTimecodeParts(raw, fps) {
  const parts = raw.trim().replaceAll(";", ":").split(":");
  if (parts.length !== 4) throw new Error("时间码格式应为 HH:MM:SS:FF");
  const [hh, mm, ss, ff] = parts.map(part => {
    if (!/^\d+$/.test(part)) throw new Error("时间码只能包含数字");
    return Number(part);
  });
  const nominalFps = Number(nominalFpsFor(fps));
  if (hh < 0 || hh > 9999 || mm > 59 || ss > 59) throw new Error("小时不能超过 9999，分钟和秒不能超过 59");
  if (ff >= nominalFps) throw new Error(`帧数必须小于 ${nominalFps}`);
  const dropFrames = Number(dropFramesFor(fps));
  if (dropFrames && ss === 0 && mm % 10 !== 0 && ff < dropFrames) {
    throw new Error(`DF 时间码不存在：每个非 10 分钟整点会跳过前 ${dropFrames} 帧`);
  }
  return { hh, mm, ss, ff };
}

export function timecodeToFrames(raw, fps) {
  const { hh, mm, ss, ff } = parseTimecodeParts(raw, fps);
  const nominal = nominalFpsFor(fps);
  const nominalFrames = BigInt(hh * 3600 + mm * 60 + ss) * nominal + BigInt(ff);
  const dropFrames = dropFramesFor(fps);
  if (!dropFrames) return nominalFrames;
  const totalMinutes = BigInt(hh * 60 + mm);
  return nominalFrames - dropFrames * (totalMinutes - totalMinutes / 10n);
}

export function framesToTimecode(frames, fps) {
  const nominal = nominalFpsFor(fps);
  let safeFrames = frames < 0n ? 0n : frames;
  const dropFrames = dropFramesFor(fps);
  if (dropFrames) {
    const framesPerMinute = nominal * 60n - dropFrames;
    const framesPer10Minutes = nominal * 600n - dropFrames * 9n;
    const tenMinuteBlocks = safeFrames / framesPer10Minutes;
    const framesIntoBlock = safeFrames % framesPer10Minutes;
    const minuteDrops = framesIntoBlock < dropFrames ? 0n : (framesIntoBlock - dropFrames) / framesPerMinute;
    safeFrames += dropFrames * 9n * tenMinuteBlocks + dropFrames * minuteDrops;
  }
  const ff = safeFrames % nominal;
  const totalSeconds = safeFrames / nominal;
  const ss = totalSeconds % 60n;
  const mm = (totalSeconds / 60n) % 60n;
  const hh = totalSeconds / 3600n;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${timecodeSeparator(fps)}${String(ff).padStart(frameDigitsFor(fps), "0")}`;
}


export function samplesForRate(offset, sampleRate) {
  const samples = mulFrac(offset.seconds, frac(BigInt(sampleRate)));
  if (samples.d !== 1n) throw new Error(`${sampleRate} Hz 下偏移不是整数采样：${samples.n}/${samples.d}`);
  return samples.n;
}


export function samplesToTimecode(samples, sampleRate, fps, options = {}) {
  const precise = options.precise ?? true;
  const totalFrames = mulFrac(frac(samples, BigInt(sampleRate)), fpsRate(fps));
  const whole = precise ? floorFrac(totalFrames) : roundFrac(totalFrames);
  const sub = frac(totalFrames.n - whole * totalFrames.d, totalFrames.d);
  const base = framesToTimecode(whole, fps);
  return precise && sub.n !== 0n ? `${base} + ${sub.n}/${sub.d}fr` : base;
}


export function roundFrac(value) {
  return value.n >= 0n
    ? (value.n + value.d / 2n) / value.d
    : -((-value.n + value.d / 2n) / value.d);
}

export function framesToSamples(frames, sampleRate, fps) {
  return roundFrac(mulFrac(divFrac(frac(frames), fpsRate(fps)), frac(BigInt(sampleRate))));
}
