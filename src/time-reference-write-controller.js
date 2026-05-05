import {
  fpsLabel,
  parseFps,
  samplesForRate,
} from "./timecode.js";
import { scanWave } from "./wave.js";
import { muteLtcChannel as muteLtcChannelAudio } from "./wave-audio.js";
import {
  verifyIxmlTimeReference,
  writeTimeReference,
} from "./wave-time-reference.js";
import {
  formatDuration,
  manifestCsv as buildManifestCsv,
} from "./metadata-export.js";
import {
  recordKey,
  recordLabel,
} from "./grouping.js";

export function createTimeReferenceWriteController({
  els,
  getDirectoryHandle,
  getRecords,
  setRecords,
  getPreviews,
  setPreviews,
  getActiveOffset,
  setActiveOffset,
  getLastUndoBatch,
  setLastUndoBatch,
  getLtcResults,
  setChangedTimeReferences,
  refreshTakeGroups,
  offsetInput,
  recordFpsValue,
  recordFpsSource,
  recordFpsDisplay,
  fpsSelectLabel,
  recordFps,
  samplesToTimecode,
  confirmWriteChanges,
  setState,
  updateWriteProgress,
  log,
  renderRows,
}) {
  async function refreshRecordsFromHandles() {
    setRecords(await Promise.all(getRecords().map(record => scanWave(record.fileHandle, {
      relativePath: record.relativePath,
      parentPath: record.parentPath,
      parentHandle: record.parentHandle,
    }))));
    refreshTakeGroups();
  }

  async function runPreview() {
    els.applyBtn.disabled = true;
    setPreviews([]);
    setActiveOffset(null);
    renderRows();
    setState("预览中", "warn");
    els.statusLine.textContent = "Calculating shifted timecode...";

    const records = getRecords();
    const fallbackFps = parseFps(els.fpsInput.value);
    if (!records.length) throw new Error("请拖入文件夹或音频文件");

    const nextPreviews = [];
    let firstOffset = null;
    for (const record of records) {
      const fpsValue = recordFpsValue(record);
      const fps = parseFps(fpsValue);
      const offset = offsetInput.parseOffset(els.offsetInput.value, fps);
      if (!firstOffset) firstOffset = offset;
      const sampleOffset = samplesForRate(offset, record.sampleRate);
      const newTimeReference = record.oldTimeReference + sampleOffset;
      if (newTimeReference < 0n) {
        throw new Error(`${recordLabel(record)}: 减去该偏移后 TimeReference 会小于 0`);
      }
      const oldStartTc = samplesToTimecode(record.oldTimeReference, record.sampleRate, fps);
      const newStartTc = samplesToTimecode(newTimeReference, record.sampleRate, fps);
      const oldEndTc = samplesToTimecode(record.oldTimeReference + record.durationSamples, record.sampleRate, fps);
      const newEndTc = samplesToTimecode(newTimeReference + record.durationSamples, record.sampleRate, fps);
      nextPreviews.push({
        ...record,
        offset,
        sampleOffset,
        fps,
        fpsValue,
        fpsSource: recordFpsSource(record),
        fpsDisplay: recordFpsDisplay(record),
        newTimeReference,
        oldStartTc,
        newStartTc,
        oldEndTc,
        newEndTc,
        duration: formatDuration(record.durationSamples, record.sampleRate),
      });
    }

    setPreviews(nextPreviews);
    setActiveOffset(firstOffset);
    renderRows();
    els.applyBtn.disabled = false;
    setState("可写入");
    els.statusLine.textContent = `${nextPreviews.length} 个文件已生成修改预览`;
    log(`Preview OK: ${nextPreviews.length} files, per-file FPS from iXML where available, UI fallback ${fpsLabel(fallbackFps)}`);
  }

  async function writeManifestToFolder() {
    const directoryHandle = getDirectoryHandle();
    if (!directoryHandle) return null;
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "_",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const handle = await directoryHandle.getFileHandle(`timecode_fix_manifest_${stamp}.csv`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Blob([buildManifestCsv(getPreviews(), {
      fpsSelectLabel,
      recordFps,
      recordFpsSource,
      recordFpsValue,
      recordLabel,
      samplesToTimecode,
    })], { type: "text/csv;charset=utf-8" }));
    await writable.close();
    return handle.name;
  }

  async function muteLtcChannel(record, channelIndex, writable, progressBase, progressTotal) {
    return muteLtcChannelAudio(record, channelIndex, writable, progressBase, progressTotal, updateWriteProgress);
  }

  async function writeLtcTimecode() {
    const records = getRecords();
    const ltcResults = getLtcResults();
    const writableItems = records
      .map(record => ({ record, ltc: ltcResults.get(recordKey(record)) }))
      .filter(item => item.ltc?.ok);
    if (!writableItems.length) throw new Error("没有可写入的 LTC 识别结果");

    const ok = await confirmWriteChanges(writableItems.length, true);
    if (!ok) return;

    setState("LTC写入中", "warn");
    els.writeLtcBtn.disabled = true;
    els.extractLtcBtn.disabled = true;
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Writing LTC timecode...";
    updateWriteProgress("正在写入 LTC…", "", 0, writableItems.length);
    els.progressOverlay.classList.add("show");

    const undoBatch = writableItems.map(({ record }) => ({
      fileHandle: record.fileHandle,
      name: record.name,
      relativePath: record.relativePath,
      parentPath: record.parentPath,
      sampleRate: record.sampleRate,
      timeReferenceOffset: record.timeReferenceOffset,
      oldTimeReference: record.oldTimeReference,
      ixmlInfo: record.ixmlInfo,
    }));

    try {
      for (let i = 0; i < writableItems.length; i++) {
        const { record, ltc } = writableItems[i];
        const isSource = recordKey(record) === recordKey(ltc.sourceRecord);
        updateWriteProgress("正在写入 LTC…", recordLabel(record), i, writableItems.length);
        await writeTimeReference(record, ltc.newTimeReference);
        if (isSource) {
          const freshForMute = await scanWave(record.fileHandle, {
            relativePath: record.relativePath,
            parentPath: record.parentPath,
            parentHandle: record.parentHandle,
          });
          const writable = await record.fileHandle.createWritable({ keepExistingData: true });
          try {
            await muteLtcChannel(freshForMute, ltc.channelIndex, writable, i + 0.2, writableItems.length);
          } finally {
            await writable.close();
          }
        }
        ltc.ok = false;
        ltc.status = "ok";
        ltc.statusText = isSource
          ? `已写入；第 ${ltc.channelLabel} 轨已静音`
          : `已写入；LTC来自 ${ltc.sourceRecord.name}`;
        updateWriteProgress("正在写入 LTC…", record.name, i + 1, writableItems.length);
      }

      updateWriteProgress("正在校验…", "校验 LTC 写入结果", writableItems.length, writableItems.length);
      for (const { record, ltc } of writableItems) {
        const fresh = await scanWave(record.fileHandle);
        if (fresh.oldTimeReference !== ltc.newTimeReference) {
          throw new Error(`${recordLabel(record)}: LTC 写入校验失败`);
        }
        verifyIxmlTimeReference(fresh, ltc.newTimeReference, recordLabel(record));
      }

      setLastUndoBatch(undoBatch);
      els.undoBtn.disabled = false;
      setPreviews([]);
      setActiveOffset(null);
      els.applyBtn.disabled = true;
      setChangedTimeReferences(new Map(writableItems.map(({ record, ltc }) => [recordKey(record), ltc.newTimeReference])));
      await refreshRecordsFromHandles();
      renderRows();
      setState("完成");
      els.statusLine.textContent = `LTC 写入完成：${writableItems.length} 个文件`;
      log(`LTC Write OK: ${writableItems.length} files`);
      els.toast.textContent = `✅ LTC 写入完成 — ${writableItems.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, writableItems.length || 1);
      els.extractLtcBtn.disabled = getRecords().length === 0;
      els.writeLtcBtn.disabled = !Array.from(getLtcResults().values()).some(result => result.ok);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  async function applyChanges() {
    const previews = getPreviews();
    if (!previews.length) throw new Error("没有可写入的预览");
    const ok = await confirmWriteChanges(previews.length);
    if (!ok) return;

    const appliedPreviews = previews.slice();
    setState("写入中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Writing...";
    const undoBatch = appliedPreviews.map(preview => ({
      fileHandle: preview.fileHandle,
      name: preview.name,
      relativePath: preview.relativePath,
      parentPath: preview.parentPath,
      sampleRate: preview.sampleRate,
      timeReferenceOffset: preview.timeReferenceOffset,
      oldTimeReference: preview.oldTimeReference,
      ixmlInfo: preview.ixmlInfo,
    }));

    updateWriteProgress("正在写入…", "", 0, appliedPreviews.length);
    els.progressOverlay.classList.add("show");

    try {
      for (let i = 0; i < appliedPreviews.length; i++) {
        const preview = appliedPreviews[i];
        updateWriteProgress("正在写入…", preview.name, i, appliedPreviews.length);
        await writeTimeReference(preview, preview.newTimeReference);
        updateWriteProgress("正在写入…", preview.name, i + 1, appliedPreviews.length);
      }

      updateWriteProgress("正在校验…", "校验写入结果", appliedPreviews.length, appliedPreviews.length);

      for (const preview of appliedPreviews) {
        const fresh = await scanWave(preview.fileHandle);
        if (fresh.oldTimeReference !== preview.newTimeReference) {
          throw new Error(`${preview.name}: 校验失败`);
        }
        verifyIxmlTimeReference(fresh, preview.newTimeReference, preview.name);
      }

      let manifestName = null;
      try {
        updateWriteProgress("正在保存清单…", getDirectoryHandle() ? "生成 CSV manifest" : "已跳过清单", appliedPreviews.length, appliedPreviews.length);
        manifestName = await writeManifestToFolder();
      } catch (error) {
        log(`Manifest WARN: ${error.message}`);
      }

      setLastUndoBatch(undoBatch);
      els.undoBtn.disabled = false;
      setChangedTimeReferences(new Map(appliedPreviews.map(preview => [recordKey(preview), preview.newTimeReference])));
      setPreviews([]);
      setActiveOffset(null);
      await refreshRecordsFromHandles();
      renderRows();
      setState("完成");
      els.statusLine.textContent = manifestName ? `写入完成；清单：${manifestName}` : "写入完成";
      log(`Write OK: ${appliedPreviews.length} files${manifestName ? `; ${manifestName}` : ""}`);

      els.toast.textContent = manifestName
        ? `✅ 写入完成 — ${appliedPreviews.length} 个文件，已保存清单`
        : `✅ 写入完成 — ${appliedPreviews.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, appliedPreviews.length || 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  async function undoLastWrite() {
    const lastUndoBatch = getLastUndoBatch();
    if (!lastUndoBatch) throw new Error("没有可撤销的写入记录");

    setState("撤销中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Undoing...";
    updateWriteProgress("正在撤销…", "", 0, lastUndoBatch.length);
    els.progressOverlay.classList.add("show");

    try {
      for (let i = 0; i < lastUndoBatch.length; i++) {
        const item = lastUndoBatch[i];
        updateWriteProgress("正在撤销…", item.name, i, lastUndoBatch.length);
        await writeTimeReference(item, item.oldTimeReference);
        updateWriteProgress("正在撤销…", item.name, i + 1, lastUndoBatch.length);
      }

      updateWriteProgress("正在校验…", "校验撤销结果", lastUndoBatch.length, lastUndoBatch.length);
      for (const item of lastUndoBatch) {
        const fresh = await scanWave(item.fileHandle);
        if (fresh.oldTimeReference !== item.oldTimeReference) {
          throw new Error(`${item.name}: 撤销校验失败`);
        }
        verifyIxmlTimeReference(fresh, item.oldTimeReference, item.name);
      }

      setLastUndoBatch(null);
      setPreviews([]);
      setActiveOffset(null);
      setChangedTimeReferences(new Map());
      await refreshRecordsFromHandles();
      renderRows();
      setState("已撤销");
      els.statusLine.textContent = "已撤销上一次写入，显示已刷新";
      log("Undo OK: reverted last write");

      els.toast.textContent = "↩ 撤销完成";
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 3500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  return {
    applyChanges,
    refreshRecordsFromHandles,
    runPreview,
    undoLastWrite,
    writeLtcTimecode,
  };
}
