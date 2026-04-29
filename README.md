# Audio TC Change

## 中文

Audio TC Change 是一个给现场录音文件修时间码的小工具。它在浏览器里运行，文件留在本机，适合在交剪辑前快速检查和批量修正 WAV/BWF 文件的起始时间码。

### 它解决什么问题

现场录音有时会遇到这些情况：

- 录音机的时间码整体偏移了几秒、几分钟，甚至几个小时。
- 某一天或某一批素材的音频时间码和画面时间码对不上。
- 录音机没有接入 timecode input，只录下了 LTC 音频轨。
- 分轨 WAV 文件很多，需要按 take 一起处理。
- 剪辑软件读取的时间码和声音软件读取的时间码不一致。

这个工具的目标很简单：**让一批 WAV/BWF 文件的起始时间码变成你想要的时间。**

### 主要功能

- 批量载入文件夹里的 WAV/BWF 文件。
- 查看每个文件当前的起始和结束时间码。
- 输入正负偏移，批量把时间码提前或延后。
- 从两个时间码计算偏移量，减少手算错误。
- 从音频波形里检测 LTC，并把检测到的时间写回文件。
- 导入时读取文件 iXML 里记录的帧率；如果和界面设置不一致，会提示用户选择。
- LTC 检测时会尝试自动判断帧率和 DF/NDF，并在和用户设置不一致时提示确认。
- 对 ZOOM H 系列这类分轨文件按 take 分组显示。
- 写入前预览结果，写入后生成 CSV 修改清单。
- 支持撤销上一次写入。

### 关于兼容性

工具会修正 BWF/WAV 文件里用于定位起始时间的元数据。对于同时带有 BWF 和 iXML 时间信息的文件，写入时会尽量保持两边一致，避免不同软件读到不同的起始时间码。

如果音频文件本身记录了项目帧率，工具会把它作为参考；但 23.976/24、29.97/30 这类非常接近的帧率仍建议以项目设置和剪辑软件测试为准。

常见来源包括：

- ZOOM F6
- ZOOM H6 / H 系列分轨文件
- Sound Devices MixPre 系列
- 其他写入 BWF/iXML 元数据的录音机

### 使用方式

建议用 Chrome 或 Edge 打开，因为写回本地文件需要浏览器的 File System Access API。

在项目目录下启动本地服务：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开：

```text
http://127.0.0.1:8765/
```

### 建议流程

1. 先复制一份素材或确认已有备份。
2. 载入音频文件夹。
3. 选择正确帧率。
4. 用时间码计算器或手动输入偏移量。
5. 点击预览，确认新起始时间码。
6. 写入。
7. 把生成的 CSV 清单和修正后的音频一起交给后期。

### 注意

这个工具会直接修改 WAV 文件元数据。正式素材建议先备份，或先在一小批文件上测试剪辑软件兼容性。

---

## English

Audio TC Change is a small browser-based tool for fixing timecode metadata in production audio files. It runs locally in the browser and is designed for checking and batch-correcting WAV/BWF start timecode before handoff to editorial.

### Problems It Solves

Production audio can run into situations like:

- The recorder timecode is offset by seconds, minutes, or hours.
- A whole shoot day or batch of audio does not line up with picture.
- The recorder had no timecode input and only recorded LTC as an audio track.
- Split-track WAV files need to be handled by take.
- Editing software and audio tools show different start timecodes.

The goal is simple: **make a batch of WAV/BWF files start at the correct timecode.**

### Features

- Load a folder of WAV/BWF files.
- Inspect original start and end timecode.
- Apply positive or negative offsets in batch.
- Calculate offsets from two timecodes.
- Detect LTC from audio waveform and write it back as file timecode.
- Read frame-rate metadata from iXML on import and warn when it differs from the UI setting.
- Attempt to auto-detect LTC frame rate and DF/NDF, then ask before switching away from the user-selected setting.
- Group split-track takes from recorders such as the ZOOM H series.
- Preview before writing and export a CSV manifest after writing.
- Undo the previous write operation.

### Compatibility

The tool updates the metadata used by WAV/BWF files to describe their start time. For files that contain both BWF and iXML time metadata, it keeps them synchronized so different applications are less likely to show conflicting start timecodes.

When files include their own frame-rate metadata, the app uses it as a reference. Very close rates such as 23.976/24 or 29.97/30 should still be confirmed against the project setting and the target editing software.

Common recorder sources include:

- ZOOM F6
- ZOOM H6 / H-series split-track files
- Sound Devices MixPre series
- Other recorders that write BWF/iXML metadata

### Run Locally

Chrome or Edge is recommended because writing local files requires the File System Access API.

From the project directory:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8765/
```

### Suggested Workflow

1. Work on a copy or make sure the source audio is backed up.
2. Load the audio folder.
3. Choose the correct frame rate.
4. Enter an offset manually or calculate it from two timecodes.
5. Preview the new start timecode.
6. Write changes.
7. Deliver the generated CSV manifest with the corrected audio.

### Note

This tool directly modifies WAV metadata. For production material, test a small batch in the target editing software before processing everything.
