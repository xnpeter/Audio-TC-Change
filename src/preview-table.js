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
  getCombinedPolyKeys,
  getSelectedRecordKeys,
  setSelectedRecordKeys,
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

  let lastSelectedKey = null;

  function selectableRecords() {
    return getRecords().filter(record => !record._meta);
  }

  function setGroupSelection(groupRecords, event) {
    if (!setSelectedRecordKeys) return;
    const keys = groupRecords.filter(record => !record._meta).map(recordKey);
    if (!keys.length) return;
    const selected = new Set(getSelectedRecordKeys?.() ?? []);
    const allSelected = keys.every(key => selected.has(key));
    if (event.metaKey || event.ctrlKey) {
      for (const key of keys) {
        if (allSelected) selected.delete(key);
        else selected.add(key);
      }
    } else if (allSelected) {
      for (const key of keys) selected.delete(key);
    } else {
      selected.clear();
      for (const key of keys) selected.add(key);
    }
    lastSelectedKey = keys[keys.length - 1];
    setSelectedRecordKeys(selected);
    updateSelectionUi();
  }

  function updateSelectionUi() {
    const selected = getSelectedRecordKeys?.() ?? new Set();
    els.previewBody.querySelectorAll("tr[data-record-key]").forEach(row => {
      row.classList.toggle("selected-row", selected.has(row.dataset.recordKey));
    });
    els.previewBody.querySelectorAll("tr[data-group-record-keys]").forEach(row => {
      const keys = row.dataset.groupRecordKeys.split("\n").filter(Boolean);
      row.classList.toggle("selected-row", keys.length > 0 && keys.every(key => selected.has(key)));
      row.classList.toggle("partial-selected-row", keys.some(key => selected.has(key)) && !keys.every(key => selected.has(key)));
    });
    if (els.extractLtcFallbackBtn) {
      els.extractLtcFallbackBtn.disabled = selected.size === 0;
      els.extractLtcFallbackBtn.textContent = selected.size
        ? `增强识别选中项 (${selected.size})`
        : "增强识别选中项";
    }
    if (els.removeSelectedBtn) els.removeSelectedBtn.disabled = selected.size === 0;
  }

  function toggleRecordSelection(record, event) {
    if (!setSelectedRecordKeys || record._meta) return;
    const key = recordKey(record);
    const selected = new Set(getSelectedRecordKeys?.() ?? []);
    const records = selectableRecords();
    if (event.shiftKey && lastSelectedKey) {
      const from = records.findIndex(item => recordKey(item) === lastSelectedKey);
      const to = records.findIndex(item => recordKey(item) === key);
      if (from >= 0 && to >= 0) {
        selected.clear();
        const [start, end] = from < to ? [from, to] : [to, from];
        for (const item of records.slice(start, end + 1)) selected.add(recordKey(item));
      } else {
        selected.has(key) ? selected.delete(key) : selected.add(key);
      }
    } else if (event.metaKey || event.ctrlKey) {
      selected.has(key) ? selected.delete(key) : selected.add(key);
    } else if (selected.has(key)) {
      selected.delete(key);
    } else {
      selected.clear();
      selected.add(key);
    }
    lastSelectedKey = key;
    setSelectedRecordKeys(selected);
    updateSelectionUi();
  }

  function renderRows() {
    const records = getRecords();
    const previews = getPreviews();
    const ltcResults = getLtcResults();
    const changedTimeReferences = getChangedTimeReferences();
    const combinedPolyKeys = getCombinedPolyKeys?.() ?? new Set();
    const activeOffset = getActiveOffset();
    if (setSelectedRecordKeys) {
      const liveKeys = new Set(records.map(recordKey));
      const selected = new Set([...(getSelectedRecordKeys?.() ?? [])].filter(key => liveKeys.has(key)));
      if (selected.size !== (getSelectedRecordKeys?.() ?? new Set()).size) setSelectedRecordKeys(selected);
    }

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
        groupRow.dataset.groupRecordKeys = groupRecords.map(recordKey).join("\n");
        groupRow.addEventListener("click", event => setGroupSelection(groupRecords, event));
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
        row.dataset.recordKey = recordKey(record);
        row.addEventListener("click", event => toggleRecordSelection(record, event));
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
        const recordWasCombined = combinedPolyKeys.has(recordKey(record));
        const result = document.createElement("td");
        const pill = document.createElement("span");
        const hasOp = preview || recordWasChanged || recordWasCombined;
        pill.className = hasOp ? "pill ok" : "pill idle";
        if (preview && !recordWasCombined) {
          pill.textContent = "Ready";
        } else if (recordWasChanged && recordWasCombined) {
          pill.textContent = "已更改并合并";
        } else if (recordWasChanged) {
          pill.textContent = "已更改";
        } else if (recordWasCombined) {
          pill.textContent = "已合并";
        } else {
          pill.textContent = "Original";
        }
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
    if (els.clearListBtn) els.clearListBtn.disabled = records.length === 0;
    els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    els.writeLtcBtn.disabled = !Array.from(ltcResults.values()).some(canWriteLtcResult);
    els.exportMetadataBtn.disabled = resolveMetadataItems().length === 0;
    updateSelectionUi();
  }

  return { renderRows };
}
