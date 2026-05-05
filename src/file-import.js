async function readFileAsText(handle) {
  const file = await handle.getFile();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.slice(2));
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.slice(2));
  }
  return new TextDecoder("utf-8").decode(buf);
}

async function importMetadataHandle(handle, parseMetadataImport, pushRecord, log) {
  const text = await readFileAsText(handle);
  const records = parseMetadataImport(text, handle.name);
  for (const record of records) pushRecord(record);
  log(`Metadata import: ${records.length} clips from ${handle.name}`);
}

export function createFileImportController({
  els,
  scanWave,
  scanVideo,
  wavSuffix,
  videoSuffix,
  metadataSuffix,
  parseMetadataImport,
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
      } else if (entry.kind === "file") {
        if (wavSuffix.test(entry.name) || videoSuffix?.test(entry.name)) {
          const scanner = wavSuffix.test(entry.name) ? scanWave : scanVideo;
          pushRecord(await scanner(entry, {
            relativePath,
            parentPath: basePath,
            parentHandle: handle,
          }));
        } else if (metadataSuffix && metadataSuffix.test(entry.name)) {
          const text = await readFileAsText(entry);
          const metaRecords = parseMetadataImport(text, entry.name);
          for (const record of metaRecords) pushRecord(record);
        }
      }
    }
  }

  async function addHandle(handle) {
    if (handle.kind === "directory") {
      setDirectoryHandle(handle);
      await addDirectory(handle);
    } else if (handle.kind === "file") {
      if (wavSuffix.test(handle.name) || videoSuffix?.test(handle.name)) {
        const scanner = wavSuffix.test(handle.name) ? scanWave : scanVideo;
        pushRecord(await scanner(handle));
      } else if (metadataSuffix && metadataSuffix.test(handle.name)) {
        await importMetadataHandle(handle, parseMetadataImport, pushRecord, log);
      }
    }
  }

  async function finishImport(count, sourceLabel) {
    const records = getRecords();
    if (records.length <= count) return;
    const newRecords = records.slice(count);
    const metaRecords = newRecords.filter(r => r._meta);
    const videoRecords = newRecords.filter(r => r._video);
    const wavRecords = newRecords.filter(r => !r._meta && !r._video);
    const ltcRecords = newRecords.filter(r => !r._meta);
    clearAfterImportState(count);
    refreshTakeGroups();
    els.undoBtn.disabled = true;
    els.previewBtn.disabled = false;
    els.extractLtcBtn.disabled = ltcRecords.length === 0;
    els.exportMetadataBtn.disabled = true;
    els.combinePolyBtn.disabled = combineEligibleGroups().length === 0;
    els.writeLtcBtn.disabled = true;
    setState("已载入");
    const parts = [];
    if (metaRecords.length) parts.push(`${metaRecords.length} 个视频元数据`);
    if (videoRecords.length) parts.push(`${videoRecords.length} 个视频音轨`);
    if (wavRecords.length) {
      const takeText = takeGroupCount() ? `，识别到 ${takeGroupCount()} 个分轨 take` : "";
      parts.push(`${wavRecords.length} 个 WAV${takeText}`);
    }
    els.statusLine.textContent = `已载入 ${parts.join(" + ")}；可偏移预览或从音轨提取 LTC`;
    renderRows();
    log(`${sourceLabel}: ${newRecords.length} file(s) (${wavRecords.length} WAV, ${videoRecords.length} video, ${metaRecords.length} metadata)`);

    if (newRecords.length) {
      const fpsMeta = detectedMetadataFps(newRecords);
      if (fpsMeta && fpsDiffersFromUi(fpsMeta.value)) {
        const useMetadata = await confirmMetadataFpsMismatch({
          currentValue: fpsInput.value,
          metadata: fpsMeta,
        });
        if (useMetadata) {
          setFpsValue(fpsMeta.value);
          log(`FPS: switched to ${fpsSelectLabel(fpsMeta.value)} from file metadata`);
        } else {
          log(`FPS: kept ${fpsSelectLabel(fpsInput.value)} despite file metadata ${fpsSelectLabel(fpsMeta.value)}`);
        }
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
    } else if (entry.isFile && (wavSuffix.test(entry.name) || videoSuffix?.test(entry.name))) {
      const file = await entryFile(entry);
      const scanner = wavSuffix.test(entry.name) ? scanWave : scanVideo;
      pushRecord(await scanner({
        kind: "file",
        name: entry.name,
        getFile: async () => file,
      }, {
        relativePath: basePath,
        parentPath: basePath.split("/").slice(0, -1).join("/"),
        parentHandle: null,
      }));
    } else if (entry.isFile && metadataSuffix && metadataSuffix.test(entry.name)) {
      const file = await entryFile(entry);
      const buf = new Uint8Array(await file.arrayBuffer());
      let text;
      if (buf[0] === 0xff && buf[1] === 0xfe) {
        text = new TextDecoder("utf-16le").decode(buf.slice(2));
      } else if (buf[0] === 0xfe && buf[1] === 0xff) {
        text = new TextDecoder("utf-16be").decode(buf.slice(2));
      } else {
        text = new TextDecoder("utf-8").decode(buf);
      }
      const metaRecords = parseMetadataImport(text, entry.name);
      for (const record of metaRecords) pushRecord(record);
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
    if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持点击选择文件夹，请直接拖入音频/视频文件夹");
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
