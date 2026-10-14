import assert from "node:assert/strict";
import test from "node:test";
import { createFpsWriteController } from "../src/fps-write-controller.js";
import { bextAspeedToFpsValue } from "../src/timecode.js";
import { scanWave } from "../src/wave.js";
import { memoryWavHandle, wavBytes } from "../test-support/wav-fixture.js";

const IXML = `<?xml version="1.0" encoding="UTF-8"?><BWFXML><SPEED><TIMECODE_RATE>24/1</TIMECODE_RATE><TIMECODE_FLAG>NDF</TIMECODE_FLAG><TIMESTAMP_SAMPLE_RATE>48000</TIMESTAMP_SAMPLE_RATE><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI>0</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_HI><TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO>0000000000</TIMESTAMP_SAMPLES_SINCE_MIDNIGHT_LO></SPEED></BWFXML>`;

test("an iXML failure after aSPEED still keeps undo for the aSPEED change", async () => {
  let opened = 0;
  const handle = memoryWavHandle(wavBytes({
    bext: true,
    ixml: true,
    bextDescription: "aSPEED=024.000-ND\r\n",
    ixmlPayload: Uint8Array.from(IXML, char => char.charCodeAt(0)),
  }), "fps.wav", {
    onCreateWritable() {
      opened += 1;
      if (opened === 2) throw new Error("injected ixml failure");
    },
  });
  const record = await scanWave(handle);
  const preview = {
    ...record,
    operation: "fps-metadata",
    fpsWillWrite: true,
    fpsTargetValue: "25",
    fpsTargetLabel: "25.00 FPS",
    fpsWriteIxml: true,
    createIxml: false,
    fpsWriteAspeed: true,
    createAspeed: false,
  };
  let undo = null;
  const ui = {
    applyBtn: { disabled: false },
    undoBtn: { disabled: true },
    statusLine: { textContent: "" },
    progressOverlay: { classList: { add() {}, remove() {} } },
    toast: { classList: { add() {}, remove() {} }, textContent: "" },
  };
  const controller = createFpsWriteController({
    els: ui,
    getRecords: () => [preview],
    getSelectedRecordKeys: () => new Set(),
    getPreviews: () => [preview],
    setPreviews: () => {},
    setActiveOffset: () => {},
    getLastUndoBatch: () => undo,
    setLastUndoBatch: next => { undo = next; },
    recordFps: () => null,
    recordFpsDisplay: () => "",
    fpsSelectLabel: () => "",
    samplesToTimecode: () => "",
    showConfirmDialog: async () => true,
    loosePermissionNote: () => "",
    ensureWriteAccess: async () => {},
    refreshRecordsFromHandles: async () => {},
    setChangedTimeReferences: () => {},
    setState: () => {},
    updateWriteProgress: () => {},
    renderRows: () => {},
    log: () => {},
  });

  await assert.rejects(controller.applyChanges(), /injected ixml failure/);
  assert.equal(undo?.type, "fps-metadata");
  assert.equal(undo.items.length, 1);
  assert.equal(undo.items[0].wroteAspeed, true);
  assert.equal(undo.items[0].wroteIxml, false);
  assert.equal(bextAspeedToFpsValue((await scanWave(handle)).bextInfo), "25");
  assert.equal(ui.undoBtn.disabled, false);

  await controller.undoLastWrite();
  assert.equal(bextAspeedToFpsValue((await scanWave(handle)).bextInfo), "24");
  assert.equal(undo, null);
});
