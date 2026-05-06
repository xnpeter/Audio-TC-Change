<h1 align="center">Audio TC Change</h1>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-8bd11f?labelColor=555"></a>
  <a href="https://github.com/xnpeter/Audio-TC-Change/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/xnpeter/Audio-TC-Change?style=social"></a>
  <img alt="Current release" src="https://img.shields.io/badge/release-v0.4.3-202a36">
</p>

<h2 align="center">把跑偏的声音时码拉回正轨</h2>

<p align="center">
  <a href="#english">English</a>
  ·
  <a href="#中文">简体中文</a>
  ·
  <a href="https://audiotc.nuomi.video/">在线体验</a>
</p>

<p align="center">
  Audio TC Change is a free, open-source, browser-based tool for viewing and editing WAV/BWF timecode, extracting LTC, and exporting video file (MOV/MP4) timecode as metadata. It runs locally in Chrome or Edge, so your files stay on your machine.
</p>

## 中文

### 它解决什么问题

你有没有遇到过这些情况：

- 一天拍摄结束，声音素材交到后期，发现有一部分音频文件的时码整体偏了。
- 录音机外接时码掉了，某一段没有 jam 成功，或者现场各种原因导致音频起始 TC 和画面素材对不上。
- 手头只有 ZOOM H6 这类没有时码接口的录音机，但又不想手动合板。
- 现场把 LTC 录进了某一路音轨，希望后期从这一路音频里读出时间码，再写回 WAV/BWF metadata。

Audio TC Change 为这些问题提供一个本地的一站式方案。它主要做三件事：

1. 批量修改 WAV/BWF 音频文件的起始时码。
2. 从音频或视频音轨里提取 LTC，并倒推出文件起始时码。
3. 读取 MOV/MP4 视频文件的内嵌时码，导出为 Resolve CSV / Avid ALE 元数据。

### 为什么做这个工具

这不是一个新需求，市面上也已经有不少工具能处理时间码或 LTC，例如 QTchange、DaVinci Resolve、Premiere Pro、Tentacle TC Tool、Tentacle Sync Studio、EASYNC LTC、Sidus TC Sync。

但在实际测试和现场工作流里，它们各自有一些限制：

- QTchange
  - 3.4.5 版本批量修改 WAV 时码后可能不生效。
  - 3.4.8 版本已修复部分问题，但经测试偏移数值仍可能不符合预期，也不适合一起处理混合帧率音频文件。
- DaVinci Resolve
  - 更偏向视频素材流程，不能直接从纯音频文件中提取 LTC。
  - 不能批量偏移音频片段时码。
- Premiere Pro
  - 24.6 之后才支持 LTC 提取。
  - 对纯音频文件的 LTC 提取默认 24fps，非 24fps 素材容易得到错误结果。
- 厂商工具
  - Tentacle TC Tool 只有 Windows 版。
  - Tentacle Sync Studio 需要购买 Tentacle 设备或单独授权。
  - EASYNC LTC 免费版一次处理数量有限，完整版需要连接易声时码器。
  - Sidus TC Sync 不能直接修改文件时码。

更关键的是，如果一个文件不是从开头就有 LTC，而是只有后面几秒录到了 LTC；或者 LTC 电平偏小、信号质量不理想，很多软件会直接提取失败或得到错误结果。

Audio TC Change 的 LTC 检测逻辑会扫描音频中可用的稳定 LTC 片段，再根据 LTC 出现的位置倒推出整个文件的真实起始时码。

### 主要功能

- 内置时间码计算器，方便计算两个时间码之间的差值。
- 批量查看 WAV/BWF 文件的起始 TC、结束 TC、采样率、帧率和 TimeReference。
- 支持 MOV/MP4 视频文件，读取内嵌时码（tmcd/rtmd）并导出元数据。
- 批量偏移音频文件时间码，支持正负偏移。
- 可直接写回 WAV/BWF 文件，也可导出 Resolve CSV 或 Avid ALE 元数据。
- 从音频或视频音轨提取 LTC，适合处理只有部分长度存在 LTC 信号的素材。
- 自动识别 LTC 帧率，支持 23.976 到 120fps 的常见 DF 与 NDF 时码。
- 支持混合帧率素材的时间码偏移。
- 读取 iXML 中的帧率信息，并在文件 metadata 与界面帧率不一致时提示确认。
- 针对 ZOOM H 系列多轨 mono 文件结构做分组显示，例如 `ZOOM0001_Tr1.WAV`、`ZOOM0001_Tr2.WAV`。
- 将 ZOOM H 系列分轨 mono/stereo take 批量合并为 Poly WAV，并写入 iXML track name。
- 写入前预览结果，写入后生成 CSV 修改清单。
- 支持撤销上一次写入。

### 工作原理

#### 时码编辑

WAV/BWF 文件的起始时码本质上不是一串 `HH:MM:SS:FF` 字符，而是从当天 00:00:00 开始累计的音频 sample count。

Audio TC Change 会：

- 把用户输入的时间码或偏移量换算成精确的 sample count。
- 写回 BWF 的 `bext.TimeReference`。
- 如果文件原本存在 iXML 时间戳，也同步更新 iXML 里的 `TIMESTAMP_SAMPLES_SINCE_MIDNIGHT`。
- 写入后验证 bext 和 iXML 是否一致。

工具修改的是 WAV 文件头 metadata，不重编码音频，不改变声音内容，也不改变文件时长。视频文件仅读取时码信息，不直接修改视频文件本身，通过导出元数据（CSV/ALE）的方式传递时码到剪辑软件。

#### LTC 提取

LTC 是被录进音轨里的音频信号。Audio TC Change 会分析波形，而不是只读取文件开头附近的信号。

检测流程包括：

- 先快速扫描前 5 秒；如果没有锁定高质量结果，继续扫描完整音频。
- 从信号翻转边沿估计 half-bit samples，自动推断帧率。
- 还原 biphase mark code，并解析 LTC 帧。
- 读取 LTC drop-frame 标记，检查 DF/NDF 是否匹配。
- 只有检测到连续多帧时间码稳定递增时才采用结果。
- 记录 LTC 帧出现在文件中的 sample 位置，并倒推出文件起点。

换句话说，即使 LTC 只出现在文件后面几秒，工具也可以通过：

```text
文件起始时码 = 读到的 LTC 时码 - LTC 在文件中的 sample 偏移量
```

计算出正确的 BWF 起始 TimeReference。

### 使用特点

- 跨平台、无需安装：纯前端构建，使用 Chrome 或 Edge 打开即可使用。
- 完全本地处理：所有文件仅在浏览器中本地处理，不上传云端。
- 支持离线使用：本应用是 Progressive Web App，可安装为本地 App 后离线使用。

### 使用方式

推荐直接使用在线版本：

```text
https://audiotc.nuomi.video/
```

也可以本地运行：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开：

```text
http://127.0.0.1:8765/
```

Chrome 或 Edge 推荐使用，因为写回本地文件依赖 File System Access API。

### 建议流程

1. 先复制一份素材，或确认已有备份。
2. 载入音频文件夹。
3. 确认帧率设置，或按文件 metadata 提示切换。
4. 输入偏移量，或使用时间码计算器计算差值。
5. 点击预览，检查新起始 TC 和新结束 TC。
6. 选择写回 WAV/BWF，或导出 Resolve CSV / Avid ALE。
7. 在目标剪辑软件中抽查结果。

### 注意

写回模式会直接修改 WAV/BWF 文件 metadata。正式素材建议先备份，或先用一小批文件测试目标剪辑软件兼容性。

### 后续计划

- 继续优化低质量 LTC 的提取能力。
- 支持 poly 拆分成 mono。

---

## English

### What It Solves

Production audio timecode can go wrong in a few familiar ways:

- After a shoot day, part of the audio arrives in post with a global timecode offset.
- The recorder lost external timecode, a section was not jammed correctly, or the audio start TC simply does not match picture.
- You only have a recorder such as the ZOOM H6, with no dedicated timecode input, but you do not want to sync everything manually.
- LTC was recorded onto one audio channel, and you want to read that signal and write the result back into WAV/BWF metadata.

Audio TC Change provides a local, browser-based workflow for these cases. It mainly does three things:

1. Batch-edit WAV/BWF audio start timecode.
2. Extract LTC from an audio or video track and calculate the file start timecode.
3. Read embedded timecode from MOV/MP4 video files and export as Resolve CSV / Avid ALE metadata.

### Why This Exists

This is not a new problem. Tools such as QTchange, DaVinci Resolve, Premiere Pro, Tentacle TC Tool, Tentacle Sync Studio, EASYNC LTC, and Sidus TC Sync can all handle parts of the workflow.

In real-world tests, however, each has limitations:

- QTchange
  - Version 3.4.5 may fail to apply batch WAV timecode changes.
  - Version 3.4.8 fixes part of the issue, but offset values may still be unreliable in some tests, and mixed-frame-rate batches are not handled well.
- DaVinci Resolve
  - LTC extraction is centered around video media and does not directly support pure audio files.
  - It does not provide a simple batch audio timecode offset workflow.
- Premiere Pro
  - LTC extraction is only available from version 24.6 onward.
  - Pure audio LTC extraction defaults to 24fps, which can produce incorrect results for non-24fps material.
- Manufacturer tools
  - Tentacle TC Tool is Windows-only.
  - Tentacle Sync Studio requires Tentacle hardware or a separate license.
  - EASYNC LTC free mode has batch limits, and the full workflow requires connecting EASYNC hardware.
  - Sidus TC Sync cannot directly rewrite file timecode metadata.

More importantly, many tools fail when LTC is incomplete: for example, when the file only contains LTC near the end, or when the LTC level is low and the signal is not ideal.

Audio TC Change searches for a stable usable LTC segment anywhere in the audio, then uses the detected LTC position to calculate the real file start timecode.

### Features

- Built-in timecode calculator for offset calculation.
- Batch inspection of WAV/BWF start TC, end TC, sample rate, frame rate, and TimeReference.
- Support MOV/MP4 video files — read embedded timecode (tmcd/rtmd) and export as metadata.
- Batch positive or negative timecode offsets.
- Write timecode back into WAV/BWF files, or export Resolve CSV / Avid ALE metadata.
- Extract LTC from audio or video tracks, including files where LTC exists only in part of the recording.
- Auto-detect LTC frame rate, supporting common DF and NDF rates from 23.976 to 120fps.
- Handle mixed-frame-rate material during offset operations.
- Read iXML frame-rate metadata and warn when it differs from the UI setting.
- Group ZOOM H-series style split mono files, such as `ZOOM0001_Tr1.WAV` and `ZOOM0001_Tr2.WAV`.
- Batch-combine ZOOM H-series split mono/stereo takes into Poly WAV with iXML track names.
- Preview before writing and generate a CSV manifest after writing.
- Undo the previous write operation.

### How It Works

#### Timecode Editing

WAV/BWF start timecode is not stored as a `HH:MM:SS:FF` string. It is stored as an audio sample count since midnight.

Audio TC Change:

- Converts user-entered timecode or offset values into an exact sample count.
- Writes the value to BWF `bext.TimeReference`.
- If iXML timestamp fields already exist, updates `TIMESTAMP_SAMPLES_SINCE_MIDNIGHT` as well.
- Verifies that bext and iXML agree after writing.

The tool changes WAV file header metadata only. It does not re-encode audio, change the sound content, or change file duration. Video files are read-only — timecode is exported as metadata (CSV/ALE) for use in editing software.

#### LTC Extraction

LTC is an audio signal recorded into a track. Audio TC Change analyzes the waveform directly instead of only checking for LTC near the beginning of the file.

The decoder:

- Quickly scans the first 5 seconds; if no high-quality lock is found, it scans the full file.
- Estimates half-bit samples from signal edge intervals and infers frame rate.
- Reconstructs biphase mark code and decodes LTC frames.
- Reads the LTC drop-frame flag and checks DF/NDF consistency.
- Accepts a result only after finding multiple consecutive, stable, incrementing frames.
- Records where the LTC frame appears in the file, then calculates the file start.

This allows the app to handle files where LTC only appears near the end:

```text
file start timecode = decoded LTC timecode - LTC sample offset inside the file
```

### Usage Notes

- Cross-platform and no install required: open it in Chrome or Edge.
- Fully local processing: files stay in the browser and are not uploaded.
- Offline capable: the app is a Progressive Web App and can be installed for offline use.

### Run

Use the hosted version:

```text
https://audiotc.nuomi.video/
```

Or run it locally:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8765/
```

Chrome or Edge is recommended because writing local files depends on the File System Access API.

### Suggested Workflow

1. Work on a copy, or make sure the source audio is backed up.
2. Load the audio folder.
3. Confirm the frame-rate setting, or switch based on file metadata prompts.
4. Enter an offset manually, or calculate it with the timecode calculator.
5. Preview the new start and end timecode.
6. Write back to WAV/BWF, or export Resolve CSV / Avid ALE.
7. Spot-check the result in the target editing software.

### Warning

Write-back mode directly modifies WAV/BWF metadata. For production material, back up first and test a small batch in the target editing software before processing everything.

### Roadmap

- Better extraction from low-quality LTC recordings.
- Poly-to-mono split workflows.

## License

MIT
