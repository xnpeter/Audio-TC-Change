import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWebAudioSampleRate,
  containerAudioSampleRate,
  ensureVideoAudioForLtc,
  scanVideo,
  videoImportNeedsAudioDecode,
} from "../src/video.js";
import { movBytes } from "../test-support/mov-fixture.js";

const container = {
  startTc: "01:00:00:00",
  audioCodec: "lpcm",
  tracks: [
    { handlerType: "soun", sampleType: "lpcm", audioSampleRate: 48000, channels: 2 },
    { handlerType: "soun", sampleType: "lpcm", audioSampleRate: 48000, channels: 2 },
    { handlerType: "tmcd", sampleType: "tmcd" },
  ],
};

test("video import does not decode audio when the container already has timecode", () => {
  assert.equal(videoImportNeedsAudioDecode(container), false);
  assert.equal(containerAudioSampleRate(container), 48000);
  assert.equal(videoImportNeedsAudioDecode({ ...container, startTc: "" }), true);
  assert.equal(videoImportNeedsAudioDecode({ audioCodec: "" }), false);
});

test("Web Audio fallback refuses a device sample rate that is not the file rate", () => {
  assert.throws(
    () => assertWebAudioSampleRate("clip.mov", 44100, 48000),
    /44100 Hz/,
  );
  assert.throws(
    () => assertWebAudioSampleRate("clip.mov", 48000, null),
    /原始采样率/,
  );
  assert.equal(assertWebAudioSampleRate("clip.mov", 48000, 48000), 48000);
});

function mockVideoElement(t) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      removeAttribute() {}, load() {},
      set src(value) { queueMicrotask(() => this.onerror()); },
    }),
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
}

test("container timecode defers PCM reads until LTC extraction, then caches them", async t => {
  mockVideoElement(t);
  let audioReads = 0;
  class CountedFile extends File {
    slice(start, end) {
      if (start === 12 && end === 140) audioReads += 1;
      return super.slice(start, end);
    }
  }
  const file = new CountedFile([movBytes()], "timecoded.mov");
  const record = await scanVideo({ getFile: async () => file });
  assert.equal(record._video.startTc, "01:00:00:00");
  assert.equal(audioReads, 0);
  assert.equal(record.dataSize, 0);
  const originalReference = record.oldTimeReference;
  await Promise.all([ensureVideoAudioForLtc(record), ensureVideoAudioForLtc(record)]);
  assert.equal(audioReads, 1);
  assert.equal(record.sampleRate, 48000);
  assert.equal(record.channels, 1);
  assert.equal(record.blockAlign, 4);
  assert.equal(record.dataSize, 256);
  assert.equal(record.durationSamples, 64n);
  assert.equal(record.oldTimeReference, originalReference);
  assert.equal(record._video.audioDecodeSkipped, false);
  const samples = new Float32Array(await record.file.arrayBuffer());
  assert.equal(samples[32], 0.25);
  await ensureVideoAudioForLtc(record);
  assert.equal(audioReads, 1);
});

test("a failed deferred decode reports an error and can be retried", async t => {
  mockVideoElement(t);
  const originalWindow = globalThis.window;
  globalThis.window = {};
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  let fail = true;
  class FailingFile extends File {
    slice(start, end) {
      if (fail && start === 12 && end === 140) throw new Error("injected read failure");
      return super.slice(start, end);
    }
  }
  const file = new FailingFile([movBytes()], "retry.mov");
  const record = await scanVideo({ getFile: async () => file });
  await assert.rejects(ensureVideoAudioForLtc(record), /Web Audio/);
  assert.ok(record._video.audioDecodeError);
  assert.equal(record._video.audioDecodeSkipped, true);
  assert.equal(record.dataSize, 0);
  fail = false;
  await ensureVideoAudioForLtc(record);
  assert.equal(record._video.audioDecodeError, "");
  assert.equal(record.dataSize, 256);
});
