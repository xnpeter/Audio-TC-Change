import {
  divFrac,
  fpsRate,
  frac,
  frameDigitsFor,
  parseTimecodeParts,
  timecodeSeparator,
  timecodeToFrames,
} from "./timecode.js";

export function createOffsetInputController({
  els,
  normalizeTimecodeInput,
  stepTimecodeByFrames,
  stepTimecodeAtCaret,
  insertTimecodeDigits,
  deleteTimecodeDigit,
  invalidatePreview,
  log,
}) {
  function offsetSign() {
    return els.offsetSignBtn.dataset.sign === "-1" ? -1n : 1n;
  }

  function parseOffset(raw, fps) {
    const { hh, mm, ss, ff } = parseTimecodeParts(raw, fps);
    const sign = offsetSign();
    const frames = timecodeToFrames(raw, fps) * sign;
    const offsetSeconds = divFrac(frac(frames), fpsRate(fps));
    const signLabel = sign < 0n ? "-" : "+";
    const sep = timecodeSeparator(fps);
    return {
      label: `${signLabel}${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}${sep}${String(ff).padStart(frameDigitsFor(fps), "0")}`,
      fps,
      frames,
      seconds: offsetSeconds,
    };
  }

  function toggleOffsetSign() {
    const next = offsetSign() < 0n ? "1" : "-1";
    els.offsetSignBtn.dataset.sign = next;
    els.offsetSignBtn.textContent = next === "-1" ? "−" : "+";
    els.offsetSignBtn.title = next === "-1" ? "当前为减偏移，点击切换为加" : "当前为加偏移，点击切换为减";
    els.offsetSignBtn.setAttribute("aria-label", next === "-1" ? "当前为减偏移" : "当前为加偏移");
    invalidatePreview();
  }

  function bindEvents() {
    els.offsetSignBtn.addEventListener("click", toggleOffsetSign);
    els.tcUpBtn.addEventListener("click", () => {
      try { stepTimecodeByFrames(els.offsetInput, 1); } catch (error) { log(`ERROR: ${error.message}`); }
    });
    els.tcDownBtn.addEventListener("click", () => {
      try { stepTimecodeByFrames(els.offsetInput, -1); } catch (error) { log(`ERROR: ${error.message}`); }
    });
    els.offsetInput.addEventListener("focus", () => els.offsetInput.select());
    els.offsetInput.addEventListener("input", () => normalizeTimecodeInput(els.offsetInput));
    els.offsetInput.addEventListener("paste", event => {
      event.preventDefault();
      insertTimecodeDigits(els.offsetInput, event.clipboardData.getData("text"));
    });
    els.offsetInput.addEventListener("blur", () => normalizeTimecodeInput(els.offsetInput));
    els.offsetInput.addEventListener("keydown", event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      try {
        if (/^\d$/.test(event.key)) {
          event.preventDefault();
          insertTimecodeDigits(els.offsetInput, event.key);
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          deleteTimecodeDigit(els.offsetInput, event.key === "Backspace");
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          stepTimecodeAtCaret(els.offsetInput, event.key === "ArrowUp" ? 1 : -1);
        }
      } catch (error) {
        log(`ERROR: ${error.message}`);
      }
    });
  }

  return {
    bindEvents,
    offsetSign,
    parseOffset,
  };
}
