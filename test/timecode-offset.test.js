import assert from "node:assert/strict";
import test from "node:test";
import { createTimeReferenceWriteController } from "../src/time-reference-write-controller.js";
import {
  divFrac,
  fpsRate,
  frac,
  framesToSamples,
  framesToTimecode,
  mulFrac,
  numericRateToFpsValue,
  parseBextAspeed,
  parseFps,
  samplesForRate,
  samplesToTimecode,
  timecodeToFrames,
} from "../src/timecode.js";

function exactSamples(frames, sampleRate, fps) {
  return mulFrac(divFrac(frac(frames), fpsRate(fps)), frac(BigInt(sampleRate)));
}

function assertRoundTrip(timecode, fpsValue, sampleRate = 48000) {
  const fps = parseFps(fpsValue);
  const frames = timecodeToFrames(timecode, fps);
  const exact = exactSamples(frames, sampleRate, fps);
  const rounded = framesToSamples(frames, sampleRate, fps);
  const back = samplesToTimecode(rounded, sampleRate, fps, { precise: false, wrapDay: true });
  assert.equal(back, timecode);
  assert.equal(framesToTimecode(frames, fps), timecode);
  const error = exact.n > rounded * exact.d ? exact.n - rounded * exact.d : rounded * exact.d - exact.n;
  assert.ok(error * 2n <= exact.d, `${timecode} @ ${fpsValue} rounded by more than half a sample`);
  return { frames, exact, rounded };
}

test("29.97 and 59.94 one-frame offsets round instead of requiring integer samples", () => {
  const ndf = parseFps("29.97");
  const df = parseFps("29.97df");
  const high = parseFps("59.94");
  assert.throws(() => samplesForRate(divFrac(frac(1n), fpsRate(ndf)), 48000));
  assert.equal(framesToSamples(1n, 48000, ndf), 1602n);
  assert.equal(framesToSamples(1n, 48000, df), 1602n);
  assert.equal(framesToSamples(1n, 48000, high), 801n);
  assertRoundTrip("00:00:00:01", "29.97");
  assertRoundTrip("00:00:00;01", "29.97df");
  assertRoundTrip("00:00:00:01", "59.94");
});

test("aSPEED 023.980-ND is recognized as 23.976", () => {
  assert.equal(parseBextAspeed("aSPEED=023.980-ND").fpsValue, "23.976");
  assert.equal(numericRateToFpsValue(23.98), "23.976");
  assert.equal(numericRateToFpsValue(23.976), "23.976");
  assert.equal(numericRateToFpsValue(24000 / 1001), "23.976");
  assert.equal(numericRateToFpsValue(24), "24");
  assert.equal(parseBextAspeed("aSPEED=024.000-ND").fpsValue, "24");
});

test("23.976 offsets at 44.1 kHz round to the nearest sample", () => {
  const fps = parseFps("23.976");
  assert.throws(() => samplesForRate(divFrac(frac(1n), fpsRate(fps)), 44100));
  const oneFrame = assertRoundTrip("00:00:00:01", "23.976", 44100);
  assert.notEqual(oneFrame.exact.d, 1n);
  assert.equal(oneFrame.rounded, 1839n);
  assertRoundTrip("01:00:00:00", "23.976", 44100);
  assert.equal(framesToSamples(-1n, 44100, fps), -1839n);
});

test("one hour at 29.97 DF / 48 kHz is not an integer sample count", () => {
  const result = assertRoundTrip("01:00:00;00", "29.97df");
  assert.notEqual(result.exact.d, 1n);
  const ndfHour = framesToSamples(timecodeToFrames("01:00:00:00", parseFps("29.97")), 48000, parseFps("29.97"));
  assert.notEqual(result.rounded, ndfHour);
});

test("drop-frame timecodes round-trip through frames", () => {
  const fps = parseFps("29.97df");
  for (const timecode of ["00:00:00;00", "00:00:00;02", "00:01:00;02", "01:00:00;00", "10:00:00;00"]) {
    assert.equal(framesToTimecode(timecodeToFrames(timecode, fps), fps), timecode);
  }
});

test("offset preview uses rounded frame samples for a mixed-rate batch", async () => {
  const ui = {
    applyBtn: { disabled: true },
    undoBtn: { disabled: true },
    statusLine: { textContent: "" },
    fpsInput: { value: "29.97df" },
    offsetInput: { value: "01:00:00;00" },
  };
  let previews = [];
  const controller = createTimeReferenceWriteController({
    els: ui,
    getDirectoryHandle: () => null,
    getRecords: () => [
      { name: "ndf.wav", sampleRate: 48000, durationSamples: 48000n, oldTimeReference: 0n },
      { name: "df.wav", sampleRate: 48000, durationSamples: 48000n, oldTimeReference: 1000n },
    ],
    setRecords: () => {},
    getPreviews: () => previews,
    setPreviews: next => { previews = next; },
    getActiveOffset: () => null,
    setActiveOffset: () => {},
    getLastUndoBatch: () => null,
    setLastUndoBatch: () => {},
    getLtcResults: () => new Map(),
    shouldMuteLtc: () => false,
    setChangedTimeReferences: () => {},
    refreshTakeGroups: () => {},
    offsetInput: {
      parseOffset(raw, fps) {
        return { frames: timecodeToFrames(raw, fps), label: raw, fps, seconds: null };
      },
    },
    recordFpsValue: () => "29.97df",
    recordFpsSource: () => "ui",
    recordFpsDisplay: () => "29.97 DF",
    fpsSelectLabel: () => "29.97 DF",
    recordFps: () => parseFps("29.97df"),
    samplesToTimecode,
    confirmWriteChanges: async () => true,
    ensureWriteAccess: async () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    log: () => {},
    renderRows: () => {},
  });

  await controller.runPreview();
  const fps = parseFps("29.97df");
  const expected = framesToSamples(timecodeToFrames("01:00:00;00", fps), 48000, fps);
  assert.equal(previews.length, 2);
  assert.equal(previews[0].newTimeReference, expected);
  assert.equal(previews[1].newTimeReference, expected + 1000n);
  assert.equal(
    samplesToTimecode(previews[0].newTimeReference, 48000, fps, { precise: false, wrapDay: true }),
    "01:00:00;00",
  );
  assert.equal(ui.applyBtn.disabled, false);
});
