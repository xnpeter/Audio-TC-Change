const READ_WRITE = { mode: "readwrite" };

export function isLooseWritableRecord(record) {
  return Boolean(
    record &&
    !record._meta &&
    !record._video &&
    !record.parentHandle &&
    typeof record.fileHandle?.createWritable === "function"
  );
}

// Must run while the click that started the write still counts as a user gesture;
// a folder grant covers every file inside it, so the browser stops asking per file.
export function createWritePermissionController({ getRootDirectories, log }) {
  async function ensureFolderWriteAccess() {
    for (const directory of getRootDirectories()) {
      if (typeof directory?.queryPermission !== "function") continue;
      if (await directory.queryPermission(READ_WRITE) === "granted") continue;
      let state;
      try {
        state = await directory.requestPermission(READ_WRITE);
      } catch (error) {
        log(`Permission WARN: ${directory.name}: ${error.message}`);
        continue;
      }
      if (state !== "granted") throw new Error(`未获得文件夹“${directory.name}”的写入权限`);
      log(`Permission OK: write access to folder ${directory.name}`);
    }
  }

  return { ensureFolderWriteAccess };
}
