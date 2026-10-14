import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTimeReferenceWriteController } from "../src/time-reference-write-controller.js";
import { ds64ChunkData, ixmlTimeReferenceValue, listWaveChunks, scanWave } from "../src/wave.js";
import { writeTimeReference } from "../src/wave-time-reference.js";
import { memoryWavHandle, wavBytes } from "../test-support/wav-fixture.js";

async function dataBytes(handle) {
  const scanned = await scanWave(handle);
  const file = await handle.getFile();
  return new Uint8Array(await file.slice(scanned.dataOffset, scanned.dataOffset + scanned.dataSize).arrayBuffer());
}

test("bext and iXML time references round-trip in place", async () => {
  const original = wavBytes({ bext: true, ixml: true, timeReference: 0n });
  const handle = memoryWavHandle(original, "inplace.wav");
  const before = await dataBytes(handle);
  await writeTimeReference({ fileHandle: handle }, 172799827n);
  const after = await scanWave(handle);
  assert.equal(after.oldTimeReference, 172799827n);
  assert.equal(ixmlTimeReferenceValue(after.ixmlInfo), 172799827n);
  assert.deepEqual(await dataBytes(handle), before);
  assert.equal(handle.bytes().length, original.length);
  assert.ok(handle.calls.includes("close"));
  assert.ok(!handle.calls.includes("abort"));
});

test("a successful rewrite keeps the audio payload", async () => {
  const handle = memoryWavHandle(wavBytes({ ixml: true, timeReference: 0n }), "rewrite.wav");
  const before = await dataBytes(handle);
  await writeTimeReference({ fileHandle: handle }, 48048n);
  const after = await scanWave(handle);
  assert.equal(after.hasBext, true);
  assert.equal(after.oldTimeReference, 48048n);
  assert.equal(ixmlTimeReferenceValue(after.ixmlInfo), 48048n);
  assert.deepEqual(await dataBytes(handle), before);
  assert.ok(handle.calls.includes("close"));
  assert.ok(!handle.calls.includes("abort"));
});

test("a failure after truncate aborts and leaves the original WAV intact", async () => {
  const original = wavBytes({ samples: 128 });
  const handle = memoryWavHandle(original, "truncated.wav", { failOnTruncate: true });
  await assert.rejects(
    writeTimeReference({ fileHandle: handle }, 48048n),
    /injected truncate failure/,
  );
  assert.deepEqual(handle.bytes(), original);
  assert.ok(handle.calls.includes("truncate"));
  assert.ok(handle.calls.includes("abort"));
  assert.ok(!handle.calls.includes("close"));
});

test("a mid-rewrite write failure does not replace the original file", async () => {
  const original = wavBytes({ samples: 128 });
  const handle = memoryWavHandle(original, "partial.wav", { failOnWrite: 3 });
  await assert.rejects(
    writeTimeReference({ fileHandle: handle }, 48048n),
    /injected write failure/,
  );
  assert.deepEqual(handle.bytes(), original);
  assert.ok(handle.calls.includes("abort"));
  assert.ok(!handle.calls.includes("close"));
});

test("a failed file in a batch keeps undo for the files already written", async () => {
  const first = memoryWavHandle(wavBytes({ bext: true, ixml: true }), "first.wav");
  const secondOriginal = wavBytes({ bext: true, ixml: true });
  const second = memoryWavHandle(secondOriginal, "second.wav", {
    onCreateWritable() {
      throw new Error("injected second-file failure");
    },
  });
  const firstPreview = { ...await scanWave(first), newTimeReference: 48048n };
  const secondPreview = { ...await scanWave(second), newTimeReference: 48048n };
  let undo = null;
  const ui = {
    applyBtn: { disabled: false },
    undoBtn: { disabled: true },
    statusLine: { textContent: "" },
    progressOverlay: { classList: { add() {}, remove() {} } },
    toast: { classList: { add() {}, remove() {} }, textContent: "" },
  };
  const controller = createTimeReferenceWriteController({
    els: ui,
    getDirectoryHandle: () => null,
    getRecords: () => [firstPreview, secondPreview],
    setRecords: () => {},
    getPreviews: () => [firstPreview, secondPreview],
    setPreviews: () => {},
    getActiveOffset: () => null,
    setActiveOffset: () => {},
    getLastUndoBatch: () => undo,
    setLastUndoBatch: next => { undo = next; },
    getLtcResults: () => new Map(),
    shouldMuteLtc: () => false,
    setChangedTimeReferences: () => {},
    refreshTakeGroups: () => {},
    offsetInput: {},
    recordFpsValue: () => "24",
    recordFpsSource: () => "ui",
    recordFpsDisplay: () => "24",
    fpsSelectLabel: () => "24",
    recordFps: () => null,
    samplesToTimecode: () => "",
    confirmWriteChanges: async () => true,
    ensureWriteAccess: async () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    log: () => {},
    renderRows: () => {},
  });

  await assert.rejects(controller.applyChanges(), /injected second-file failure/);
  assert.equal(undo.length, 1);
  assert.equal(undo[0].name, "first.wav");
  assert.equal(undo[0].oldTimeReference, 0n);
  assert.equal((await scanWave(first)).oldTimeReference, 48048n);
  assert.deepEqual(second.bytes(), secondOriginal);
  assert.equal(ui.undoBtn.disabled, false);
});

test("bext 0 is kept when iXML disagrees, and the disagreement is visible", async () => {
  const disagreed = wavBytes({ bext: true, ixml: true, timeReference: 0n, ixmlTimeReference: 48000n });
  const scanned = await scanWave(memoryWavHandle(disagreed, "disagree.wav"));
  assert.equal(scanned.oldTimeReference, 0n);
  assert.equal(scanned.timeReferenceConflict.bext, 0n);
  assert.equal(scanned.timeReferenceConflict.ixml, 48000n);

  const agreed = await scanWave(memoryWavHandle(wavBytes({ bext: true, ixml: true, timeReference: 0n }), "agree.wav"));
  assert.equal(agreed.timeReferenceConflict, null);
  const ixmlOnly = await scanWave(memoryWavHandle(wavBytes({ ixml: true, ixmlTimeReference: 48000n }), "ixml.wav"));
  assert.equal(ixmlOnly.oldTimeReference, 48000n);
  assert.equal(ixmlOnly.timeReferenceConflict, null);
});

test("a full rewrite keeps the iXML BOM and non-UTF-8 bytes", async () => {
  const ascii = text => Uint8Array.from(text, char => char.charCodeAt(0));
  const payload = concatBytes([
    new Uint8Array([0xef, 0xbb, 0xbf]),
    ascii(`<?xml version="1.0" encoding="UTF-8"?><BWFXML><SPEED><TIMESTAMP_SAMPLE_RATE>48000</TIMESTAMP_SAMPLE_RATE><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>0</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>0000000000</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO></SPEED><NOTE>`),
    new Uint8Array([0xff]),
    ascii("</NOTE></BWFXML>"),
  ]);
  const handle = memoryWavHandle(wavBytes({ ixml: true, ixmlPayload: payload }), "bom.wav");
  await writeTimeReference({ fileHandle: handle }, 48048n);
  const after = await scanWave(handle);
  const file = await handle.getFile();
  const ixml = new Uint8Array(await file.slice(after.ixmlInfo.chunkStart, after.ixmlInfo.chunkStart + after.ixmlInfo.chunkSize).arrayBuffer());
  assert.deepEqual(Array.from(ixml.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.ok(ixml.includes(0xff));
  assert.equal(ixmlTimeReferenceValue(after.ixmlInfo), 48048n);
  assert.equal(after.oldTimeReference, 48048n);
});

test("a full rewrite keeps ds64 extension table entries", async () => {
  const regn = Uint8Array.from("REGION-DATA!", char => char.charCodeAt(0));
  const original = rf64WithExtensionTable(regn);
  const handle = memoryWavHandle(original, "rf64.wav");
  const beforeData = await dataBytes(handle);
  await writeTimeReference({ fileHandle: handle }, 48048n);
  const after = await scanWave(handle);
  const file = await handle.getFile();
  const listed = await listWaveChunks(file, "rf64.wav");
  assert.equal(listed.ds64.table.get("regn"), BigInt(regn.length));
  assert.equal(listed.ds64.table.get("fmt "), 16n);
  assert.equal(after.oldTimeReference, 48048n);
  assert.deepEqual(await dataBytes(handle), beforeData);
});

function concatBytes(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function rf64WithExtensionTable(regnPayload) {
  const fmt = new Uint8Array(16);
  const fmtView = new DataView(fmt.buffer);
  fmtView.setUint16(0, 1, true);
  fmtView.setUint16(2, 1, true);
  fmtView.setUint32(4, 48000, true);
  fmtView.setUint32(8, 96000, true);
  fmtView.setUint16(12, 2, true);
  fmtView.setUint16(14, 16, true);
  const data = new Uint8Array(128);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff;
  const ds64 = ds64ChunkData({
    riffSize: 0n,
    dataSize: BigInt(data.length),
    sampleCount: BigInt(data.length / 2),
    table: [
      { id: "fmt ", size: 16n },
      { id: "regn", size: BigInt(regnPayload.length) },
    ],
  });
  const body = concatBytes([
    chunkBytes("ds64", ds64),
    chunkBytes("fmt ", fmt),
    chunkBytes("regn", regnPayload, 0xffffffff),
    chunkBytes("data", data),
  ]);
  const out = new Uint8Array(12 + body.length);
  out.set(Uint8Array.from("RF64", char => char.charCodeAt(0)), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 0xffffffff, true);
  out.set(Uint8Array.from("WAVE", char => char.charCodeAt(0)), 8);
  out.set(body, 12);
  view.setBigUint64(20, BigInt(out.length - 8), true);
  return out;
}

function chunkBytes(id, payload, size32 = payload.length) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(Uint8Array.from(id, char => char.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, size32, true);
  out.set(payload, 8);
  return out;
}

test("importing more files does not clear an unused undo batch", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("clearAfterImportState:");
  const end = html.indexOf("getLastUndoBatch:", start);
  const block = html.slice(start, end);
  assert.equal(block.includes("lastUndoBatch"), false);
});
