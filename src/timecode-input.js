import {
  dropFramesFor,
  frameDigitsFor,
  framesToTimecode,
  nominalFpsFor,
  parseFps,
  timecodeDigitCount,
  timecodeDigitPositions,
  timecodeSeparator,
  timecodeToFrames,
} from "./timecode.js";

export function createTimecodeInputController({ getFps, getFpsValue, onInvalidate }) {
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function legalizeTimecodeParts({ hh, mm, ss, ff }, fps = getFps()) {
  const nominalFps = Number(nominalFpsFor(fps));
  const dropFrames = Number(dropFramesFor(fps));
  const safe = {
    hh: clampNumber(Number.isFinite(hh) ? hh : 0, 0, 99),
    mm: clampNumber(Number.isFinite(mm) ? mm : 0, 0, 59),
    ss: clampNumber(Number.isFinite(ss) ? ss : 0, 0, 59),
    ff: clampNumber(Number.isFinite(ff) ? ff : 0, 0, nominalFps - 1),
  };
  if (dropFrames && safe.ss === 0 && safe.mm % 10 !== 0 && safe.ff < dropFrames) {
    safe.ff = dropFrames;
  }
  return safe;
}

function timecodePartsFromDigits(digits, fps = getFps()) {
  const frameDigits = frameDigitsFor(fps);
  const digitCount = 6 + frameDigits;
  const padded = digits.padEnd(digitCount, "0").slice(0, digitCount);
  return {
    hh: Number(padded.slice(0, 2)),
    mm: Number(padded.slice(2, 4)),
    ss: Number(padded.slice(4, 6)),
    ff: Number(padded.slice(6)),
  };
}

function timecodePartsFromRaw(raw, fps = getFps()) {
  const frameDigits = frameDigitsFor(fps);
  const parts = String(raw || "").trim().replaceAll(";", ":").split(":");
  if (parts.length === 4) {
    const numberPart = (value, maxDigits) => {
      const digits = String(value).replace(/\D/g, "").slice(0, maxDigits);
      return digits ? Number(digits) : 0;
    };
    return {
      hh: numberPart(parts[0].padStart(2, "0"), 2),
      mm: numberPart(parts[1].padStart(2, "0"), 2),
      ss: numberPart(parts[2].padStart(2, "0"), 2),
      ff: numberPart(parts[3], frameDigits),
    };
  }
  return timecodePartsFromDigits(clampDigits(raw, fps), fps);
}

function formatTimecodeParts(parts, fps = getFps()) {
  const safe = legalizeTimecodeParts(parts, fps);
  return `${String(safe.hh).padStart(2, "0")}:${String(safe.mm).padStart(2, "0")}:${String(safe.ss).padStart(2, "0")}${timecodeSeparator(fps)}${String(safe.ff).padStart(frameDigitsFor(fps), "0")}`;
}

function formatTimecodeEntryDigits(digits, fps = getFps()) {
  const frameDigits = frameDigitsFor(fps);
  const segments = [
    { key: "hh", length: 2 },
    { key: "mm", length: 2 },
    { key: "ss", length: 2 },
    { key: "ff", length: frameDigits },
  ];
  const parts = { hh: "00", mm: "00", ss: "00", ff: "0".repeat(frameDigits) };
  const numericParts = { hh: 0, mm: 0, ss: 0, ff: 0 };
  let cursor = 0;
  for (const segment of segments) {
    const chunk = digits.slice(cursor, cursor + segment.length);
    cursor += segment.length;
    if (!chunk) continue;
    const value = Number(chunk);
    if (chunk.length === segment.length) {
      numericParts[segment.key] = legalizeTimecodeParts({ ...numericParts, [segment.key]: value }, fps)[segment.key];
      parts[segment.key] = String(numericParts[segment.key]).padStart(segment.length, "0");
    } else {
      numericParts[segment.key] = value;
      parts[segment.key] = chunk;
    }
  }
  return `${parts.hh}:${parts.mm}:${parts.ss}${timecodeSeparator(fps)}${parts.ff}`;
}

function formatTimecodeDigits(digits, fps = getFps()) {
  return formatTimecodeParts(timecodePartsFromDigits(digits, fps), fps);
}

function clampDigits(raw, fps = getFps()) {
  return raw.replace(/\D/g, "").slice(0, timecodeDigitCount(fps));
}

function digitIndexFromCaret(input, caret = null) {
  const fps = getFps();
  const pos = caret ?? input.selectionStart ?? input.value.length;
  const digitPositions = timecodeDigitPositions(fps);
  let index = digitPositions.findIndex(position => position >= pos);
  if (index === -1) index = digitPositions.length - 1;
  if (input.value[pos] === ":" || input.value[pos] === ";") index = Math.min(digitPositions.length - 1, index + 1);
  return index;
}

function setTimecodeValueFromDigits(input, digits, caretDigitIndex = null) {
  const fps = getFps();
  input.value = formatTimecodeDigits(digits, fps);
  if (caretDigitIndex !== null) {
    const digitPositions = timecodeDigitPositions(fps);
    const safe = Math.max(0, Math.min(digitPositions.length - 1, caretDigitIndex));
    input.setSelectionRange(digitPositions[safe], digitPositions[safe] + 1);
  }
}

function setTimecodeValueFromEntryDigits(input, digits, caretDigitIndex = null) {
  const fps = getFps();
  input.value = formatTimecodeEntryDigits(digits, fps);
  if (caretDigitIndex !== null) {
    const digitPositions = timecodeDigitPositions(fps);
    const safe = Math.max(0, Math.min(digitPositions.length - 1, caretDigitIndex));
    input.setSelectionRange(digitPositions[safe], digitPositions[safe] + 1);
  }
}

function clearTimecodePendingSegment(input) {
  delete input.dataset.tcPendingSegmentStart;
  delete input.dataset.tcPendingSegmentDigits;
  delete input.dataset.tcPendingSegmentBaseDigits;
  delete input.dataset.tcPendingWholeDigits;
}

function timecodeSegmentForDigitIndex(digitIndex, fps = getFps()) {
  const frameDigits = frameDigitsFor(fps);
  return [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
    { start: 4, end: 6 },
    { start: 6, end: 6 + frameDigits },
  ].find(range => digitIndex >= range.start && digitIndex < range.end) || null;
}

function caretAfterLegalizedInsert(digits, startDigitIndex, nextCaretDigitIndex, fps = getFps()) {
  const parts = timecodePartsFromDigits(digits, fps);
  const safe = legalizeTimecodeParts(parts, fps);
  const frameDigits = frameDigitsFor(fps);
  const ranges = [
    { start: 0, end: 2, raw: parts.hh, safe: safe.hh },
    { start: 2, end: 4, raw: parts.mm, safe: safe.mm },
    { start: 4, end: 6, raw: parts.ss, safe: safe.ss },
    { start: 6, end: 6 + frameDigits, raw: parts.ff, safe: safe.ff },
  ];
  const range = ranges.find(item => startDigitIndex >= item.start && startDigitIndex < item.end);
  if (!range || range.raw === range.safe) return nextCaretDigitIndex;
  if (nextCaretDigitIndex < range.end) return range.end;
  return nextCaretDigitIndex;
}

function normalizeTimecodeInput(input, caretDigitIndex = null, invalidate = true) {
  clearTimecodePendingSegment(input);
  const fps = getFps();
  input.value = formatTimecodeParts(timecodePartsFromRaw(input.value, fps), fps);
  if (caretDigitIndex !== null) {
    const digitPositions = timecodeDigitPositions(fps);
    const safe = Math.max(0, Math.min(digitPositions.length - 1, caretDigitIndex));
    input.setSelectionRange(digitPositions[safe], digitPositions[safe] + 1);
  }
  if (invalidate) onInvalidate();
}

function stepTimecodeByFrames(input, deltaFrames, invalidate = true) {
  clearTimecodePendingSegment(input);
  const fps = parseFps(getFpsValue());
  const frames = timecodeToFrames(input.value, fps) + BigInt(deltaFrames);
  input.value = framesToTimecode(frames, fps);
  input.setSelectionRange(input.value.length, input.value.length);
  if (invalidate) onInvalidate();
}

function timecodeDigitIndexAtCaret(input) {
  const fps = getFps();
  const caret = input.selectionStart ?? input.value.length;
  const digitPositions = timecodeDigitPositions(fps);
  let index = digitPositions.findIndex(position => position >= caret);
  if (index === -1) index = digitPositions.length - 1;
  if (input.value[caret] === ":" || input.value[caret] === ";") index = Math.max(0, index - 1);
  return index;
}

function stepTimecodeAtCaret(input, direction, invalidate = true) {
  clearTimecodePendingSegment(input);
  const fps = parseFps(getFpsValue());
  const nominal = nominalFpsFor(fps);
  const frameDigits = frameDigitsFor(fps);
  const weights = [
    nominal * 36000n,
    nominal * 3600n,
    nominal * 600n,
    nominal * 60n,
    nominal * 10n,
    nominal,
  ];
  for (let place = frameDigits - 1; place >= 0; place--) {
    weights.push(10n ** BigInt(place));
  }
  const digitPositions = timecodeDigitPositions(fps);
  const digitIndex = timecodeDigitIndexAtCaret(input);
  const frames = timecodeToFrames(input.value, fps) + weights[digitIndex] * BigInt(direction);
  input.value = framesToTimecode(frames, fps);
  const caret = digitPositions[digitIndex];
  input.setSelectionRange(caret, caret + 1);
  if (invalidate) onInvalidate();
}

function insertTimecodeDigits(input, text, invalidate = true) {
  const fps = getFps();
  const digitCount = timecodeDigitCount(fps);
  const incoming = clampDigits(text, fps);
  if (!incoming) return;
  const selectionStart = input.selectionStart ?? 0;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  const wholeValueSelected = selectionStart === 0 && selectionEnd >= input.value.length;
  const oldDigits = wholeValueSelected ? "0".repeat(digitCount) : clampDigits(input.value, fps).padEnd(digitCount, "0").slice(0, digitCount);
  const pendingSegmentStart = Number(input.dataset.tcPendingSegmentStart);
  const pendingSegmentDigits = input.dataset.tcPendingSegmentDigits || "";
  if (!wholeValueSelected && incoming.length === 1 && Number.isFinite(pendingSegmentStart) && pendingSegmentDigits) {
    const pendingSegment = timecodeSegmentForDigitIndex(pendingSegmentStart, fps);
    const pendingSegmentLength = pendingSegment ? pendingSegment.end - pendingSegment.start : 0;
    if (pendingSegment && pendingSegmentDigits.length < pendingSegmentLength) {
      const baseDigits = (input.dataset.tcPendingSegmentBaseDigits || oldDigits).padEnd(digitCount, "0").slice(0, digitCount);
      const segmentDigits = (pendingSegmentDigits + incoming).padStart(pendingSegmentLength, "0").slice(-pendingSegmentLength);
      const nextDigits = baseDigits.slice(0, pendingSegment.start) + segmentDigits + baseDigits.slice(pendingSegment.end);
      clearTimecodePendingSegment(input);
      setTimecodeValueFromDigits(input, nextDigits, caretAfterLegalizedInsert(nextDigits, pendingSegment.start, pendingSegment.end, fps));
      if (invalidate) onInvalidate();
      return;
    }
  }
  const start = digitIndexFromCaret(input, input.selectionStart ?? 0);
  const segment = timecodeSegmentForDigitIndex(start, fps);
  const segmentLength = segment ? segment.end - segment.start : 0;

  if (incoming.length === 1 && (wholeValueSelected || input.dataset.tcPendingWholeDigits)) {
    delete input.dataset.tcPendingSegmentStart;
    delete input.dataset.tcPendingSegmentDigits;
    const pendingDigits = wholeValueSelected ? "" : (input.dataset.tcPendingWholeDigits || "");
    const nextDigits = (pendingDigits + incoming).slice(0, digitCount);
    if (nextDigits.length < digitCount) input.dataset.tcPendingWholeDigits = nextDigits;
    else delete input.dataset.tcPendingWholeDigits;
    setTimecodeValueFromEntryDigits(input, nextDigits, Math.min(nextDigits.length, digitCount - 1));
    if (invalidate) onInvalidate();
    return;
  }

  if (wholeValueSelected && incoming.length > 1) {
    clearTimecodePendingSegment(input);
    setTimecodeValueFromEntryDigits(input, incoming, Math.min(incoming.length, digitCount - 1));
    if (invalidate) onInvalidate();
    return;
  }

  if (!wholeValueSelected && incoming.length === 1 && segment && segmentLength > 1) {
    const pendingStart = Number(input.dataset.tcPendingSegmentStart);
    const pendingDigits = input.dataset.tcPendingSegmentDigits || "";
    if (pendingStart === segment.start && start === segment.start + pendingDigits.length && pendingDigits.length < segmentLength) {
      const segmentDigits = (pendingDigits + incoming).padStart(segmentLength, "0").slice(-segmentLength);
      const nextDigits = oldDigits.slice(0, segment.start) + segmentDigits + oldDigits.slice(segment.end);
      clearTimecodePendingSegment(input);
      setTimecodeValueFromDigits(input, nextDigits, caretAfterLegalizedInsert(nextDigits, segment.start, segment.end, fps));
      if (invalidate) onInvalidate();
      return;
    }

    if (start === segment.start) {
      const segmentDigits = incoming.padEnd(segmentLength, "0");
      const nextDigits = oldDigits.slice(0, segment.start) + segmentDigits + oldDigits.slice(segment.end);
      input.dataset.tcPendingSegmentStart = String(segment.start);
      input.dataset.tcPendingSegmentDigits = incoming;
      input.dataset.tcPendingSegmentBaseDigits = oldDigits;
      const rawDisplayDigits = oldDigits.slice(0, segment.start) + incoming;
      setTimecodeValueFromEntryDigits(input, rawDisplayDigits, segment.start + 1);
      if (invalidate) onInvalidate();
      return;
    }
  }

  clearTimecodePendingSegment(input);
  const nextDigits = (
    oldDigits.slice(0, start) +
    incoming +
    oldDigits.slice(start + incoming.length)
  ).slice(0, digitCount);
  const nextCaret = start + incoming.length;
  setTimecodeValueFromDigits(input, nextDigits, caretAfterLegalizedInsert(nextDigits, start, nextCaret, fps));
  if (invalidate) onInvalidate();
}

function deleteTimecodeDigit(input, backspace, invalidate = true) {
  clearTimecodePendingSegment(input);
  const fps = getFps();
  const digitCount = timecodeDigitCount(fps);
  const oldDigits = clampDigits(input.value, fps).padEnd(digitCount, "0").slice(0, digitCount);
  const index = digitIndexFromCaret(input, input.selectionStart ?? 0);
  const target = backspace ? Math.max(0, index - 1) : index;
  const nextDigits = oldDigits.slice(0, target) + "0" + oldDigits.slice(target + 1);
  setTimecodeValueFromDigits(input, nextDigits, target);
  if (invalidate) onInvalidate();
}



  return {
    clampNumber,
    legalizeTimecodeParts,
    timecodePartsFromDigits,
    timecodePartsFromRaw,
    formatTimecodeParts,
    formatTimecodeEntryDigits,
    formatTimecodeDigits,
    clampDigits,
    digitIndexFromCaret,
    setTimecodeValueFromDigits,
    setTimecodeValueFromEntryDigits,
    clearTimecodePendingSegment,
    timecodeSegmentForDigitIndex,
    caretAfterLegalizedInsert,
    normalizeTimecodeInput,
    stepTimecodeByFrames,
    timecodeDigitIndexAtCaret,
    stepTimecodeAtCaret,
    insertTimecodeDigits,
    deleteTimecodeDigit,
  };
}
