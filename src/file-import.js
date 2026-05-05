export function createFileImportController({
  els,
  scanWave,
  wavSuffix,
  setDirectoryHandle,
  getRecords,
  pushRecord,
  clearAfterImportState,
  refreshTakeGroups,
  takeGroupCount,
  combineEligibleGroups,
  detectedMetadataFps,
  fpsDiffersFromUi,
  fpsInput,
  setFpsValue,
  fpsSelectLabel,
  confirmMetadataFpsMismatch,
  renderRows,
  setState,
  log,
  guarded,
}) {
  async function addDirectory(handle, basePath = handle.name) {
    const entries = [];
    for await (const entry of handle.values()) entries.push(entry);
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const relativePath = `${basePath}/${entry.name}`;
      if (entry.kind === "directory") {
        await addDirectory(entry, relativePath);
      } else if (entry.kind === "file" && wavSuffix.test(entry.name)) {
        pushRecord(await scanWave(entry, {
          relativePath,
          parentPath: basePath,
          parentHandle: handle,
        }));
      }
    }
  }

  async function addHandle(handle) {
    if (handle.kind === "directory") {
      setDirectoryHandle(handle);
      await addDirectory(handle);
    } else if (handle.kind === "file" && wavSuffix.test(handle.name)) {
      pushRecord(await scanWave(handle));
    }
  }

  async function finishImport(count, sourceLabel) {
    const records = getRecords();
    if (records.length <= count) return;
    clearAfterImportState(count);
    refreshTakeGroups();
    els.undoBtn.disabled = true;
    els.previewBtn.disabled = false;
    els.extractLtcBtn.disabled = false;
    els.exportMetadataBtn.disabled = true;
    els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    els.writeLtcBtn.disabled = true;
    setState("已载入");
    const takeText = takeGroupCount() ? `，识别到 ${takeGroupCount()} 个分轨 take` : "";
    els.statusLine.textContent = `已载入 ${records.length} 个 WAV${takeText}；输入偏移后点击预览`;
    renderRows();
    log(`${sourceLabel}: ${records.length - count} WAV file(s)`);

    const metadata = detectedMetadataFps(records.slice(count));
    if (metadata && fpsDiffersFromUi(metadata.value)) {
      const useMetadata = await confirmMetadataFpsMismatch({
        currentValue: fpsInput.value,
        metadata,
      });
      if (useMetadata) {
        setFpsValue(metadata.value);
        log(`FPS: switched to ${fpsSelectLabel(metadata.value)} from iXML metadata`);
      } else {
        log(`FPS: kept ${fpsSelectLabel(fpsInput.value)} despite iXML metadata ${fpsSelectLabel(metadata.value)}`);
      }
    }
  }

  function entryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }

  function readEntryBatch(reader) {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  async function addEntry(entry, basePath = entry.name) {
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = [];
      while (true) {
        const batch = await readEntryBatch(reader);
        if (!batch.length) break;
        entries.push(...batch);
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of entries) {
        await addEntry(child, `${basePath}/${child.name}`);
      }
    } else if (entry.isFile && wavSuffix.test(entry.name)) {
      const file = await entryFile(entry);
      pushRecord(await scanWave({
        kind: "file",
        name: entry.name,
        getFile: async () => file,
      }, {
        relativePath: basePath,
        parentPath: basePath.split("/").slice(0, -1).join("/"),
      }));
    }
  }

  async function droppedHandles(items) {
    const pending = [];
    for (const item of items) {
      if (item.getAsFileSystemHandle) {
        pending.push(item.getAsFileSystemHandle());
      }
    }
    return (await Promise.all(pending)).filter(Boolean);
  }

  async function handleDropItems(items) {
    const count = getRecords().length;
    const handles = await droppedHandles(items);
    if (handles.length) {
      for (const handle of handles) {
        try {
          await addHandle(handle);
        } catch (error) {
          log(`ERROR: ${error.message}`);
        }
      }
    } else {
      for (const item of items) {
        try {
          const entry = item.webkitGetAsEntry?.();
          if (entry) await addEntry(entry);
        } catch (error) {
          log(`ERROR: ${error.message}`);
        }
      }
    }
    await finishImport(count, "Dropped");
  }

  async function chooseAudioPath() {
    if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持点击选择文件夹，请直接拖入音频文件夹");
    const count = getRecords().length;
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await addHandle(handle);
    await finishImport(count, "Selected");
  }

  function setupDragAndDrop() {
    const app = document.querySelector(".app");
    app.addEventListener("dragover", event => {
      event.preventDefault();
      event.stopPropagation();
      app.classList.add("drag-over");
    });
    app.addEventListener("dragleave", event => {
      event.preventDefault();
      event.stopPropagation();
      app.classList.remove("drag-over");
    });
    app.addEventListener("drop", async event => {
      event.preventDefault();
      event.stopPropagation();
      app.classList.remove("drag-over");
      await guarded(() => handleDropItems(event.dataTransfer.items));
    });

    els.emptyState.addEventListener("click", () => guarded(chooseAudioPath));
    els.emptyState.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      guarded(chooseAudioPath);
    });
  }

  return {
    addHandle,
    chooseAudioPath,
    handleDropItems,
    setupDragAndDrop,
  };
}
