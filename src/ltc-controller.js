import {
  fpsLabel,
  parseFps,
} from "./timecode.js";
import { readDataView } from "./wave.js";
import {
  ltcScanPriority,
  ltcScanRecords,
  recordKey,
  shortGroupLabel,
} from "./grouping.js";
import {
  LTC_WORKER_CODE,
  WorkerPool,
} from "./ltc-worker.js";
import { createLtcDecoder } from "./ltc-decoder.js";

export function createLtcController({
  els,
  getRecords,
  getLtcResults,
  setLtcResults,
  recordsByGroup,
  groupLabel,
  fpsSelectLabel,
  setFpsValue,
  samplesToTimecode,
  defaultDisplayFps,
  confirmLtcFpsMismatch,
  setState,
  updateWriteProgress,
  log,
  renderRows,
}) {
  const ltcWorkerPool = window.Worker
    ? new WorkerPool(LTC_WORKER_CODE, Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 6)))
    : null;

  const decoder = createLtcDecoder({
    readDataView,
    candidateFpsValues: () => Array.from(els.fpsInput.options).map(option => option.value),
    defaultFpsValue: () => els.fpsInput.value,
    fpsSelectLabel,
  });

  function ltcStartTimecode(result, record) {
    if (result?.newTimeReference == null || !record) return result?.timecode || "";
    return samplesToTimecode(result.newTimeReference, record.sampleRate, result.fps || defaultDisplayFps(), { wrapDay: true });
  }

  function ltcStatusText(result, record, fps) {
    if (!result?.ok || result.newTimeReference == null) return result?.statusText || "待检测";
    const dropNote = result.dropMismatch ? " · DF标记不符" : "";
    const qualityNote = result.qualityLabel ? ` · 质量${result.qualityLabel}` : "";
    const sourceName = result.sourceRecord?.name || "已检测";
    const sourceChannel = `channel ${result.channelLabel}`;
    const fpsNote = `(${result.fpsLabel || fpsLabel(result.fps || fps)})`;
    const isSource = result.sourceRecord && recordKey(record) === recordKey(result.sourceRecord);
    return isSource
      ? `${fpsNote}${sourceChannel} · ${Math.round(result.confidence * 100)}%${qualityNote}${dropNote}`
      : `链接自 ${sourceName} · ${sourceChannel} · ${Math.round(result.confidence * 100)}%${qualityNote}${dropNote}`;
  }

  function reviveWorkerLtcResult(result) {
    if (!result) return null;
    const reviveOne = item => {
      if (!item) return null;
      return {
        ...item,
        frames: BigInt(item.frames),
        newTimeReference: BigInt(item.newTimeReference),
        fps: parseFps(item.fpsValue),
        fpsLabel: fpsSelectLabel(item.fpsValue),
      };
    };
    return {
      ...result,
      best: reviveOne(result.best),
      preferred: reviveOne(result.preferred),
      results: (result.results || []).map(reviveOne),
    };
  }

  async function detectLtcAutoWorker(record, fps, scanSeconds = null, options = {}) {
    const sampleLimit = scanSeconds == null
      ? record.durationSamples
      : BigInt(Math.max(record.sampleRate * scanSeconds, record.sampleRate));
    const maxSamples = Number(record.durationSamples < sampleLimit ? record.durationSamples : sampleLimit);
    const bytesToRead = Math.min(record.dataSize, maxSamples * record.blockAlign);
    const buffer = await record.file.slice(record.dataOffset, record.dataOffset + bytesToRead).arrayBuffer();
    const preferredValue = fps.value || els.fpsInput.value;
    const values = [
      preferredValue,
      ...decoder.candidateFpsValues().filter(value => value !== preferredValue),
    ];
    const result = await ltcWorkerPool.run({
      buffer,
      preferredValue,
      values,
      record: {
        name: record.name,
        sampleRate: record.sampleRate,
        channels: record.channels,
        bitsPerSample: record.bitsPerSample,
        audioFormat: record.audioFormat,
        blockAlign: record.blockAlign,
      },
      allowSoftSync: options.allowSoftSync === true,
    }, [buffer]);
    const revived = reviveWorkerLtcResult(result);
    if (revived) revived.scanSeconds = scanSeconds;
    return revived;
  }

  function isHighQualityFastLtc(auto) {
    const best = auto?.best;
    if (!best) return false;
    return best.qualityRank >= 3 &&
      best.lockedFrames >= 6 &&
      best.halfBitError <= 0.0025 &&
      best.rejectRatio <= 0.08 &&
      best.confidence >= 0.82;
  }

  function tagLtcAutoResult(auto, flags) {
    if (!auto) return auto;
    for (const result of [auto.best, auto.preferred, ...(auto.results || [])]) {
      if (result) Object.assign(result, flags);
    }
    return auto;
  }

  async function detectLtcFast(record, fps) {
    if (!ltcWorkerPool) return null;
    const fast = await detectLtcAutoWorker(record, fps, 5, { allowSoftSync: false });
    return tagLtcAutoResult(fast, { fastScan: true });
  }

  async function detectLtcFull(record, fps, options = {}) {
    const allowSoftSync = options.allowSoftSync === true;
    if (!ltcWorkerPool) return decoder.detectAuto(record, fps, { allowSoftSync });
    const full = await detectLtcAutoWorker(record, fps, null, { allowSoftSync });
    return tagLtcAutoResult(full, {
      fullFileScan: true,
      manualFallback: allowSoftSync,
    });
  }

  async function detectLtcAuto(record, fps, options = {}) {
    const allowSoftSync = options.allowSoftSync === true;
    if (ltcWorkerPool) {
      const fast = await detectLtcFast(record, fps);
      if (isHighQualityFastLtc(fast)) {
        return fast;
      }
      return tagLtcAutoResult(await detectLtcFull(record, fps, options), {
        fastFallback: Boolean(fast?.best || fast?.rejectedChannels?.length),
      });
    }
    return decoder.detectAuto(record, fps, { allowSoftSync });
  }

  function shouldPromptForAutoFps(auto, currentValue) {
    if (!auto.best || auto.best.fpsValue === currentValue) return false;
    if (auto.best.halfBitError > 0.008) return false;
    const current = auto.preferred;
    if (!current) return true;
    if ((auto.best.qualityRank || 0) > (current.qualityRank || 0)) return true;
    return current.halfBitError - auto.best.halfBitError > 0.00035;
  }

  function selectedLtcResult(auto, fpsValue) {
    return auto.best?.fpsValue === fpsValue ? auto.best : auto.preferred;
  }

  function bestTakeAttempt(attempts, fpsValue, allowFpsPrompt) {
    let detectError = null;
    const candidates = [];

    for (const attempt of attempts) {
      if (attempt.error) {
        detectError = attempt.error;
        continue;
      }
      const { record, auto } = attempt;
      if (shouldPromptForAutoFps(auto, fpsValue) && allowFpsPrompt) {
        return {
          fpsMismatch: {
            record,
            auto,
            currentValue: fpsValue,
            detectedValue: auto.best.fpsValue,
            detectedTimecode: auto.best.timecode,
          },
          detectError,
        };
      }

      const result = selectedLtcResult(auto, fpsValue);
      if (result) candidates.push({ record, result });
    }

    candidates.sort((a, b) => decoder.compareResults(a.result, b.result));
    const best = candidates[0];
    return {
      detected: best ? { ...best.result, sourceRecord: best.record } : null,
      detectError,
    };
  }

  async function detectLtcForTake(takeKey, groupRecords, fps, fpsValue, allowFpsPrompt, options = {}) {
    const scanRecords = ltcScanRecords(groupRecords);
    const scanPasses = [
      scanRecords.filter(record => ltcScanPriority(record) === 0),
      scanRecords.filter(record => ltcScanPriority(record) === 1),
      scanRecords.filter(record => ltcScanPriority(record) >= 2),
    ].filter(pass => pass.length);

    let detectError = null;
    if (ltcWorkerPool) {
      const fastAttempts = [];
      for (const record of scanRecords) {
        try {
          fastAttempts.push({ record, auto: await detectLtcFast(record, fps), error: null });
        } catch (error) {
          fastAttempts.push({ record, auto: null, error });
        }
      }

      const fastResult = bestTakeAttempt(fastAttempts, fpsValue, allowFpsPrompt);
      if (fastResult.fpsMismatch) return { takeKey, groupRecords, ...fastResult };
      if (fastResult.detected && decoder.isHighQualityCandidate(fastResult.detected)) {
        return {
          takeKey,
          groupRecords,
          detected: { ...fastResult.detected, groupKey: takeKey },
          detectError,
        };
      }
      if (fastResult.detectError) detectError = fastResult.detectError;
    }

    for (const pass of scanPasses) {
      const attempts = [];
      for (const record of pass) {
        try {
          attempts.push({
            record,
            auto: ltcWorkerPool
              ? await detectLtcFull(record, fps, options)
              : await detectLtcAuto(record, fps, options),
            error: null,
          });
        } catch (error) {
          attempts.push({ record, auto: null, error });
        }
        const partial = bestTakeAttempt(attempts, fpsValue, allowFpsPrompt);
        if (partial.fpsMismatch) return { takeKey, groupRecords, ...partial };
        if (partial.detected && decoder.isHighQualityCandidate(partial.detected)) {
          return {
            takeKey,
            groupRecords,
            detected: { ...partial.detected, groupKey: takeKey },
            detectError,
          };
        }
      }
      const result = bestTakeAttempt(attempts, fpsValue, allowFpsPrompt);
      if (result.fpsMismatch) return { takeKey, groupRecords, ...result };
      if (result.detectError) detectError = result.detectError;
      if (result.detected) return {
        takeKey,
        groupRecords,
        detected: { ...result.detected, groupKey: takeKey },
        detectError,
      };
    }

    return { takeKey, groupRecords, detected: null, detectError };
  }

  async function extractLtcFromFiles(options = {}) {
    const selectedKeys = options.selectedRecordKeys;
    const records = getRecords();
    if (!records.length) throw new Error("请先拖入 WAV 或视频文件");
    let fpsValue = els.fpsInput.value;
    let allowFpsPrompt = true;
    const allowSoftSync = options.allowSoftSync === true;

    while (true) {
      const fps = parseFps(fpsValue);
      const allGroups = Array.from(recordsByGroup().entries());
      const groups = selectedKeys?.size
        ? allGroups.filter(([, groupRecords]) => groupRecords.some(record => selectedKeys.has(recordKey(record))))
        : allGroups;
      if (!groups.length) throw new Error("没有找到可增强识别的选中素材");
      let restartWithFps = null;
      if (!selectedKeys?.size) setLtcResults(new Map());
      els.writeLtcBtn.disabled = true;
      setState("LTC检测中", "warn");
      els.statusLine.textContent = allowSoftSync
        ? "正在对选中素材启用兜底模式读取 LTC；低质量结果请人工确认..."
        : "正在按文件/take 从音频波形读取 LTC...";
      updateWriteProgress("正在检测 LTC…", "", 0, groups.length);
      els.progressOverlay.classList.add("show");

      try {
        const preflightResults = new Map();
        if (allowFpsPrompt && !allowSoftSync && groups.length > 1) {
          updateWriteProgress("正在确认 LTC 帧率…", shortGroupLabel(groups[0]?.[0] || "根目录"), 0, groups.length);
          for (let i = 0; i < groups.length; i++) {
            const [takeKey, groupRecords] = groups[i];
            const probe = await detectLtcForTake(takeKey, groupRecords, fps, fpsValue, allowFpsPrompt, { allowSoftSync: false });
            if (probe.fpsMismatch) {
              els.progressOverlay.classList.remove("show");
              const useAuto = await confirmLtcFpsMismatch({
                currentValue: probe.fpsMismatch.currentValue,
                detectedValue: probe.fpsMismatch.detectedValue,
                detectedTimecode: probe.fpsMismatch.detectedTimecode,
                group: groupLabel(probe.groupRecords[0]),
              });
              allowFpsPrompt = false;

              if (useAuto) {
                restartWithFps = probe.fpsMismatch.detectedValue;
                setFpsValue(restartWithFps);
                break;
              }

              els.progressOverlay.classList.add("show");
              break;
            }
            preflightResults.set(takeKey, probe);
            if (probe.detected) break;
          }
        }

        if (restartWithFps) {
          fpsValue = restartWithFps;
          continue;
        }

        const takeConcurrency = Math.max(2, Math.min(ltcWorkerPool?.workers.length || 2, 6));
        for (let i = 0; i < groups.length; i += takeConcurrency) {
          const batch = groups.slice(i, i + takeConcurrency);
          updateWriteProgress("正在检测 LTC…", shortGroupLabel(batch[0]?.[0] || "根目录"), i, groups.length);
          const batchResults = await Promise.all(batch.map(([takeKey, groupRecords]) =>
            preflightResults.get(takeKey) ||
            detectLtcForTake(takeKey, groupRecords, fps, fpsValue, allowFpsPrompt, { allowSoftSync })
          ));

          const mismatch = batchResults.find(result => result.fpsMismatch);
          if (mismatch && allowFpsPrompt) {
            els.progressOverlay.classList.remove("show");
            const useAuto = await confirmLtcFpsMismatch({
              currentValue: mismatch.fpsMismatch.currentValue,
              detectedValue: mismatch.fpsMismatch.detectedValue,
              detectedTimecode: mismatch.fpsMismatch.detectedTimecode,
              group: groupLabel(mismatch.groupRecords[0]),
            });
            allowFpsPrompt = false;

            if (useAuto) {
              restartWithFps = mismatch.fpsMismatch.detectedValue;
              setFpsValue(restartWithFps);
              break;
            }

            els.progressOverlay.classList.add("show");
            i = -takeConcurrency;
            continue;
          }

          const ltcResults = getLtcResults();
          for (const { groupRecords, detected, detectError } of batchResults) {
            if (detected) {
              for (const record of groupRecords) {
                const startTimecode = samplesToTimecode(detected.newTimeReference, record.sampleRate, detected.fps || fps, { wrapDay: true });
                const result = {
                  ...detected,
                  record,
                  ok: true,
                  status: "ok",
                  startTimecode,
                  sourceTimecode: detected.timecode,
                };
                result.statusText = ltcStatusText(result, record, fps);
                ltcResults.set(recordKey(record), result);
              }
              const dropNote = detected.dropMismatch ? " · DF标记与当前设置不符" : "";
              const logStartTc = samplesToTimecode(detected.newTimeReference, groupRecords[0].sampleRate, detected.fps || fps, { wrapDay: true });
              const scanMode = detected.fastScan ? "fast" : detected.fullFileScan ? "full-file" : "full";
              log(`LTC OK: ${groupLabel(groupRecords[0])} -> start ${logStartTc}, source frame ${detected.timecode} @ ${detected.sampleOffset} samples, ${detected.fpsLabel || fpsLabel(fps)}${dropNote}, source ${detected.sourceRecord.name}, ${detected.lockedFrames} frames, ${scanMode}, quality ${detected.qualityLabel}, half error ${(detected.halfBitError * 100).toFixed(3)}%, confidence ${Math.round(detected.confidence * 100)}%`);
            } else {
              for (const record of groupRecords) {
                ltcResults.set(recordKey(record), {
                  ok: false,
                  status: detectError ? "err" : "warn",
                  statusText: detectError ? detectError.message : "本take未检测到 LTC",
                });
              }
              log(detectError
                ? `LTC ERROR: ${groupLabel(groupRecords[0])}: ${detectError.message}`
                : `LTC MISS: ${groupLabel(groupRecords[0])}`);
            }
          }

          updateWriteProgress("正在检测 LTC…", shortGroupLabel(batch[batch.length - 1]?.[0] || "根目录"), Math.min(i + batch.length, groups.length), groups.length);
          renderRows();
        }

        if (restartWithFps) {
          fpsValue = restartWithFps;
          continue;
        }

        const ltcResults = getLtcResults();
        const okGroups = new Set(Array.from(ltcResults.values()).filter(result => result.ok).map(result => result.groupKey));
        const okFiles = Array.from(ltcResults.values()).filter(result => result.ok).length;
        const writableOkFiles = Array.from(ltcResults.values()).filter(result => {
          const record = result.record;
          return result.ok && record && !record._meta && !record._video && record.fileHandle?.createWritable;
        }).length;
        const lowQualityGroups = new Set(Array.from(ltcResults.values()).filter(result => result.ok && result.qualityRank === 1).map(result => result.groupKey));
        setState(okGroups.size ? (writableOkFiles ? "LTC可写入" : "LTC可导出") : "未检测到LTC", okGroups.size ? "ok" : "warn");
        els.statusLine.textContent = okGroups.size
          ? `已检测到 ${okGroups.size} 个文件/take 的 LTC；${writableOkFiles ? `可写入 ${writableOkFiles} 个 WAV，` : ""}可导出 ${okFiles} 条元数据${lowQualityGroups.size ? `；${lowQualityGroups.size} 个低质量请人工确认` : ""}`
          : "没有检测到可用的 LTC";
        renderRows();
        break;
      } finally {
        els.progressOverlay.classList.remove("show");
        updateWriteProgress("正在写入…", "", 0, groups.length || 1);
      }
    }
  }

  return {
    extractLtcFromFiles,
    ltcStartTimecode,
    ltcStatusText,
  };
}
