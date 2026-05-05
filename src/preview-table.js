import { formatDuration } from "./metadata-export.js";
import {
  recordKey,
  recordLabel,
  shortGroupLabel,
} from "./grouping.js";

export function createPreviewTableRenderer({
  els,
  getRecords,
  getPreviews,
  getActiveOffset,
  getLtcResults,
  getChangedTimeReferences,
  recordsByGroup,
  isTakeTrack,
  recordFps,
  recordFpsSource,
  recordFpsDisplay,
  defaultDisplayFps,
  samplesToTimecode,
  ltcStartTimecode,
  ltcStatusText,
  combineEligibleGroups,
  resolveMetadataItems,
}) {
  function canWriteLtcResult(result) {
    const record = result?.record;
    return Boolean(result?.ok && record && !record._meta && !record._video && record.fileHandle?.createWritable);
  }

  function ltcFpsDisplay(ltc) {
    if (!ltc?.ok || !ltc?.timecode || !ltc?.fps) return null;
    return {
      fps: ltc.fps,
      source: "LTC检测",
      display: `${ltc.fpsLabel || ltc.fpsValue || "LTC"} · LTC检测`,
    };
  }

  function fpsBadgeClass(source) {
    if (source === "iXML" || source === "ALE/CSV") return "fps-badge ixml";
    if (source === "LTC检测") return "fps-badge ltc";
    if (source === "视频元数据") return "fps-badge video";
    return "fps-badge";
  }

  function ltcValueClass(ltc) {
    if (!(ltc?.ok || ltc?.status === "ok")) return "";
    return ltc.qualityRank === 1 ? "ltc-value-warn" : "ltc-value-ok";
  }

  function renderRows() {
    const records = getRecords();
    const previews = getPreviews();
    const ltcResults = getLtcResults();
    const changedTimeReferences = getChangedTimeReferences();
    const activeOffset = getActiveOffset();

    els.previewBody.textContent = "";
    const sampleRates = new Set();
    const sampleOffsets = new Set();
    const fallbackFps = defaultDisplayFps();
    const previewByName = new Map(previews.map(preview => [recordKey(preview), preview]));
    const showLtc = Array.from(ltcResults.values()).some(result => result.status !== "idle");
    const groups = recordsByGroup();

    for (const [key, groupRecords] of groups) {
      const isTrackGroup = groupRecords.length > 1 && groupRecords.every(isTakeTrack);
      if (isTrackGroup) {
        const groupRow = document.createElement("tr");
        groupRow.className = "group-row";
        const td = document.createElement("td");
        td.colSpan = 15;
        const detected = groupRecords.map(record => ltcResults.get(recordKey(record))).find(result => result?.timecode);
        const detectedRecord = detected?.record || groupRecords[0];
        const detectedStartTc = detected ? ltcStartTimecode(detected, detectedRecord) : "";
        td.innerHTML = "";
        const title = document.createElement("span");
        title.className = "group-title";
        const name = document.createElement("span");
        name.className = "group-name";
        name.textContent = shortGroupLabel(key);
        const meta = document.createElement("span");
        meta.className = "group-meta";
        meta.textContent = `${groupRecords.length} 个分轨${detected ? ` · LTC起始 ${detectedStartTc} · ${detected.sourceRecord?.name || "已检测"}` : ""}`;
        title.append(name, meta);
        td.appendChild(title);
        groupRow.appendChild(td);
        els.previewBody.appendChild(groupRow);
      }

      for (const record of groupRecords) {
        const preview = previewByName.get(recordKey(record));
        const ltc = ltcResults.get(recordKey(record));
        const ltcFps = ltcFpsDisplay(ltc);
        const fps = preview?.fps || ltcFps?.fps || recordFps(record);
        const fpsSource = preview?.fpsSource || ltcFps?.source || recordFpsSource(record);
        const recordWasChanged = changedTimeReferences.get(recordKey(record)) === record.oldTimeReference;
        sampleRates.add(record.sampleRate);
        if (preview) sampleOffsets.add(preview.sampleOffset.toString());
        const row = document.createElement("tr");
        if (record._meta) row.classList.add("meta-record");
        if (record._video) row.classList.add("video-record");
        const cells = [
          recordLabel(record),
          record.sampleRate || "-",
          record.channels || "-",
          record.bitsPerSample || "-",
          preview?.fpsDisplay || ltcFps?.display || recordFpsDisplay(record),
          samplesToTimecode(record.oldTimeReference, record.sampleRate || 48000, fps),
          preview ? samplesToTimecode(preview.newTimeReference, record.sampleRate || 48000, fps) : "待预览",
          samplesToTimecode(record.oldTimeReference + record.durationSamples, record.sampleRate || 48000, fps),
          preview ? samplesToTimecode(preview.newTimeReference + record.durationSamples, record.sampleRate || 48000, fps) : "待预览",
          record.oldTimeReference,
          preview ? preview.newTimeReference : "待预览",
          ltc ? ltcStartTimecode(ltc, record) : "待检测",
          ltc ? ltcStatusText(ltc, record, fallbackFps) : "待检测",
          formatDuration(record.durationSamples, record.sampleRate || 48000),
        ];
        cells.forEach((cell, index) => {
          const td = document.createElement("td");
          if (index === 0 && isTrackGroup) {
            const name = document.createElement("span");
            name.className = "track-name";
            name.textContent = record.name;
            td.appendChild(name);
          } else if (index === 4) {
            const badge = document.createElement("span");
            badge.className = fpsBadgeClass(fpsSource);
            badge.textContent = String(cell);
            td.appendChild(badge);
          } else {
            td.textContent = String(cell);
          }
          if ([5, 6, 7, 8, 9, 10, 11].includes(index)) td.classList.add("mono");
          if (!preview && [6, 8, 10].includes(index)) td.classList.add("pending");
          if (preview && [6, 8, 10].includes(index)) td.classList.add("new-value");
          if (!preview && recordWasChanged && [5, 7].includes(index)) td.classList.add("ltc-value-ok");
          if ([11, 12].includes(index)) td.classList.add("ltc-col");
          if (index === 11 && (!ltc || !ltc.timecode)) td.classList.add("pending");
          if ([11, 12].includes(index)) {
            const qualityClass = ltcValueClass(ltc);
            if (qualityClass) td.classList.add(qualityClass);
          }
          row.appendChild(td);
        });
        const result = document.createElement("td");
        const pill = document.createElement("span");
        pill.className = preview || recordWasChanged ? "pill ok" : "pill idle";
        pill.textContent = preview ? "Ready" : (recordWasChanged ? "已更改" : "Original");
        result.appendChild(pill);
        row.appendChild(result);
        els.previewBody.appendChild(row);
      }
    }

    els.previewTable.dataset.ltcVisible = String(showLtc);
    els.previewTable.hidden = records.length === 0;
    els.emptyState.hidden = records.length > 0;
    els.fileCount.textContent = records.length;
    els.offsetFrames.textContent = activeOffset ? activeOffset.frames.toString() : "-";
    els.offsetSamples.textContent = sampleOffsets.size ? Array.from(sampleOffsets).join(", ") : "-";
    els.sampleRates.textContent = sampleRates.size ? Array.from(sampleRates).join(", ") : "-";
    els.phasePill.textContent = previews.length ? "修改预览" : "原始信息";
    els.extractLtcBtn.disabled = records.length === 0;
    els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    els.writeLtcBtn.disabled = !Array.from(ltcResults.values()).some(canWriteLtcResult);
    els.exportMetadataBtn.disabled = resolveMetadataItems().length === 0;
  }

  return { renderRows };
}
