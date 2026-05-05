export function setupPwa({ installBtn, log }) {
  let deferredInstallPrompt = null;

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installBtn.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installBtn.hidden = true;
    log("PWA installed.");
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  if (!("serviceWorker" in navigator)) {
    log("PWA: service worker is not supported in this browser.");
    return;
  }

  if (!["http:", "https:"].includes(window.location.protocol)) {
    log("PWA: open through http://127.0.0.1 or HTTPS to enable install/offline mode.");
    return;
  }

  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker.register("./bwf-timecode-sw.js")
    .then(registration => {
      registration.update();
      log("PWA: offline cache ready.");
    })
    .catch(error => log(`PWA ERROR: ${error.message}`));
}
