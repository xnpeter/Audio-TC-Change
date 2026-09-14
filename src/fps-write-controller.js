import {
  bextAspeedToFpsValue,
  ixmlRateToFpsValue,
  parseFps,
} from "./timecode.js";
import { recordKey } from "./grouping.js";
import { scanWave } from "./wave.js";
import {
  fpsActionLabel,
  planFpsWrite,
  readBextDescriptionBytes,
  readIxmlChunkBytes,
  restoreFpsMetadata,
  verifyFpsMetadata,
  writeFpsMetadata,
} from "./wave-fps-metadata.js";

function bytesEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createFpsWriteController({
  els,
  getRecords,
  getSelectedRecordKeys,
  getPreviews,
  setPreviews,
  setActiveOffset,
  getLastUndoBatch,
  setLastUndoBatch,
  recordFps,
  recordFpsDisplay,
  fpsSelectLabel,
  samplesToTimecode,
  showConfirmDialog,
  refreshRecordsFromHandles,
  setChangedTimeReferences,
  setState,
  updateWriteProgress,
  renderRows,
  log,
}) {
  function writableWavRecords() {
    return getRecords().filter(record =>
      !record._meta &&
      !record._video &&
      typeof record.fileHandle?.createWritable === "function"
    );
  }

  function selectedWritableRecords() {
    const selected = getSelectedRecordKeys();
    return writableWavRecords().filter(record => selected.has(recordKey(record)));
  }

  function scopedRecords() {
    return els.fpsScopeSelected.checked ? selectedWritableRecords() : writableWavRecords();
  }

  function setApplyMode(isFpsPreview) {
    els.applyBtn.textContent = isFpsPreview ? "写入帧率元数据" : "写入";
    els.applyBtn.title = isFpsPreview ? "写入帧率元数据" : "写入";
  }

  function previewIsFpsMetadata() {
    return getPreviews().some(preview => preview.operation === "fps-metadata");
  }

  function metadataFpsLabel(value) {
    const option = Array.from(els.fpsMetadataTarget.options).find(item => item.value === value);
    return option ? `${option.textContent} FPS` : fpsSelectLabel(value);
  }

  function selectedFpsPolicy() {
    if (els.fpsPolicySkip?.checked) return "skip";
    if (els.fpsPolicyIxml?.checked) return "ixml";
    if (els.fpsPolicyBext?.checked) return "bext";
    if (els.fpsPolicyBoth?.checked) return "both";
    return "existing";
  }

  function currentFpsSummary(records) {
    const groups = new Map();
    let missing = 0;
    for (const record of records) {
      const ixml = ixmlRateToFpsValue(record.ixmlInfo);
      const aspeed = bextAspeedToFpsValue(record.bextInfo);
      if (!ixml && !aspeed) {
        missing += 1;
        continue;
      }
      const source = ixml && aspeed ? "iXML + aSPEED" : ixml ? "仅 iXML" : "仅 bext aSPEED";
      const value = ixml && aspeed && ixml !== aspeed
        ? `${metadataFpsLabel(ixml)} / ${metadataFpsLabel(aspeed)}`
        : metadataFpsLabel(ixml || aspeed);
      const key = `${value} · ${source}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return {
      counts: Array.from(groups.entries()).sort((a, b) => b[1] - a[1]),
      missing,
    };
  }

  const POLICY_HINTS = {
    existing: "有 iXML 就改 iXML，有 aSPEED 就改 aSPEED；两边都有就都改；都没有则跳过。不新造字段。",
    skip: "不写入任何文件。",
    ixml: "只写 iXML。没有 iXML 的文件会创建 SPEED。不改 aSPEED。",
    bext: "只改已有的 aSPEED。没有 aSPEED 的文件跳过。不新写 aSPEED，也不动 iXML。",
    both: "iXML 和 aSPEED 都写。缺 iXML 就创建；缺 aSPEED 且已有 bext 就补一行。",
  };

  function updatePolicyHint() {
    if (els.fpsPolicyHint) els.fpsPolicyHint.textContent = POLICY_HINTS[selectedFpsPolicy()];
  }

  function renderDialogSummary() {
    const records = scopedRecords();
    const { counts, missing } = currentFpsSummary(records);
    els.fpsMetadataSummary.textContent = "";
    for (const [label, count] of counts) {
      const row = document.createElement("div");
      row.className = "fps-summary-row";
      const name = document.createElement("span");
      name.textContent = label;
      const value = document.createElement("span");
      value.textContent = `${count} 个`;
      row.append(name, value);
      els.fpsMetadataSummary.appendChild(row);
    }
    if (missing) {
      const row = document.createElement("div");
      row.className = "fps-summary-row";
      const name = document.createElement("span");
      name.textContent = "无帧率元数据";
      const value = document.createElement("span");
      value.textContent = `${missing} 个`;
      row.append(name, value);
      els.fpsMetadataSummary.appendChild(row);
    }
    if (!records.length) {
      const empty = document.createElement("div");
      empty.textContent = "当前范围内没有可写入的 WAV";
      els.fpsMetadataSummary.appendChild(empty);
    }
    updatePolicyHint();
    renderExample(records);
  }

  function renderExample(records = scopedRecords()) {
    const record = records[0];
    if (!record) {
      els.fpsMetadataExample.textContent = "没有可预览的 WAV";
      return;
    }
    const oldFps = recordFps(record);
    const targetFps = parseFps(els.fpsMetadataTarget.value);
    const oldTc = samplesToTimecode(record.oldTimeReference, record.sampleRate, oldFps, { wrapDay: true });
    const newTc = samplesToTimecode(record.oldTimeReference, record.sampleRate, targetFps, { wrapDay: true });
    els.fpsMetadataExample.textContent =
      `${oldTc} → ${newTc} · TimeReference ${record.oldTimeReference} samples（不变）`;
  }

  function closeDialog() {
    els.fpsMetadataOverlay.classList.remove("show");
    els.fpsMetadataOverlay.setAttribute("aria-hidden", "true");
    els.fpsMetadataBtn.focus();
  }

  function openDialog() {
    const all = writableWavRecords();
    if (!all.length) throw new Error("列表中没有可直接写入的 WAV 文件");
    const selected = selectedWritableRecords();
    els.fpsScopeSelected.disabled = selected.length === 0;
    els.fpsScopeSelectedLabel.textContent = `已选中的 WAV（${selected.length} 个）`;
    els.fpsScopeAllLabel.textContent = `列表中的全部 WAV（${all.length} 个）`;
    els.fpsScopeSelected.checked = selected.length > 0;
    els.fpsScopeAll.checked = selected.length === 0;
    els.fpsMetadataTarget.value = els.fpsInput.value;
    if (els.fpsPolicyExisting) els.fpsPolicyExisting.checked = true;
    renderDialogSummary();
    els.fpsMetadataOverlay.classList.add("show");
    els.fpsMetadataOverlay.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => els.fpsMetadataTarget.focus());
  }

  function generatePreview() {
    const records = scopedRecords();
    if (!records.length) throw new Error("当前范围内没有可写入的 WAV 文件");
    const targetValue = els.fpsMetadataTarget.value;
    const targetFps = parseFps(targetValue);
    const targetLabel = metadataFpsLabel(targetValue);
    const policy = selectedFpsPolicy();
    const nextPreviews = records.map(record => {
      const plan = planFpsWrite(record, targetValue, policy);
      return {
        ...record,
        operation: "fps-metadata",
        fps: targetFps,
        oldFps: recordFps(record),
        fpsValue: targetValue,
        fpsTargetValue: targetValue,
        fpsTargetLabel: targetLabel,
        fpsOldValue: ixmlRateToFpsValue(record.ixmlInfo) || bextAspeedToFpsValue(record.bextInfo) || "",
        fpsOldDisplay: recordFpsDisplay(record),
        fpsDisplay: `${recordFpsDisplay(record)} → ${targetLabel}`,
        fpsSource: "FPS预览",
        fpsAction: plan.action,
        fpsWillWrite: plan.willWrite,
        fpsWriteIxml: plan.writeIxml,
        fpsWriteAspeed: plan.writeAspeed,
        createIxml: plan.createIxml,
        createAspeed: plan.createAspeed,
        sampleOffset: 0n,
        newTimeReference: record.oldTimeReference,
      };
    });

    setPreviews(nextPreviews);
    setActiveOffset(null);
    setChangedTimeReferences(new Map());
    setApplyMode(true);
    const writeCount = nextPreviews.filter(preview => preview.fpsWillWrite).length;
    els.applyBtn.disabled = writeCount === 0;
    renderRows();
    closeDialog();
    setState(writeCount ? "可写入FPS" : "无需更改", writeCount ? "warn" : "ok");
    const skipped = nextPreviews.filter(preview => String(preview.fpsAction).startsWith("skip")).length;
    els.statusLine.textContent = writeCount
      ? `${writeCount} 个 WAV 将写入 ${targetLabel}${skipped ? `；${skipped} 个将跳过` : ""}`
      : "当前范围内没有需要写入的帧率元数据";
    log(`FPS Preview OK: ${writeCount}/${nextPreviews.length} writable, target ${targetLabel}, policy ${policy}`);
  }

  async function applyChanges() {
    const previews = getPreviews().filter(preview => preview.operation === "fps-metadata");
    const writable = previews.filter(preview => preview.fpsWillWrite);
    if (!writable.length) throw new Error("没有需要写入的帧率元数据");
    const targetLabel = writable[0].fpsTargetLabel;
    const ixmlCount = writable.filter(preview => preview.fpsWriteIxml && !preview.createIxml).length;
    const createIxmlCount = writable.filter(preview => preview.createIxml).length;
    const aspeedCount = writable.filter(preview => preview.fpsWriteAspeed && !preview.createAspeed).length;
    const createAspeedCount = writable.filter(preview => preview.createAspeed).length;
    const confirmed = await showConfirmDialog({
      title: "写入帧率元数据？",
      copy: [
        `将把 <strong>${writable.length} 个 WAV</strong> 的帧率元数据修改为 <strong>${targetLabel}</strong>。`,
        [
          ixmlCount ? `${ixmlCount} 个更新 iXML` : "",
          createIxmlCount ? `${createIxmlCount} 个创建 iXML` : "",
          aspeedCount ? `${aspeedCount} 个更新 aSPEED` : "",
          createAspeedCount ? `${createAspeedCount} 个写入 aSPEED` : "",
        ].filter(Boolean).join("，"),
        "TimeReference、音频采样率、音频内容和文件时长均保持不变。",
      ].filter(Boolean).join("<br>"),
      confirmText: "写入帧率元数据",
      danger: true,
    });
    if (!confirmed) return;

    setState("FPS写入中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    els.statusLine.textContent = "Writing FPS metadata...";
    updateWriteProgress("正在写入帧率元数据…", "", 0, writable.length);
    els.progressOverlay.classList.add("show");
    const undoItems = [];

    try {
      for (let i = 0; i < writable.length; i++) {
        const preview = writable[i];
        updateWriteProgress("正在写入帧率元数据…", preview.name, i, writable.length);
        const undoItem = await writeFpsMetadata(preview, preview.fpsTargetValue, {
          writeIxml: preview.fpsWriteIxml,
          createIxml: preview.createIxml,
          writeAspeed: preview.fpsWriteAspeed,
          createAspeed: preview.createAspeed,
        });
        undoItems.push(undoItem);
        updateWriteProgress("正在写入帧率元数据…", preview.name, i + 1, writable.length);
      }

      updateWriteProgress("正在校验…", "校验 FPS 与 TimeReference", writable.length, writable.length);
      for (const preview of writable) {
        const fresh = await scanWave(preview.fileHandle);
        verifyFpsMetadata(fresh, preview.fpsTargetValue, preview.oldTimeReference, preview.name, {
          sampleRate: preview.sampleRate,
          dataSize: preview.dataSize,
        }, {
          writeIxml: preview.fpsWriteIxml,
          writeAspeed: preview.fpsWriteAspeed,
        });
      }

      setLastUndoBatch({ type: "fps-metadata", items: undoItems });
      setPreviews([]);
      setActiveOffset(null);
      setChangedTimeReferences(new Map());
      setApplyMode(false);
      await refreshRecordsFromHandles();
      renderRows();
      els.undoBtn.disabled = false;
      setState("FPS已更改");
      els.statusLine.textContent = `帧率元数据写入完成：${writable.length} 个 WAV → ${targetLabel}`;
      log(`FPS Write OK: ${writable.length} files -> ${targetLabel}`);
      els.toast.textContent = `✅ 帧率元数据写入完成 — ${writable.length} 个文件`;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 4500);
    } catch (error) {
      if (undoItems.length) {
        setLastUndoBatch({ type: "fps-metadata", items: undoItems });
        els.undoBtn.disabled = false;
        await refreshRecordsFromHandles();
        renderRows();
      }
      throw error;
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  async function undoLastWrite() {
    const batch = getLastUndoBatch();
    if (batch?.type !== "fps-metadata") throw new Error("没有可撤销的帧率元数据写入");
    const items = batch.items;
    setState("撤销FPS中", "warn");
    els.applyBtn.disabled = true;
    els.undoBtn.disabled = true;
    updateWriteProgress("正在撤销帧率元数据…", "", 0, items.length);
    els.progressOverlay.classList.add("show");

    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        updateWriteProgress("正在撤销帧率元数据…", item.name, i, items.length);
        await restoreFpsMetadata(item);
        updateWriteProgress("正在撤销帧率元数据…", item.name, i + 1, items.length);
      }
      updateWriteProgress("正在校验…", "校验原始帧率元数据", items.length, items.length);
      for (const item of items) {
        const fresh = await scanWave(item.fileHandle);
        if (fresh.oldTimeReference !== item.oldTimeReference) {
          throw new Error(`${item.name}: 撤销后 TimeReference 不一致`);
        }
        if (item.wroteIxml) {
          if (item.originalIxmlBytes === null) {
            if (fresh.ixmlInfo) throw new Error(`${item.name}: 新建 iXML 未能移除`);
          } else {
            const currentBytes = await readIxmlChunkBytes(fresh);
            if (!bytesEqual(currentBytes, item.originalIxmlBytes)) {
              throw new Error(`${item.name}: 原始 iXML 恢复校验失败`);
            }
          }
        }
        if (item.wroteAspeed) {
          const currentDescription = await readBextDescriptionBytes(fresh);
          if (!bytesEqual(currentDescription, item.originalDescriptionBytes)) {
            throw new Error(`${item.name}: 原始 bext aSPEED 恢复校验失败`);
          }
        }
      }

      setLastUndoBatch(null);
      setPreviews([]);
      setActiveOffset(null);
      setChangedTimeReferences(new Map());
      setApplyMode(false);
      await refreshRecordsFromHandles();
      renderRows();
      setState("FPS已撤销");
      els.statusLine.textContent = "已撤销上一次帧率元数据写入";
      log(`FPS Undo OK: ${items.length} files`);
      els.toast.textContent = "↩ 帧率元数据撤销完成";
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 3500);
    } finally {
      els.progressOverlay.classList.remove("show");
      updateWriteProgress("正在写入…", "", 0, 1);
      els.undoBtn.disabled = !getLastUndoBatch();
    }
  }

  function resetPreviewMode() {
    setApplyMode(false);
  }

  function bindEvents({ guarded }) {
    els.fpsMetadataBtn.addEventListener("click", () => guarded(openDialog));
    els.fpsMetadataCancelBtn.addEventListener("click", closeDialog);
    els.fpsMetadataPreviewBtn.addEventListener("click", () => guarded(generatePreview));
    els.fpsScopeSelected.addEventListener("change", renderDialogSummary);
    els.fpsScopeAll.addEventListener("change", renderDialogSummary);
    els.fpsMetadataTarget.addEventListener("change", () => renderExample());
    for (const input of [els.fpsPolicyExisting, els.fpsPolicySkip, els.fpsPolicyIxml, els.fpsPolicyBext, els.fpsPolicyBoth]) {
      input?.addEventListener("change", () => {
        updatePolicyHint();
        renderExample();
      });
    }
    els.fpsMetadataOverlay.addEventListener("click", event => {
      if (event.target === els.fpsMetadataOverlay) closeDialog();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && els.fpsMetadataOverlay.classList.contains("show")) closeDialog();
    });
  }

  return {
    applyChanges,
    bindEvents,
    openDialog,
    previewIsFpsMetadata,
    resetPreviewMode,
    undoLastWrite,
  };
}
