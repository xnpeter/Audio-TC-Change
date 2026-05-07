import { combineTrackPlan } from "./wave-combine.js";
import { shortGroupLabel } from "./grouping.js";

export function createConfirmFlows({ showConfirmDialog, fpsSelectLabel }) {
  function confirmWriteChanges(count, includesLtcMute = false) {
    return showConfirmDialog({
      title: "确认写入文件？",
      danger: true,
      confirmText: "确认写入",
      copy: includesLtcMute
        ? [
          `即将写入 <strong>${count}</strong> 个 WAV 的 BWF TimeReference，并将检测到的 LTC 声道/分轨静音。`,
          "<strong>静音音频轨道或分轨无法用撤销按钮恢复</strong>，请确认已有原始文件备份。"
        ].join("<br>")
        : [
          `即将写入 <strong>${count}</strong> 个 WAV 的 BWF TimeReference。`,
          "<strong>建议在修改前先备份原始文件</strong>，确认备份或可恢复后再继续。"
        ].join("<br>"),
    });
  }

  function confirmCombinePoly(groups, options = {}) {
    const trackCounts = groups.map(([key, groupRecords]) => {
      const tracks = combineTrackPlan(groupRecords);
      return `${shortGroupLabel(key)}：${tracks.length} 轨`;
    });
    const batchMode = groups.length > 1;
    const hasPreviewTimecode = Boolean(options.hasPreviewTimecode);
    const hasLtcTimecode = Boolean(options.hasLtcTimecode);
    const hasAlternateTimecode = hasLtcTimecode || hasPreviewTimecode;
    const muteLtc = Boolean(options.muteLtc);
    const chromeFolderWarning = [
      "由于 Chrome 的安全限制，",
      "<strong>请不要直接选择“下载”“文稿”“桌面”等受保护的常用文件夹。</strong>",
      "请先在里面新建一个子文件夹再选择。"
    ].join("<br>");
    return showConfirmDialog({
      title: "合并为 Poly WAV？",
      altText: hasAlternateTimecode ? "使用原始时码" : "",
      altResult: "original",
      confirmText: hasLtcTimecode
        ? "使用LTC时码"
        : hasPreviewTimecode
          ? "使用预览时码"
        : batchMode ? "选择输出文件夹" : "选择保存位置",
      confirmResult: hasLtcTimecode ? "ltc" : hasPreviewTimecode ? "preview" : true,
      copy: [
        `将把 <strong>${groups.length}</strong> 个分轨 take 合并为 Poly WAV。`,
        trackCounts.slice(0, 6).join("<br>"),
        groups.length > 6 ? `还有 ${groups.length - 6} 个 take…` : "",
        hasLtcTimecode ? "<strong>检测到当前有可用的 LTC 时码。</strong>你可以只把 LTC 起始时码写进新 Poly，源分轨不会被修改。" : "",
        hasLtcTimecode && muteLtc ? "<strong>已勾选静音 LTC 轨。</strong>新 Poly 中对应的 LTC 轨道会被写成静音；源分轨不会被修改。" : "",
        hasLtcTimecode && !muteLtc ? "当前未勾选静音 LTC 轨，新 Poly 会保留 LTC 音频。" : "",
        !hasLtcTimecode && hasPreviewTimecode ? "<strong>检测到当前有未写入的时码修改预览。</strong>你可以只把预览后的起始时码写进新 Poly，源分轨不会被修改。" : "",
        batchMode ? "批量合并会让你选择一个输出文件夹；同名文件会被覆盖。" : "",
        batchMode ? chromeFolderWarning : "",
        "原始文件不会被修改。"
      ].filter(Boolean).join("<br>"),
    });
  }

  function confirmLtcFpsMismatch({ currentValue, detectedValue, detectedTimecode, group }) {
    return showConfirmDialog({
      title: "LTC 帧率可能不匹配",
      cancelText: `按当前 ${fpsSelectLabel(currentValue)}`,
      confirmText: `改用 ${fpsSelectLabel(detectedValue)}`,
      copy: [
        `当前设置是 <strong>${fpsSelectLabel(currentValue)}</strong>，但 LTC 波形更像 <strong>${fpsSelectLabel(detectedValue)}</strong>。`,
        `检测到的时码：<strong>${detectedTimecode}</strong>${group ? `（${group}）` : ""}`,
        "请选择继续按当前设置解析，还是切换到自动识别的帧率重新检测。"
      ].join("<br>"),
    });
  }

  function confirmMetadataFpsMismatch({ currentValue, metadata }) {
    return showConfirmDialog({
      title: "文件记录的帧率不同",
      cancelText: `保持 ${fpsSelectLabel(currentValue)}`,
      confirmText: `改用 ${fpsSelectLabel(metadata.value)}`,
      copy: [
        `当前界面设置是 <strong>${fpsSelectLabel(currentValue)}</strong>。`,
        `导入文件的元数据里有 <strong>${metadata.count}/${metadata.total}</strong> 个文件记录为 <strong>${fpsSelectLabel(metadata.value)}</strong>。`,
        "预览会优先按每个文件的元数据帧率计算；界面设置只用于没有元数据帧率的文件和输入格式。"
      ].join("<br>"),
    });
  }

  return {
    confirmCombinePoly,
    confirmLtcFpsMismatch,
    confirmMetadataFpsMismatch,
    confirmWriteChanges,
  };
}
