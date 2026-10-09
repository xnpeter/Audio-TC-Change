const TAB_KEY = "audioTc.inspectorTab";
const CALC_KEY = "audioTc.calculatorCollapsed";

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export function setupWorkspaceLayout(root = document) {
  const tabs = [...root.querySelectorAll(".tabs .tab[data-tab]")];
  const panels = [...root.querySelectorAll(".tab-panel[data-panel]")];

  function activateTab(name) {
    if (!panels.some(panel => panel.dataset.panel === name)) return;
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    writePref(TAB_KEY, name);
  }

  for (const tab of tabs) tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  activateTab(readPref(TAB_KEY) || "offset");

  root.getElementById("useCalcBtn")?.addEventListener("click", () => activateTab("offset"));

  const calcPanel = root.getElementById("calculatorPanel");
  const calcBody = root.getElementById("calcBody");
  const calcCollapseBtn = root.getElementById("calcCollapseBtn");
  function setCalcCollapsed(collapsed) {
    calcBody.hidden = collapsed;
    calcPanel.classList.toggle("collapsed", collapsed);
    calcCollapseBtn.textContent = collapsed ? "展开" : "收起";
    calcCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
    writePref(CALC_KEY, collapsed ? "1" : "0");
  }
  calcCollapseBtn.addEventListener("click", () => setCalcCollapsed(!calcBody.hidden));
  setCalcCollapsed(readPref(CALC_KEY) === "1");

  const consolePanel = root.getElementById("consolePanel");
  const logToggleBtn = root.getElementById("logToggleBtn");
  logToggleBtn.addEventListener("click", () => {
    const expanded = !consolePanel.classList.contains("expanded");
    consolePanel.classList.toggle("expanded", expanded);
    logToggleBtn.setAttribute("aria-expanded", String(expanded));
  });

  return { activateTab };
}
