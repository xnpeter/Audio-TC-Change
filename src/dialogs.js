export function createDialogController(els) {
  function resetAltButton() {
    els.confirmAltBtn.hidden = true;
    els.confirmAltBtn.textContent = "";
    els.confirmAltBtn.onclick = null;
  }

  function showConfirmDialog({
    title,
    copy,
    cancelText = "取消",
    confirmText = "确认",
    altText = "",
    cancelResult = false,
    confirmResult = true,
    altResult = "alt",
    danger = false,
  }) {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      let settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        els.confirmOverlay.classList.remove("show");
        els.confirmOverlay.setAttribute("aria-hidden", "true");
        els.confirmCancelBtn.removeEventListener("click", onCancel);
        els.confirmAltBtn.removeEventListener("click", onAlt);
        els.confirmWriteBtn.removeEventListener("click", onConfirm);
        document.removeEventListener("keydown", onKeydown);
        previousFocus?.focus?.();
        resolve(result);
      }

      function onCancel() {
        close(cancelResult);
      }

      function onAlt() {
        close(altResult);
      }

      function onConfirm() {
        close(confirmResult);
      }

      function onKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close(cancelResult);
        }
      }

      els.confirmTitle.textContent = title;
      els.confirmCopy.innerHTML = copy;
      els.confirmCancelBtn.textContent = cancelText;
      resetAltButton();
      if (altText) {
        els.confirmAltBtn.textContent = altText;
        els.confirmAltBtn.hidden = false;
      }
      els.confirmWriteBtn.textContent = confirmText;
      els.confirmWriteBtn.classList.toggle("danger", danger);
      els.confirmOverlay.classList.add("show");
      els.confirmOverlay.setAttribute("aria-hidden", "false");
      els.confirmCancelBtn.addEventListener("click", onCancel);
      els.confirmAltBtn.addEventListener("click", onAlt);
      els.confirmWriteBtn.addEventListener("click", onConfirm);
      document.addEventListener("keydown", onKeydown);
      requestAnimationFrame(() => els.confirmCancelBtn.focus());
    });
  }

  function chooseMetadataFormat() {
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      let settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        els.confirmOverlay.classList.remove("show");
        els.confirmOverlay.setAttribute("aria-hidden", "true");
        els.confirmCancelBtn.removeEventListener("click", onCancel);
        els.confirmAltBtn.removeEventListener("click", onAle);
        els.confirmWriteBtn.removeEventListener("click", onResolve);
        document.removeEventListener("keydown", onKeydown);
        previousFocus?.focus?.();
        resolve(result);
      }

      function onCancel() { close(null); }
      function onAle() { close("ale"); }
      function onResolve() { close("resolve"); }
      function onKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close(null);
        }
      }

      els.confirmTitle.textContent = "导出为元数据";
      els.confirmCopy.innerHTML = [
        "请选择要导出的元数据格式。",
        "<strong>Resolve CSV</strong> 适合 DaVinci Resolve 导入；<strong>ALE</strong> 适合 Avid/场记/日样交换流程。"
      ].join("<br>");
      els.confirmCancelBtn.textContent = "取消";
      els.confirmAltBtn.textContent = "ALE";
      els.confirmWriteBtn.textContent = "Resolve CSV";
      els.confirmWriteBtn.classList.remove("danger");
      els.confirmAltBtn.hidden = false;
      els.confirmOverlay.classList.add("show");
      els.confirmOverlay.setAttribute("aria-hidden", "false");
      els.confirmCancelBtn.addEventListener("click", onCancel);
      els.confirmAltBtn.addEventListener("click", onAle);
      els.confirmWriteBtn.addEventListener("click", onResolve);
      document.addEventListener("keydown", onKeydown);
      requestAnimationFrame(() => els.confirmWriteBtn.focus());
    });
  }

  return { chooseMetadataFormat, showConfirmDialog };
}
