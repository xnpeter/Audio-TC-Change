import {
  safeWaveBaseName,
  writeCombinedPolyToWritable,
} from "./wave-combine.js";
import { recordKey, shortGroupLabel } from "./grouping.js";

export function createPolyCombineController({
  els,
  combineEligibleGroups,
  confirmCombinePoly,
  getPreviews,
  getLtcResults,
  shouldMuteLtc,
  groupLabel,
  getFpsValue,
  setCombinedPolyKeys,
  setState,
  updateWriteProgress,
  log,
  renderRows,
}) {
  function previewMapForGroups(groups) {
    const previews = getPreviews?.() || [];
    const previewMap = new Map(previews.map(preview => [recordKey(preview), preview]));
    const groupKeys = new Set(groups.flatMap(([, groupRecords]) => groupRecords.map(record => recordKey(record))));
    const hasPreviewTimecode = previews.some(preview => groupKeys.has(recordKey(preview)) && preview.newTimeReference !== undefined);
    return { previewMap, hasPreviewTimecode };
  }

  function ltcMapForGroups(groups) {
    const ltcResults = getLtcResults?.() || new Map();
    const groupRecords = groups.flatMap(([, records]) => records);
    const hasLtcTimecode = groupRecords.length > 0 && groupRecords.every(record => {
      const ltc = ltcResults.get(recordKey(record));
      return ltc?.ok && ltc.newTimeReference !== undefined && ltc.newTimeReference !== null;
    });
    return { ltcMap: ltcResults, hasLtcTimecode };
  }

  function recordsWithPreviewTimecode(groups, previewMap) {
    return groups.map(([key, groupRecords]) => {
      const nextRecords = groupRecords.map(record => {
        const preview = previewMap.get(recordKey(record));
        if (!preview || preview.newTimeReference === undefined) {
          throw new Error(`${groupLabel(record)}: 这个分轨没有当前时码预览，不能用预览时码合成 Poly`);
        }
        return {
          ...record,
          oldTimeReference: preview.newTimeReference,
          ixmlInfo: preview.ixmlInfo || record.ixmlInfo,
        };
      });
      const first = nextRecords[0]?.oldTimeReference;
      if (!nextRecords.every(record => record.oldTimeReference === first)) {
        throw new Error(`${groupLabel(nextRecords[0])}: 同一 take 的预览后起始时码不一致，不能合成 Poly`);
      }
      return [key, nextRecords];
    });
  }

  function recordsWithLtcTimecode(groups, ltcMap) {
    return groups.map(([key, groupRecords]) => {
      const nextRecords = groupRecords.map(record => {
        const ltc = ltcMap.get(recordKey(record));
        if (!ltc?.ok || ltc.newTimeReference === undefined || ltc.newTimeReference === null) {
          throw new Error(`${groupLabel(record)}: 这个分轨没有可用的 LTC 时码，不能用 LTC 时码合成 Poly`);
        }
        return {
          ...record,
          oldTimeReference: ltc.newTimeReference,
        };
      });
      const first = nextRecords[0]?.oldTimeReference;
      if (!nextRecords.every(record => record.oldTimeReference === first)) {
        throw new Error(`${groupLabel(nextRecords[0])}: 同一 take 的 LTC 起始时码不一致，不能合成 Poly`);
      }
      return [key, nextRecords];
    });
  }

  function mutedLtcChannelsForGroups(groups, ltcMap) {
    const muted = new Set();
    for (const [, groupRecords] of groups) {
      for (const record of groupRecords) {
        const ltc = ltcMap.get(recordKey(record));
        if (ltc?.ok && ltc.sourceRecord && ltc.channelIndex !== undefined && ltc.channelIndex !== null) {
          muted.add(`${recordKey(ltc.sourceRecord)}:${ltc.channelIndex}`);
        }
      }
    }
    return muted;
  }

  async function writeCombinedPolyFile(key, groupRecords, mutedSourceChannels, progressBase = 0, progressTotal = 1) {
    if (!("showSaveFilePicker" in window)) throw new Error("当前浏览器不支持直接保存 Poly WAV；请使用 Chrome / Edge");
    const groupName = safeWaveBaseName(shortGroupLabel(key));
    const handle = await window.showSaveFilePicker({
      suggestedName: `${groupName}_Poly.WAV`,
      types: [{
        description: "Wave Audio",
        accept: { "audio/wav": [".wav"] },
      }],
    });
    const writable = await handle.createWritable();
    return writeCombinedPolyToWritable(key, groupRecords, writable, handle.name, {
      progressBase,
      progressTotal,
      fallbackFpsValue: getFpsValue?.(),
      mutedSourceChannels,
      groupLabel,
      onProgress: updateWriteProgress,
    });
  }

  async function writeCombinedPolyToDirectory(directory, key, groupRecords, mutedSourceChannels, progressBase = 0, progressTotal = 1) {
    const groupName = safeWaveBaseName(shortGroupLabel(key));
    const outputName = `${groupName}_Poly.WAV`;
    const handle = await directory.getFileHandle(outputName, { create: true });
    const writable = await handle.createWritable();
    return writeCombinedPolyToWritable(key, groupRecords, writable, outputName, {
      progressBase,
      progressTotal,
      fallbackFpsValue: getFpsValue?.(),
      mutedSourceChannels,
      groupLabel,
      onProgress: updateWriteProgress,
    });
  }

  async function combinePolyFiles() {
    const groups = combineEligibleGroups();
    if (!groups.length) throw new Error("没有识别到可合并的分轨 take");
    if (groups.length > 1 && !("showDirectoryPicker" in window)) {
      throw new Error("当前浏览器不支持批量选择输出目录；请使用 Chrome / Edge，或逐个保存");
    }
    const { previewMap, hasPreviewTimecode } = previewMapForGroups(groups);
    const { ltcMap, hasLtcTimecode } = ltcMapForGroups(groups);
    const muteLtc = hasLtcTimecode && shouldMuteLtc?.() !== false;
    const choice = await confirmCombinePoly(groups, { hasPreviewTimecode, hasLtcTimecode, muteLtc });
    if (!choice) return;
    const groupsToWrite = choice === "preview"
      ? recordsWithPreviewTimecode(groups, previewMap)
      : choice === "ltc"
        ? recordsWithLtcTimecode(groups, ltcMap)
        : groups;
    const mutedSourceChannels = muteLtc ? mutedLtcChannelsForGroups(groups, ltcMap) : new Set();
    let batchDirectory = null;
    if (groupsToWrite.length > 1) {
      try {
        batchDirectory = await window.showDirectoryPicker({ mode: "readwrite" });
      } catch (error) {
        if (error.name === "AbortError") return;
        throw new Error("无法使用这个输出文件夹。Chrome 不允许网页直接写入某些受保护的常用文件夹（如“下载”“文稿”“桌面”本身）；请在其中新建并选择一个子文件夹，例如 Downloads/AudioTCChange_Poly。");
      }
    }

    setState("合并中", "warn");
    els.combinePolyBtn.disabled = true;
    els.statusLine.textContent = "Combining split tracks...";
    updateWriteProgress("正在合并 Poly…", "", 0, groupsToWrite.length);
    els.progressOverlay.classList.add("show");

    const results = [];
    try {
      for (let i = 0; i < groupsToWrite.length; i++) {
        const [key, groupRecords] = groupsToWrite[i];
        updateWriteProgress("正在合并 Poly…", shortGroupLabel(key), i, groupsToWrite.length);
        const result = groupsToWrite.length > 1
          ? await writeCombinedPolyToDirectory(batchDirectory, key, groupRecords, mutedSourceChannels, i, groupsToWrite.length)
          : await writeCombinedPolyFile(key, groupRecords, mutedSourceChannels, i, groupsToWrite.length);
        results.push(result);
        updateWriteProgress("正在合并 Poly…", result.name, i + 1, groupsToWrite.length);
      }
      const stateLabel = choice === "preview" || choice === "ltc" ? "已更改并合并" : "已合并";
      setState(stateLabel);
      const allRecordKeys = new Set(
        groupsToWrite.flatMap(([, groupRecords]) => groupRecords.map(record => recordKey(record)))
      );
      setCombinedPolyKeys(allRecordKeys);
      renderRows();
      els.statusLine.textContent = `Poly 合并完成：${results.length} 个文件`;
      const timecodeNote = choice === "preview"
        ? "; used preview timecode"
        : choice === "ltc"
          ? "; used LTC timecode"
          : "";
      const muteNote = mutedSourceChannels.size ? "; muted LTC track" : "";
      log(`Combine Poly OK: ${results.map(result => `${result.name} (${result.channels}ch)`).join(", ")}${timecodeNote}${muteNote}`);
      els.toast.textContent = `✅ Poly 合并完成 — ${results.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, groupsToWrite.length || 1);
      els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    }
  }

  return {
    combinePolyFiles,
  };
}
