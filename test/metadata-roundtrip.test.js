import assert from "node:assert/strict";
import test from "node:test";
import { parseMetadataImport } from "../src/metadata-import.js";
import {
  aleMetadataText,
  resolveFpsLabel,
  resolveFullAleText,
  resolveFullMetadataCsv,
  resolveMetadataCsv,
  utf16LeCsvBlob,
} from "../src/metadata-export.js";
import {
  framesToSamples,
  parseFps,
  samplesToTimecode,
  timecodeToFrames,
} from "../src/timecode.js";

const options = {
  samplesToTimecode,
  recordLabel: record => record.name,
};

function startSamples(fpsValue, timecode = "01:00:00;00") {
  const fps = parseFps(fpsValue);
  return framesToSamples(timecodeToFrames(timecode, fps), 48000, fps);
}

function item(fpsValue, timecode = "01:00:00;00") {
  const fps = parseFps(fpsValue);
  return {
    record: {
      name: "A001.wav",
      parentPath: "card",
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 24,
      durationSamples: 48048n,
      audioFormat: 1,
    },
    newTimeReference: startSamples(fpsValue, timecode),
    fps,
    fpsValue,
    description: "offset",
  };
}

async function csvText(csv) {
  const bytes = new Uint8Array(await utf16LeCsvBlob(csv).arrayBuffer());
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xfe);
  return new TextDecoder("utf-16le").decode(bytes.subarray(2));
}

test("FPS labels keep a drop-frame marker and non-drop rates stay numeric", () => {
  assert.equal(resolveFpsLabel("29.97df"), "29.97 DF");
  assert.equal(resolveFpsLabel("59.94df"), "59.94 DF");
  assert.equal(resolveFpsLabel("29.97"), "29.970");
  assert.equal(resolveFpsLabel("24"), "24.000");
});

test("exported 29.97 DF timecode re-imports as drop frame", async () => {
  const df = item("29.97df");
  const expected = df.newTimeReference;
  const skewed = startSamples("29.97", "01:00:00:00");
  assert.notEqual(expected, skewed);

  const exports = [
    ["take.csv", await csvText(resolveMetadataCsv([df], options))],
    ["take.csv", await csvText(resolveFullMetadataCsv([df], options))],
    ["take.ale", aleMetadataText([df], "29.97df", options)],
    ["take.ale", resolveFullAleText([df], "29.97df", options)],
  ];

  for (const [suffix, text] of exports) {
    assert.match(text, /01:00:00;00/);
    assert.match(text, /29\.97 DF/);
    const [record] = parseMetadataImport(text, suffix);
    assert.equal(record._meta.fpsValue, "29.97df", suffix);
    assert.equal(record.oldTimeReference, expected, suffix);
  }
});

test("a numeric FPS cell still imports as drop frame when the timecode uses a semicolon", () => {
  const cases = [
    ["29.970", "01:00:00;00", "29.97df"],
    ["59.940", "01:00:00;00", "59.94df"],
    ["119.880", "01:00:00;00", "119.88df"],
  ];
  for (const [fpsCell, timecode, fpsValue] of cases) {
    const csv = [
      "File Name,Shot Frame Rate,Start TC,Duration TC,Audio Sample Rate",
      `A001.wav,${fpsCell},${timecode},00:00:01:00,48000`,
    ].join("\n");
    const [record] = parseMetadataImport(csv, "old.csv");
    assert.equal(record._meta.fpsValue, fpsValue, fpsCell);
    assert.equal(record.oldTimeReference, startSamples(fpsValue, timecode), fpsCell);
  }
});

test("colon timecode at 29.970 stays non-drop", () => {
  const csv = [
    "File Name,Shot Frame Rate,Start TC,Duration TC,Audio Sample Rate",
    "A001.wav,29.970,01:00:00:00,00:00:01:00,48000",
  ].join("\n");
  const [record] = parseMetadataImport(csv, "ndf.csv");
  assert.equal(record._meta.fpsValue, "29.97");
  assert.equal(record.oldTimeReference, startSamples("29.97", "01:00:00:00"));
});

test("non-drop export still uses colons and re-imports as non-drop", async () => {
  const ndf = item("29.97", "01:00:00:00");
  const text = await csvText(resolveMetadataCsv([ndf], options));
  assert.match(text, /01:00:00:00/);
  assert.doesNotMatch(text, /;/);
  const [record] = parseMetadataImport(text, "ndf.csv");
  assert.equal(record._meta.fpsValue, "29.97");
  assert.equal(record.oldTimeReference, ndf.newTimeReference);
});
