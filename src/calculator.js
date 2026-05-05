import {
  framesToTimecode,
  parseFps,
  timecodeToFrames,
} from "./timecode.js";

export function createCalculatorController({
  els,
  log,
  invalidatePreview,
  normalizeTimecodeInput,
  stepTimecodeByFrames,
  stepTimecodeAtCaret,
  insertTimecodeDigits,
  deleteTimecodeDigit,
  showToast,
}) {
  let calculatorOffset = null;
  let calcBMode = "timecode";

  function calcFrameValue() {
    const digits = String(els.calcFrameInput.value || "").replace(/\D/g, "");
    return digits ? BigInt(digits) : 0n;
  }

  function normalizeCalcFrameInput() {
    const digits = String(els.calcFrameInput.value || "").replace(/\D/g, "");
    els.calcFrameInput.value = digits.replace(/^0+(?=\d)/, "") || "0";
  }

  function calculateTimecodeDifference() {
    const fps = parseFps(els.fpsInput.value);
    const startFrames = timecodeToFrames(els.calcStartInput.value, fps);
    const endFrames = calcBMode === "frames"
      ? calcFrameValue()
      : timecodeToFrames(els.calcEndInput.value, fps);
    const op = els.calcOpBtn.dataset.op === "-" ? "-" : "+";
    const resultFrames = op === "-" ? startFrames - endFrames : startFrames + endFrames;
    const absFrames = resultFrames < 0n ? -resultFrames : resultFrames;
    const signLabel = resultFrames < 0n ? "-" : "";
    const tc = framesToTimecode(absFrames, fps);
    calculatorOffset = { frames: resultFrames, tc };
    els.calcResult.textContent = `${signLabel}${tc}`;
    els.calcTotalFrames.textContent = `${resultFrames.toString()} 帧`;
    els.useCalcBtn.disabled = false;
  }

  function refreshCalculator() {
    try {
      calculateTimecodeDifference();
    } catch (error) {
      log(`ERROR: ${error.message}`);
    }
  }

  function toggleCalculatorOperator() {
    const next = els.calcOpBtn.dataset.op === "-" ? "+" : "-";
    els.calcOpBtn.dataset.op = next;
    els.calcOpBtn.textContent = next === "-" ? "−" : "+";
    refreshCalculator();
  }

  function setCalcBMode(mode) {
    calcBMode = mode === "frames" ? "frames" : "timecode";
    const frameMode = calcBMode === "frames";
    els.calcEndTimecodeControl.hidden = frameMode;
    els.calcFrameControl.hidden = !frameMode;
    els.calcBLabel.textContent = frameMode ? "帧数 B" : "时间码 B";
    els.calcBModeTimecodeBtn.classList.toggle("active", !frameMode);
    els.calcBModeFramesBtn.classList.toggle("active", frameMode);
    els.calcEndUpBtn.disabled = frameMode;
    els.calcEndDownBtn.disabled = frameMode;
    if (frameMode) normalizeCalcFrameInput();
    refreshCalculator();
  }

  function swapCalculatorTimecodes() {
    if (calcBMode !== "timecode") {
      showToast("帧模式下不能交换 A/B");
      return;
    }
    const a = els.calcStartInput.value;
    els.calcStartInput.value = els.calcEndInput.value;
    els.calcEndInput.value = a;
    normalizeTimecodeInput(els.calcStartInput, null, false);
    normalizeTimecodeInput(els.calcEndInput, null, false);
    refreshCalculator();
  }

  function useCalculatorResult() {
    if (!calculatorOffset) calculateTimecodeDifference();
    const result = calculatorOffset;
    els.offsetSignBtn.dataset.sign = result.frames < 0n ? "-1" : "1";
    els.offsetSignBtn.textContent = result.frames < 0n ? "−" : "+";
    els.offsetSignBtn.title = result.frames < 0n ? "当前为减偏移，点击切换为加" : "当前为加偏移，点击切换为减";
    els.offsetSignBtn.setAttribute("aria-label", result.frames < 0n ? "当前为减偏移" : "当前为加偏移");
    els.offsetInput.value = result.tc;
    invalidatePreview();
  }

  function bindEvents({ guarded }) {
    els.useCalcBtn.addEventListener("click", () => guarded(useCalculatorResult));
    els.calcOpBtn.addEventListener("click", toggleCalculatorOperator);
    els.calcBModeTimecodeBtn.addEventListener("click", () => setCalcBMode("timecode"));
    els.calcBModeFramesBtn.addEventListener("click", () => setCalcBMode("frames"));
    els.calcSwapBtn.addEventListener("click", swapCalculatorTimecodes);

    els.calcStartUpBtn.addEventListener("click", () => {
      try { stepTimecodeByFrames(els.calcStartInput, 1, false); refreshCalculator(); } catch (error) { log(`ERROR: ${error.message}`); }
    });
    els.calcStartDownBtn.addEventListener("click", () => {
      try { stepTimecodeByFrames(els.calcStartInput, -1, false); refreshCalculator(); } catch (error) { log(`ERROR: ${error.message}`); }
    });
    els.calcEndUpBtn.addEventListener("click", () => {
      try { stepTimecodeByFrames(els.calcEndInput, 1, false); refreshCalculator(); } catch (error) { log(`ERROR: ${error.message}`); }
    });
    els.calcEndDownBtn.addEventListener("click", () => {
      try { stepTimecodeByFrames(els.calcEndInput, -1, false); refreshCalculator(); } catch (error) { log(`ERROR: ${error.message}`); }
    });

    els.calcFrameInput.addEventListener("focus", () => els.calcFrameInput.select());
    els.calcFrameInput.addEventListener("input", () => {
      normalizeCalcFrameInput();
      refreshCalculator();
    });
    els.calcFrameInput.addEventListener("paste", event => {
      event.preventDefault();
      els.calcFrameInput.value = event.clipboardData.getData("text");
      normalizeCalcFrameInput();
      refreshCalculator();
    });
    els.calcFrameInput.addEventListener("blur", () => {
      normalizeCalcFrameInput();
      refreshCalculator();
    });
    els.calcFrameInput.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); refreshCalculator(); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const current = calcFrameValue();
        const next = event.key === "ArrowUp" ? current + 1n : (current > 0n ? current - 1n : 0n);
        els.calcFrameInput.value = next.toString();
        refreshCalculator();
      }
    });

    for (const input of [els.calcStartInput, els.calcEndInput]) {
      input.addEventListener("focus", () => input.select());
      input.addEventListener("input", () => {
        normalizeTimecodeInput(input, null, false);
        refreshCalculator();
      });
      input.addEventListener("paste", event => {
        event.preventDefault();
        insertTimecodeDigits(input, event.clipboardData.getData("text"), false);
        refreshCalculator();
      });
      input.addEventListener("blur", () => {
        normalizeTimecodeInput(input, null, false);
        refreshCalculator();
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); refreshCalculator(); return; }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        try {
          if (/^\d$/.test(event.key)) {
            event.preventDefault();
            insertTimecodeDigits(input, event.key, false);
            refreshCalculator();
            return;
          }
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            deleteTimecodeDigit(input, event.key === "Backspace", false);
            refreshCalculator();
            return;
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            stepTimecodeAtCaret(input, event.key === "ArrowUp" ? 1 : -1, false);
            refreshCalculator();
          }
        } catch (error) {
          log(`ERROR: ${error.message}`);
        }
      });
    }
  }

  return {
    bindEvents,
    refreshCalculator,
  };
}
