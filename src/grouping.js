export function recordKey(record) {
  return record.relativePath || record.name;
}

export function recordLabel(record) {
  return record.relativePath || record.name;
}

export function groupKeyFor(record, takeGroupKeys) {
  if (!record.parentPath) return recordKey(record);
  return takeGroupKeys.has(record.parentPath) ? record.parentPath : recordKey(record);
}

export function groupLabelFor(record, takeGroupKeys) {
  return takeGroupKeys.has(record.parentPath) ? record.parentPath : recordLabel(record);
}

export function shortGroupLabel(key) {
  const parts = key.split("/").filter(Boolean);
  return parts[parts.length - 1] || key || "根目录";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasSplitTrackNamePattern(record) {
  if (!record.parentPath) return false;
  const stem = (record.name || "").replace(/\.[^.]+$/, "");
  const parent = escapeRegExp(shortGroupLabel(record.parentPath));
  const parentPrefixed = new RegExp(`^${parent}(?:[_\\-\\s].+)?$`, "i").test(stem);
  const trackSuffix = /(?:^|[_\-\s])(?:tr|trk|track|tk|ch|chan|channel)\s*(?:\d+(?:\s*[-_]\s*\d+)?|[lr](?:\s*[-_]\s*[lr])?)$/i;
  const lrSuffix = /(?:^|[_\-\s])l\s*[-_ ]?\s*r$/i;
  return trackSuffix.test(stem) || (parentPrefixed && lrSuffix.test(stem));
}

export function hasZoomHNamePattern(record) {
  return hasSplitTrackNamePattern(record);
}

function durationRange(group) {
  const durations = group.map(record => BigInt(record.durationSamples));
  return {
    min: durations.reduce((min, value) => value < min ? value : min, durations[0]),
    max: durations.reduce((max, value) => value > max ? value : max, durations[0]),
  };
}

function takeDurationTolerance(group) {
  const sampleRate = group.find(record => Number.isFinite(record.sampleRate) && record.sampleRate > 0)?.sampleRate || 1;
  return BigInt(Math.ceil(sampleRate));
}

function hasCompatibleTakeDuration(group) {
  if (!group.length) return false;
  const { min, max } = durationRange(group);
  return max - min <= takeDurationTolerance(group);
}

function hasExactSameDuration(group) {
  if (!group.length) return false;
  const { min, max } = durationRange(group);
  return max === min;
}

function splitTrackStem(record) {
  const stem = (record.name || "").replace(/\.[^.]+$/, "");
  const trackMatch = stem.match(/^(.*?)(?:[_\-\s])(?:tr|trk|track|tk|ch|chan|channel)\s*(?:\d+(?:\s*[-_]\s*\d+)?|[lr](?:\s*[-_]\s*[lr])?)$/i);
  if (trackMatch?.[1]) return trackMatch[1].trim().toLowerCase();
  const lrMatch = stem.match(/^(.*?)(?:[_\-\s])l\s*[-_ ]?\s*r$/i);
  if (lrMatch?.[1]) return lrMatch[1].trim().toLowerCase();
  return "";
}

function hasStrongSplitTrackSet(group) {
  const stems = new Map();
  for (const record of group) {
    const stem = splitTrackStem(record);
    if (!stem) continue;
    stems.set(stem, (stems.get(stem) || 0) + 1);
  }
  return Array.from(stems.values()).some(count => count >= 2);
}

export function ltcScanPriority(record) {
  const name = record.name || "";
  if (record.channels === 1 && hasZoomHNamePattern(record)) return 0;
  if (record.channels === 1) return 1;
  if (/_LR\.wav$/i.test(name)) return 3;
  return 2;
}

export function ltcScanRecords(groupRecords) {
  return [...groupRecords].sort((a, b) => {
    const priority = ltcScanPriority(a) - ltcScanPriority(b);
    if (priority) return priority;
    return (a.name || "").localeCompare(b.name || "");
  });
}

export function detectTakeGroupKeys(recordList) {
  const folders = new Map();
  for (const record of recordList) {
    if (!record.parentPath) continue;
    if (!folders.has(record.parentPath)) folders.set(record.parentPath, []);
    folders.get(record.parentPath).push(record);
  }

  const keys = new Set();
  for (const [folder, group] of folders) {
    if (group.length < 2) continue;

    const sampleRates = new Set(group.map(record => record.sampleRate));
    const bits = new Set(group.map(record => record.bitsPerSample));
    const formats = new Set(group.map(record => record.audioFormat));
    if (sampleRates.size !== 1 || bits.size !== 1 || formats.size !== 1) continue;

    const hasTrackNames = group.filter(hasSplitTrackNamePattern).length >= 2;

    if (hasTrackNames && (hasCompatibleTakeDuration(group) || hasStrongSplitTrackSet(group))) keys.add(folder);
  }
  return keys;
}

export function isTakeTrackFor(record, takeGroupKeys) {
  return Boolean(record.parentPath && takeGroupKeys.has(record.parentPath));
}

export function isZoomLrFile(record) {
  return /_LR\.wav$/i.test(record.name);
}

export function zoomTrackNumber(record) {
  const match = record.name.match(/(?:^|[_-])Tr(\d+)\.wav$/i);
  return match ? Number(match[1]) : null;
}

export function zoomTrackNumbers(record) {
  const match = record.name.match(/(?:^|[_-])Tr(\d+)\.wav$/i);
  if (!match) return [];
  const digits = match[1];
  if (record.channels > 1 && digits.length === record.channels) {
    return Array.from(digits, digit => Number(digit));
  }
  return [Number(digits)];
}

export function combineSortValue(record) {
  if (isZoomLrFile(record)) return 0;
  const tracks = zoomTrackNumbers(record);
  if (tracks.length) return 10 + tracks[0];
  return 1000;
}

export function recordsByGroupFor(recordList, takeGroupKeys) {
  const groups = new Map();
  for (const record of recordList) {
    const key = groupKeyFor(record, takeGroupKeys);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

export function combineEligibleGroupsFor(recordList, takeGroupKeys) {
  return Array.from(recordsByGroupFor(recordList, takeGroupKeys).entries())
    .filter(([, groupRecords]) => groupRecords.length > 1 && groupRecords.every(record => isTakeTrackFor(record, takeGroupKeys)))
    .filter(([, groupRecords]) => hasExactSameDuration(groupRecords))
    .filter(([, groupRecords]) => groupRecords.some(record => record.channels > 1) || groupRecords.some(record => record.channels === 1));
}
