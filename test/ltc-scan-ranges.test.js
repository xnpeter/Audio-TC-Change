import assert from "node:assert/strict";
import test from "node:test";
import {
  forEachLtcScanChunk,
  LTC_FULL_SCAN_MAX_BYTES,
  ltcWorkerReadRanges,
  mergeLtcAutoResults,
  shiftLtcDetection,
} from "../src/ltc-controller.js";
import { framesToSamples, normalizeTimeReference, parseFps } from "../src/timecode.js";

test("a full-file LTC scan is split into capped overlapping slices", () => {
  const dataSize = 40 * 1024 * 1024;
  const blockAlign = 4;
  const ranges = ltcWorkerReadRanges({
    dataSize,
    blockAlign,
    sampleRate: 48000,
    durationSamples: dataSize / blockAlign,
    scanSeconds: null,
    maxBytes: LTC_FULL_SCAN_MAX_BYTES,
  });
  assert.ok(ranges.length > 1);
  assert.equal(ranges[0].startSample, 0);
  let covered = 0;
  for (const range of ranges) {
    assert.ok(range.byteLength <= LTC_FULL_SCAN_MAX_BYTES);
    assert.equal(range.byteLength, range.sampleCount * blockAlign);
    assert.ok(range.startSample <= covered);
    covered = range.startSample + range.sampleCount;
  }
  assert.equal(covered, dataSize / blockAlign);
  assert.ok(ranges.reduce((sum, range) => sum + range.byteLength, 0) > dataSize);
});

test("a short full-file scan and a 5 second scan stay one read", () => {
  const short = ltcWorkerReadRanges({
    dataSize: 1000,
    blockAlign: 2,
    sampleRate: 48000,
    scanSeconds: null,
  });
  assert.equal(short.length, 1);
  assert.equal(short[0].byteLength, 1000);

  const fast = ltcWorkerReadRanges({
    dataSize: 100 * 1024 * 1024,
    blockAlign: 4,
    sampleRate: 48000,
    durationSamples: (100 * 1024 * 1024) / 4,
    scanSeconds: 5,
    maxBytes: LTC_FULL_SCAN_MAX_BYTES,
  });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].sampleCount, 48000 * 5);
  assert.ok(fast[0].byteLength <= LTC_FULL_SCAN_MAX_BYTES);
});

test("full-file scanning never arrayBuffers the whole data chunk", async () => {
  const dataSize = 20 * 1024 * 1024;
  const blockAlign = 4;
  const maxBytes = 1024 * 1024;
  const calls = [];
  const file = {
    slice(start, end) {
      const length = end - start;
      calls.push(length);
      if (length > maxBytes) throw new Error(`read ${length} bytes in one slice`);
      return { async arrayBuffer() { return new ArrayBuffer(length); } };
    },
  };
  await forEachLtcScanChunk({
    file,
    dataOffset: 128,
    dataSize,
    blockAlign,
    sampleRate: 48000,
    durationSamples: BigInt(dataSize / blockAlign),
  }, null, async () => false, maxBytes);
  assert.ok(calls.length > 1);
  assert.ok(calls.every(length => length <= maxBytes));
});

test("a later LTC chunk keeps an absolute sample offset", () => {
  const fps = parseFps("24");
  const shifted = shiftLtcDetection({
    frames: 48n,
    fps,
    sampleOffset: 100,
    newTimeReference: 0n,
    qualityRank: 3,
  }, 48000, 48000);
  assert.equal(shifted.sampleOffset, 48100);
  assert.equal(
    shifted.newTimeReference,
    normalizeTimeReference(framesToSamples(48n, 48000, fps) - 48100n, 48000),
  );
  const merged = mergeLtcAutoResults(
    { best: { qualityRank: 1, sampleOffset: 1 }, preferred: null, results: [], rejectedChannels: [] },
    { best: shifted, preferred: shifted, results: [shifted], rejectedChannels: [{ channelIndex: 1 }] },
    (left, right) => (right.qualityRank || 0) - (left.qualityRank || 0),
  );
  assert.equal(merged.best.sampleOffset, 48100);
  assert.equal(merged.preferred.sampleOffset, 48100);
});
