export function createUiStateController({ els }) {
  function setState(text, kind = "ok") {
    els.stateText.textContent = text;
    els.stateText.style.color = kind === "err" ? "var(--danger)" : kind === "warn" ? "var(--warn)" : "var(--ink)";
  }

  function log(line) {
    const time = new Date().toLocaleTimeString();
    els.log.textContent = `[${time}] ${line}\n` + els.log.textContent;
  }

  function showToast(message, duration = 2600) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    setTimeout(() => els.toast.classList.remove("show"), duration);
  }

  function updateWriteProgress(label, fileText, done, total) {
    const ratio = total ? done / total : 0;
    const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    els.progressLabel.textContent = label;
    els.progressFile.textContent = fileText;
    els.progressFill.style.width = `${percent}%`;
    els.progressPct.textContent = `${percent}%`;
  }

  async function guarded(fn) {
    try {
      await fn();
    } catch (error) {
      setState("错误", "err");
      els.statusLine.textContent = error.message;
      log(`ERROR: ${error.message}`);
    }
  }

  return {
    guarded,
    log,
    setState,
    showToast,
    updateWriteProgress,
  };
}
