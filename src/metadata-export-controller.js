import {
  aleMetadataText,
  resolveMetadataCsv,
  utf16LeCsvBlob,
} from "./metadata-export.js";

function timestampForFilename() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
}

async function saveBlob(blob, suggestedName, pickerType = null) {
  if ("showSaveFilePicker" in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [pickerType || {
        description: "CSV",
        accept: { "text/csv": [".csv"] },
      }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return handle.name;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return suggestedName;
}

export function createMetadataExportController({
  els,
  chooseMetadataFormat,
  getPreviews,
  getRecords,
  getLtcResults,
  parseFps,
  recordKey,
  recordFpsValue,
  recordLabel,
  samplesToTimecode,
  setState,
  log,
}) {
  function resolveMetadataItems() {
    const previews = getPreviews();
    if (previews.length) {
      return previews.map(preview => ({
        record: preview,
        newTimeReference: preview.newTimeReference,
        fps: preview.fps || parseFps(recordFpsValue(preview)),
        fpsValue: preview.fpsValue || recordFpsValue(preview),
        source: "offset",
        description: `Audio TC Change offset ${preview.offset?.label || ""}`.trim(),
      }));
    }

    const ltcResults = getLtcResults();
    return getRecords()
      .map(record => {
        const ltc = ltcResults.get(recordKey(record));
        if (ltc?.newTimeReference == null || !ltc?.timecode) return null;
        return {
          record,
          newTimeReference: ltc.newTimeReference,
          fps: ltc.fps || parseFps(ltc.fpsValue || recordFpsValue(record)),
          fpsValue: ltc.fpsValue || recordFpsValue(record),
          source: "ltc",
          description: `Audio TC Change LTC ${ltc.timecode}`,
        };
      })
      .filter(Boolean);
  }

  function metadataSourceName() {
    return getPreviews().length ? "offset" : "ltc";
  }

  async function exportMetadata() {
    const items = resolveMetadataItems();
    if (!items.length) throw new Error("没有可导出的时码元数据；请先生成偏移预览或完成 LTC 检测");
    const format = await chooseMetadataFormat();
    if (!format) return;
    const source = metadataSourceName();
    const stamp = timestampForFilename();
    const exportConfig = format === "ale"
      ? {
        label: "ALE",
        name: `audio_tc_${source}_metadata_${stamp}.ale`,
        blob: new Blob([aleMetadataText(items, els.fpsInput.value, { samplesToTimecode, recordLabel })], { type: "text/plain;charset=utf-8" }),
        pickerType: { description: "Avid Log Exchange", accept: { "text/plain": [".ale"] } },
      }
      : {
        label: "Resolve CSV",
        name: `resolve_${source}_metadata_${stamp}.csv`,
        blob: utf16LeCsvBlob(resolveMetadataCsv(items, { samplesToTimecode })),
        pickerType: { description: "Resolve CSV", accept: { "text/csv": [".csv"] } },
      };
    const savedName = await saveBlob(exportConfig.blob, exportConfig.name, exportConfig.pickerType);
    setState("已导出");
    els.statusLine.textContent = `已导出 ${exportConfig.label} 元数据：${items.length} 个文件`;
    els.toast.textContent = `✅ 已导出 ${savedName}`;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), 4500);
    log(`Metadata Export OK: ${items.length} files, format ${exportConfig.label}, source ${source} -> ${savedName}`);
  }

  return {
    exportMetadata,
    resolveMetadataItems,
  };
}
