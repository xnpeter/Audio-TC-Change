import { readAudioSample } from "./wave-audio.js";
import {
  frameDigitsFor,
  framesToSamples,
  fpsRate,
  nominalFpsFor,
  parseFps,
  timecodeSeparator,
  timecodeToFrames,
} from "./timecode.js";

export function createLtcDecoder({ readDataView, candidateFpsValues, defaultFpsValue, fpsSelectLabel }) {
  return {
  syncWords: new Set([
    "0011111111111101",
    "1011111111111100",
  ]),

  async readChannel(record, channelIndex, scanSeconds = 60) {
    const bytesPerSample = record.bitsPerSample / 8;
    const sampleLimit = BigInt(Math.max(record.sampleRate * scanSeconds, record.sampleRate));
    const maxSamples = Number(record.durationSamples < sampleLimit ? record.durationSamples : sampleLimit);
    const bytesToRead = Math.min(record.dataSize, maxSamples * record.blockAlign);
    const view = await readDataView(record.file, record.dataOffset, bytesToRead);
    const samples = Math.floor(view.byteLength / record.blockAlign);
    const channelByteOffset = channelIndex * bytesPerSample;
    const data = new Float32Array(samples);
    let min = Infinity;
    let max = -Infinity;
    let sumSquares = 0;

    for (let i = 0; i < samples; i++) {
      const sample = readAudioSample(view, i * record.blockAlign + channelByteOffset, record);
      data[i] = sample;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
      sumSquares += sample * sample;
    }

    const rawPeak = Math.max(Math.abs(min), Math.abs(max));
    const rawP2p = max - min;
    const rawRms = Math.sqrt(sumSquares / Math.max(1, samples));
    const filtered = this.highPass(data, record.sampleRate);
    const stats = this.channelStats(filtered);
    return {
      ...stats,
      data: filtered,
      rawPeak,
      rawP2p,
      rawRms,
    };
  },

  highPass(data, sampleRate, cutoff = 120) {
    if (!data.length) return data;
    const out = new Float32Array(data.length);
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoff);
    const alpha = rc / (rc + dt);
    let previousIn = data[0];
    let previousOut = 0;
    for (let i = 1; i < data.length; i++) {
      const value = alpha * (previousOut + data[i] - previousIn);
      out[i] = value;
      previousIn = data[i];
      previousOut = value;
    }
    return out;
  },

  channelStats(data, start = 0, end = data.length) {
    let min = Infinity;
    let max = -Infinity;
    let sumSquares = 0;
    let clipped = 0;
    const length = Math.max(0, end - start);
    for (let i = start; i < end; i++) {
      const sample = data[i];
      min = Math.min(min, sample);
      max = Math.max(max, sample);
      sumSquares += sample * sample;
      if (Math.abs(sample) > 0.98) clipped++;
    }
    if (!length) return { min: 0, max: 0, peak: 0, p2p: 0, rms: 0, clippedRatio: 0 };
    const peak = Math.max(Math.abs(min), Math.abs(max));
    return {
      min,
      max,
      peak,
      p2p: max - min,
      rms: Math.sqrt(sumSquares / length),
      clippedRatio: clipped / length,
    };
  },

  channelWindows(channel, sampleRate) {
    const windowSamples = Math.max(sampleRate * 4, 1);
    const hopSamples = Math.max(sampleRate * 2, 1);
    if (channel.data.length <= windowSamples) {
      return [{ ...this.channelStats(channel.data), data: channel.data, baseSample: 0, windowStart: 0, windowEnd: channel.data.length }];
    }
    const windows = [];
    for (let start = 0; start < channel.data.length; start += hopSamples) {
      const end = Math.min(channel.data.length, start + windowSamples);
      if (end - start < sampleRate) break;
      windows.push({
        ...this.channelStats(channel.data, start, end),
        data: channel.data.subarray(start, end),
        baseSample: start,
        windowStart: start,
        windowEnd: end,
      });
      if (end === channel.data.length) break;
    }
    return windows;
  },

  quickRejectChannel(channel, sampleRate) {
    if (channel.peak < 0.035 || channel.p2p < 0.07) return { reject: true, reason: "level" };
    const totalSamples = channel.data.length;
    if (totalSamples < sampleRate) return { reject: false, reason: "short" };
    const stats = this.channelStats(channel.data, 0, totalSamples);
    if (stats.peak < 0.035 || stats.p2p < 0.07) return { reject: true, reason: "window-level" };
    const center = (stats.max + stats.min) / 2;
    const hysteresis = Math.max(stats.p2p * 0.06, stats.rms * 0.14, 0.004);
    const minHalf = sampleRate / (120 * 80 * 2) * 0.45;
    const maxHalf = sampleRate / (23.976 * 80 * 2) * 2.4;
    const windowSamples = sampleRate * 2;
    const hopSamples = sampleRate;
    const bucketCount = Math.max(1, Math.ceil(Math.max(1, totalSamples - windowSamples) / hopSamples) + 1);
    const intervalsByBucket = new Uint32Array(bucketCount);
    const plausibleByBucket = new Uint32Array(bucketCount);
    let intervals = 0;
    let plausible = 0;
    let state = channel.data[0] >= center ? 1 : -1;
    let lastEdge = null;
    for (let i = 1; i < totalSamples; i++) {
      const sample = channel.data[i];
      const nextState = sample > center + hysteresis ? 1 : sample < center - hysteresis ? -1 : state;
      if (nextState !== state) {
        if (lastEdge !== null) {
          const interval = i - lastEdge;
          const bucket = Math.min(bucketCount - 1, Math.floor(i / hopSamples));
          intervalsByBucket[bucket]++;
          intervals++;
          if (interval >= minHalf && interval <= maxHalf) {
            plausibleByBucket[bucket]++;
            plausible++;
          }
        }
        lastEdge = i;
      }
      state = nextState;
    }
    let bestIntervals = 0;
    let bestPlausible = 0;
    for (let i = 0; i < bucketCount; i++) {
      const windowIntervals = intervalsByBucket[i] + (intervalsByBucket[i + 1] || 0);
      const windowPlausible = plausibleByBucket[i] + (plausibleByBucket[i + 1] || 0);
      if (windowPlausible > bestPlausible) {
        bestPlausible = windowPlausible;
        bestIntervals = windowIntervals;
      }
    }
    if (bestIntervals < 800) return { reject: true, reason: "few-ltc-edges" };
    if (bestPlausible < 700 || bestPlausible / Math.max(1, bestIntervals) < 0.72) {
      return { reject: true, reason: "aperiodic" };
    }
    return { reject: false, reason: "plausible", edges: bestPlausible };
  },

  estimateHalfBitSamples(channel, sampleRate) {
    let best = null;
    for (const window of this.channelWindows(channel, sampleRate)) {
      const stats = window;
      if (stats.peak < 0.035 || stats.p2p < 0.07) continue;
      const center = (stats.max + stats.min) / 2;
      const hysteresis = Math.max(stats.p2p * 0.06, stats.rms * 0.14, 0.004);
      const minHalf = sampleRate / (120 * 80 * 2) * 0.45;
      const maxHalf = sampleRate / (23.976 * 80 * 2) * 2.4;
      const intervals = [];
      let state = window.data[0] >= center ? 1 : -1;
      let lastEdge = null;
      for (let i = 1; i < window.data.length; i++) {
        const sample = window.data[i];
        const nextState = sample > center + hysteresis ? 1 : sample < center - hysteresis ? -1 : state;
        if (nextState !== state) {
          if (lastEdge !== null) {
            const interval = i - lastEdge;
            if (interval >= minHalf && interval <= maxHalf) intervals.push(interval);
          }
          lastEdge = i;
        }
        state = nextState;
      }
      if (intervals.length < 700) continue;
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      const half = intervals.filter(value => Math.abs(value - median) / median < 0.18);
      if (half.length < 500) continue;
      const mean = half.reduce((sum, value) => sum + value, 0) / half.length;
      const jitter = Math.sqrt(half.reduce((sum, value) => sum + (value - mean) ** 2, 0) / half.length) / Math.max(mean, 1);
      const score = half.length * (1 - Math.min(jitter, 0.5));
      if (!best || score > best.score) best = { halfBitSamples: mean, score, jitter, count: half.length };
    }
    return best;
  },

  fpsCandidatesForChannel(channel, sampleRate, preferredValue, values) {
    const selected = new Set([preferredValue]);
    const estimate = this.estimateHalfBitSamples(channel, sampleRate);
    if (!estimate) return values;
    const ranked = values
      .map(value => {
        const fps = parseFps(value);
        const fpsValue = Number(fpsRate(fps).n) / Number(fpsRate(fps).d);
        const expectedHalf = sampleRate / (fpsValue * 80 * 2);
        return { value, error: Math.abs(expectedHalf - estimate.halfBitSamples) / expectedHalf };
      })
      .sort((a, b) => a.error - b.error);
    for (const item of ranked.slice(0, 4)) selected.add(item.value);
    for (const item of [...selected]) {
      if (item === "29.97") selected.add("29.97df");
      if (item === "29.97df") selected.add("29.97");
      if (item === "59.94") selected.add("59.94df");
      if (item === "59.94df") selected.add("59.94");
      if (item === "119.88") selected.add("119.88df");
      if (item === "119.88df") selected.add("119.88");
    }
    return values.filter(value => selected.has(value));
  },

  findEdges(channel, expectedHalfBitSamples) {
    if (channel.peak < 0.035 || channel.p2p < 0.07) return [];
    const center = (channel.max + channel.min) / 2;
    const hysteresis = Math.max(channel.p2p * 0.08, channel.rms * 0.18, 0.006);
    const minEdgeDistance = Math.max(2, expectedHalfBitSamples * 0.35);
    const baseSample = channel.baseSample || 0;
    const edges = [];
    let state = channel.data[0] >= center ? 1 : -1;
    let lastEdge = -Infinity;

    for (let i = 1; i < channel.data.length; i++) {
      const sample = channel.data[i];
      const upper = center + hysteresis;
      const lower = center - hysteresis;
      const nextState = sample > upper ? 1 : sample < lower ? -1 : state;
      if (nextState !== state && i - lastEdge >= minEdgeDistance) {
        const prev = channel.data[i - 1];
        const denom = sample - prev;
        const crossing = denom === 0 ? i : (i - 1) + (center - prev) / denom;
        edges.push(crossing + baseSample);
        lastEdge = crossing;
      }
      state = nextState;
    }

    return edges;
  },

  decodeBits(edges, expectedHalfBitSamples) {
    const bits = [];
    const bitStarts = [];
    const bitEnds = [];
    let half = expectedHalfBitSamples;
    let rejected = 0;
    const observedHalves = [];

    for (let i = 0; i < edges.length - 1;) {
      const interval = edges[i + 1] - edges[i];
      const units = interval / half;

      if (units > 0.55 && units < 1.45 && i + 2 < edges.length) {
        const nextInterval = edges[i + 2] - edges[i + 1];
        const nextUnits = nextInterval / half;
        if (nextUnits > 0.55 && nextUnits < 1.45) {
          bits.push(1);
          bitStarts.push(edges[i]);
          bitEnds.push(edges[i + 2]);
          observedHalves.push(interval, nextInterval);
          half = half * 0.85 + ((interval + nextInterval) / 2) * 0.15;
          i += 2;
          continue;
        }
      }

      if (units > 1.45 && units < 2.7) {
        bits.push(0);
        bitStarts.push(edges[i]);
        bitEnds.push(edges[i + 1]);
        observedHalves.push(interval / 2);
        half = half * 0.9 + (interval / 2) * 0.1;
        i += 1;
        continue;
      }

      rejected++;
      i += 1;
    }

    const observedMean = observedHalves.length
      ? observedHalves.reduce((sum, value) => sum + value, 0) / observedHalves.length
      : half;
    const observedJitter = observedHalves.length
      ? Math.sqrt(observedHalves.reduce((sum, value) => sum + (value - observedMean) ** 2, 0) / observedHalves.length) / Math.max(observedMean, 1)
      : 1;
    return { bits, bitStarts, bitEnds, rejected, trackedHalfBitSamples: half, observedHalfBitSamples: observedMean, observedJitter };
  },

  hasSync(bits) {
    return this.syncWords.has(bits.slice(64, 80).join(""));
  },

  parseFrame(bits, fps) {
    const value = indexes => indexes.reduce((sum, index, place) => sum + (bits[index] ? 2 ** place : 0), 0);
    const ff = value([0, 1, 2, 3]) + value([8, 9]) * 10;
    const ss = value([16, 17, 18, 19]) + value([24, 25, 26]) * 10;
    const mm = value([32, 33, 34, 35]) + value([40, 41, 42]) * 10;
    const hh = value([48, 49, 50, 51]) + value([56, 57]) * 10;
    const nominal = Number(nominalFpsFor(fps));
    if (hh > 23 || mm > 59 || ss > 59 || ff >= nominal) return null;
    const sep = timecodeSeparator(fps);
    const timecode = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${sep}${String(ff).padStart(frameDigitsFor(fps), "0")}`;
    try {
      return { timecode, frames: timecodeToFrames(timecode, fps), drop: Boolean(bits[10]) };
    } catch (error) {
      return null;
    }
  },

  frameAt(decoded, start, fps, reverse = false, strictDrop = true) {
    if (start < 0 || start + 80 > decoded.bits.length) return null;
    const bits = decoded.bits.slice(start, start + 80);
    const candidateBits = reverse ? bits.slice().reverse() : bits;
    if (!this.hasSync(candidateBits)) return null;
    const frame = this.parseFrame(candidateBits, fps);
    if (!frame) return null;
    if (strictDrop && frame.drop !== Boolean(fps.drop)) return null;
    return {
      ...frame,
      bitStart: start,
      sampleStart: decoded.bitStarts[start],
      sampleEnd: decoded.bitEnds[start + 79],
      reverse,
    };
  },

  consecutiveRun(decoded, start, fps, reverse = false, strictDrop = true) {
    const frames = [];
    for (let offset = 0; offset < 12; offset++) {
      const bitStart = start + offset * 80;
      const frame = this.frameAt(decoded, bitStart, fps, reverse, strictDrop);
      if (!frame) break;
      if (frames.length) {
        const expected = reverse ? frames[frames.length - 1].frames - 1n : frames[frames.length - 1].frames + 1n;
        if (frame.frames !== expected) break;
      }
      frames.push(frame);
    }
    return frames;
  },

  qualityFor(candidate) {
    if (candidate.confidence >= 0.82 && candidate.lockedFrames >= 6 && candidate.halfBitError <= 0.0025 && candidate.rejectRatio <= 0.08) {
      return { label: "高", rank: 3 };
    }
    if (candidate.confidence >= 0.62 && candidate.lockedFrames >= 3 && candidate.halfBitError <= 0.008 && candidate.rejectRatio <= 0.2) {
      return { label: "中", rank: 2 };
    }
    return { label: "低", rank: 1 };
  },

  compareResults(a, b) {
    if ((b.qualityRank || 0) !== (a.qualityRank || 0)) return (b.qualityRank || 0) - (a.qualityRank || 0);
    if (Math.abs((a.halfBitError || 1) - (b.halfBitError || 1)) > 0.00025) return (a.halfBitError || 1) - (b.halfBitError || 1);
    if ((b.lockedFrames || 0) !== (a.lockedFrames || 0)) return (b.lockedFrames || 0) - (a.lockedFrames || 0);
    if ((b.confidence || 0) !== (a.confidence || 0)) return (b.confidence || 0) - (a.confidence || 0);
    if (Boolean(a.reverse) !== Boolean(b.reverse)) return Number(a.reverse) - Number(b.reverse);
    return (a.sampleOffset || 0) - (b.sampleOffset || 0);
  },

  chooseCandidate(decoded, record, fps, stats, expectedHalfBitSamples, strictDrop = true) {
    let best = null;
    for (let start = 0; start + 80 <= decoded.bits.length; start++) {
      for (const reverse of [false, true]) {
        const run = this.consecutiveRun(decoded, start, fps, reverse, strictDrop);
        if (run.length < 2) continue;
        const first = run[0];
        const last = run[run.length - 1];
        const sampleOffset = Math.max(0, Math.round(first.sampleStart || 0));
        const tcSamples = framesToSamples(first.frames, record.sampleRate, fps);
        const newTimeReference = tcSamples - BigInt(sampleOffset);
        if (newTimeReference < 0n) continue;
        const measuredHalfBitSamples = (last.sampleEnd - first.sampleStart) / Math.max(1, run.length * 80 * 2);
        const halfBitError = Math.abs(measuredHalfBitSamples - expectedHalfBitSamples) / expectedHalfBitSamples;
        const rejectRatio = decoded.rejected / Math.max(1, decoded.rejected + decoded.bits.length);
        const lockScore = Math.min(1, run.length / 8);
        const halfScore = Math.max(0, Math.min(1, 1 - halfBitError / 0.006));
        const consistencyScore = Math.max(0, Math.min(1, 1 - (decoded.observedJitter || 0) / 0.18));
        const edgeScore = Math.min(1, decoded.bits.length / 320);
        const levelScore = Math.min(1, stats.p2p / 0.6);
        const confidence = Math.max(0, Math.min(1,
          lockScore * 0.3 +
          halfScore * 0.3 +
          consistencyScore * 0.12 +
          edgeScore * 0.12 +
          levelScore * 0.12 -
          rejectRatio * 0.18 +
          0.04
        ));
        const candidate = {
          ...first,
          sampleOffset,
          newTimeReference,
          confidence,
          lockedFrames: run.length,
          reverse,
          measuredHalfBitSamples,
          halfBitError,
          rejectRatio,
          observedJitter: decoded.observedJitter,
          windowStart: stats.windowStart || 0,
          windowEnd: stats.windowEnd || stats.data?.length || 0,
          diagnostics: {
            peak: stats.peak,
            rms: stats.rms,
            p2p: stats.p2p,
            decodedBits: decoded.bits.length,
            rejectedEdges: decoded.rejected,
            trackedHalfBitSamples: decoded.trackedHalfBitSamples,
            observedHalfBitSamples: decoded.observedHalfBitSamples,
            observedJitter: decoded.observedJitter,
            measuredHalfBitSamples,
            halfBitError,
            rejectRatio,
            windowStart: stats.windowStart || 0,
            windowEnd: stats.windowEnd || stats.data?.length || 0,
          },
        };
        const quality = this.qualityFor(candidate);
        candidate.qualityLabel = quality.label;
        candidate.qualityRank = quality.rank;
        if (!best || this.compareResults(candidate, best) < 0) best = candidate;
      }
    }
    return best;
  },

  async detectOnChannel(record, channelIndex, fps) {
    const fpsValue = Number(fpsRate(fps).n) / Number(fpsRate(fps).d);
    const expectedHalfBitSamples = record.sampleRate / (fpsValue * 80 * 2);
    const channel = await this.readChannel(record, channelIndex);
    return this.detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples);
  },

  detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples = null, strictDrop = true) {
    const fpsValue = Number(fpsRate(fps).n) / Number(fpsRate(fps).d);
    const halfBitSamples = expectedHalfBitSamples || record.sampleRate / (fpsValue * 80 * 2);
    let best = null;
    for (const window of this.channelWindows(channel, record.sampleRate)) {
      const edges = this.findEdges(window, halfBitSamples);
      if (edges.length < 160) continue;
      const decoded = this.decodeBits(edges, halfBitSamples);
      const candidate = this.chooseCandidate(decoded, record, fps, window, halfBitSamples, strictDrop);
      if (!candidate) continue;
      if (!best || this.compareResults(candidate, best) < 0) best = candidate;
    }
    if (!best) return null;
    return {
      ...best,
      channelIndex,
      channelLabel: `${channelIndex + 1}`,
      halfBitSamples,
    };
  },

  async detect(record, fps) {
    const results = [];
    for (let channelIndex = 0; channelIndex < record.channels; channelIndex++) {
      const result = await this.detectOnChannel(record, channelIndex, fps);
      if (result) results.push(result);
    }
    results.sort((a, b) => this.compareResults(a, b));
    return results[0] || null;
  },

  candidateFpsValues() {
    return candidateFpsValues();
  },

  async detectAuto(record, preferredFps) {
    const preferredValue = preferredFps.value || defaultFpsValue();
    const values = [
      preferredValue,
      ...this.candidateFpsValues().filter(value => value !== preferredValue),
    ];
    const results = [];
    const rejectedChannels = [];

    for (let channelIndex = 0; channelIndex < record.channels; channelIndex++) {
      const channel = await this.readChannel(record, channelIndex);
      const quick = this.quickRejectChannel(channel, record.sampleRate);
      if (quick.reject) {
        rejectedChannels.push({
          channelIndex,
          channelLabel: `${channelIndex + 1}`,
          rejectReason: quick.reason,
        });
        continue;
      }
      const candidateValues = this.fpsCandidatesForChannel(channel, record.sampleRate, preferredValue, values);
      for (const value of candidateValues) {
        const fps = parseFps(value);
        const fpsValue = Number(fpsRate(fps).n) / Number(fpsRate(fps).d);
        const expectedHalfBitSamples = record.sampleRate / (fpsValue * 80 * 2);
        let result = this.detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples, true);
        if (!result && value === preferredValue) {
          result = this.detectOnChannelData(record, channelIndex, fps, channel, expectedHalfBitSamples, false);
          if (result) result.dropMismatch = result.drop !== Boolean(fps.drop);
        }
        if (result) {
          results.push({
            ...result,
            fps,
            fpsValue: value,
            fpsLabel: fpsSelectLabel(value),
            preferred: value === preferredValue,
          });
        }
      }
    }

    results.sort((a, b) => {
      if (Boolean(a.dropMismatch) !== Boolean(b.dropMismatch)) return Number(a.dropMismatch) - Number(b.dropMismatch);
      if ((b.qualityRank || 0) !== (a.qualityRank || 0)) return (b.qualityRank || 0) - (a.qualityRank || 0);
      if (Math.abs(a.halfBitError - b.halfBitError) > 0.00025) return a.halfBitError - b.halfBitError;
      if (b.lockedFrames !== a.lockedFrames) return b.lockedFrames - a.lockedFrames;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return Number(b.preferred) - Number(a.preferred);
    });

    return {
      best: results[0] || null,
      preferred: results.find(result => result.fpsValue === preferredValue) || null,
      results,
      rejectedChannels,
    };
  },
}
}
