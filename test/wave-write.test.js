import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTimeReferenceWriteController } from "../src/time-reference-write-controller.js";
import { ixmlTimeReferenceValue, scanWave } from "../src/wave.js";
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

test("importing more files does not clear an unused undo batch", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("clearAfterImportState:");
  const end = html.indexOf("getLastUndoBatch:", start);
  const block = html.slice(start, end);
  assert.equal(block.includes("lastUndoBatch"), false);
});
