import {
  safeWaveBaseName,
  writeCombinedPolyToWritable,
} from "./wave-combine.js";
import { shortGroupLabel } from "./grouping.js";

export function createPolyCombineController({
  els,
  combineEligibleGroups,
  confirmCombinePoly,
  groupLabel,
  setState,
  updateWriteProgress,
  log,
}) {
  async function writeCombinedPolyFile(key, groupRecords, progressBase = 0, progressTotal = 1) {
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
      groupLabel,
      onProgress: updateWriteProgress,
    });
  }

  async function writeCombinedPolyToDirectory(directory, key, groupRecords, progressBase = 0, progressTotal = 1) {
    const groupName = safeWaveBaseName(shortGroupLabel(key));
    const outputName = `${groupName}_Poly.WAV`;
    const handle = await directory.getFileHandle(outputName, { create: true });
    const writable = await handle.createWritable();
    return writeCombinedPolyToWritable(key, groupRecords, writable, outputName, {
      progressBase,
      progressTotal,
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
    const ok = await confirmCombinePoly(groups);
    if (!ok) return;
    let batchDirectory = null;
    if (groups.length > 1) {
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
    updateWriteProgress("正在合并 Poly…", "", 0, groups.length);
    els.progressOverlay.classList.add("show");

    const results = [];
    try {
      for (let i = 0; i < groups.length; i++) {
        const [key, groupRecords] = groups[i];
        updateWriteProgress("正在合并 Poly…", shortGroupLabel(key), i, groups.length);
        const result = groups.length > 1
          ? await writeCombinedPolyToDirectory(batchDirectory, key, groupRecords, i, groups.length)
          : await writeCombinedPolyFile(key, groupRecords, i, groups.length);
        results.push(result);
        updateWriteProgress("正在合并 Poly…", result.name, i + 1, groups.length);
      }
      setState("完成");
      els.statusLine.textContent = `Poly 合并完成：${results.length} 个文件`;
      log(`Combine Poly OK: ${results.map(result => `${result.name} (${result.channels}ch)`).join(", ")}`);
      els.toast.textContent = `✅ Poly 合并完成 — ${results.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, groups.length || 1);
      els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    }
  }

  return {
    combinePolyFiles,
  };
}
