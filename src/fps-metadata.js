import {
  fpsLabel,
  fpsValueEquivalent,
  ixmlRateToFpsValue,
  parseFps,
} from "./timecode.js";

export function createFpsMetadataController({ fpsInput }) {
  function fpsSelectLabel(value) {
    const option = Array.from(fpsInput.options).find(item => item.value === value);
    return option ? `${option.textContent} FPS` : fpsLabel(parseFps(value));
  }

  function metaFpsValue(record) {
    return record._meta?.fpsValue || record._video?.fpsValue || "";
  }

  function importedMetadataFpsValue(record) {
    return record._meta?.fpsValue || "";
  }

  function detectedMetadataFps(recordsToCheck) {
    const counts = new Map();
    for (const record of recordsToCheck) {
      const value = ixmlRateToFpsValue(record.ixmlInfo) || metaFpsValue(record);
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    return {
      value: sorted[0][0],
      count: sorted[0][1],
      total: Array.from(counts.values()).reduce((sum, count) => sum + count, 0),
      all: sorted,
    };
  }

  function recordFpsValue(record) {
    return ixmlRateToFpsValue(record.ixmlInfo) || metaFpsValue(record) || fpsInput.value;
  }

  function recordFps(record) {
    return parseFps(recordFpsValue(record));
  }

  function recordFpsSource(record) {
    if (ixmlRateToFpsValue(record.ixmlInfo)) return "iXML";
    if (importedMetadataFpsValue(record)) return "ALE/CSV";
    if (record._video?.fpsValue) return "视频元数据";
    return "界面设置";
  }

  function recordFpsDisplay(record) {
    return `${fpsSelectLabel(recordFpsValue(record))} · ${recordFpsSource(record)}`;
  }

  function setFpsValue(value) {
    fpsInput.value = value;
    fpsInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function differsFromUi(value) {
    return !fpsValueEquivalent(value, fpsInput.value);
  }

  return {
    detectedMetadataFps,
    differsFromUi,
    fpsSelectLabel,
    recordFps,
    recordFpsDisplay,
    recordFpsSource,
    recordFpsValue,
    setFpsValue,
  };
}
