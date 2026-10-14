import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWebAudioSampleRate,
  containerAudioSampleRate,
  videoImportNeedsAudioDecode,
} from "../src/video.js";

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
