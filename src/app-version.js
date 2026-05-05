export async function appVersion() {
  try {
    const response = await fetch("./bwf-timecode-sw.js", { cache: "no-store" });
    if (!response.ok) throw new Error("service worker version unavailable");
    const text = await response.text();
    return text.match(/CACHE_NAME\s*=\s*["'][^"']*v([^"']+)["']/)?.[1] || "dev";
  } catch (error) {
    return "dev";
  }
}

export async function renderAppVersion(badge) {
  badge.textContent = `v${await appVersion()}`;
}
