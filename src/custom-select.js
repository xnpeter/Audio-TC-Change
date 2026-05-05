export function initCustomSelect(select, button, menu) {
  const field = select.closest("[data-select]");
  const buttonLabel = button.querySelector("span");

  function options() {
    return [...select.options];
  }

  function menuButtons() {
    return [...menu.querySelectorAll(".select-option")];
  }

  function selectedIndex() {
    return Math.max(0, select.selectedIndex);
  }

  function syncDisplay() {
    const selected = select.options[selectedIndex()];
    buttonLabel.textContent = selected ? selected.textContent : "";
    for (const item of menuButtons()) {
      const isSelected = item.dataset.value === select.value;
      item.setAttribute("aria-selected", String(isSelected));
      item.classList.toggle("active", isSelected);
    }
  }

  function closeMenu() {
    field.classList.remove("open");
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    field.classList.add("open");
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    syncDisplay();
    menuButtons()[selectedIndex()]?.scrollIntoView({ block: "nearest" });
  }

  function chooseIndex(index) {
    const next = options()[index];
    if (!next) return;
    select.value = next.value;
    syncDisplay();
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  for (const option of options()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "select-option";
    item.role = "option";
    item.dataset.value = option.value;
    item.textContent = option.textContent;
    item.addEventListener("click", () => {
      chooseIndex(options().findIndex(entry => entry.value === option.value));
      closeMenu();
      button.focus();
    });
    menu.appendChild(item);
  }

  button.addEventListener("click", () => {
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  button.addEventListener("keydown", event => {
    const keyMoves = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (menu.hidden) openMenu();
      else closeMenu();
      return;
    }
    if (event.key in keyMoves) {
      event.preventDefault();
      const nextIndex = Math.min(options().length - 1, Math.max(0, selectedIndex() + keyMoves[event.key]));
      chooseIndex(nextIndex);
      openMenu();
      return;
    }
    if (event.key === "Escape") {
      closeMenu();
    }
  });

  document.addEventListener("click", event => {
    if (!field.contains(event.target)) closeMenu();
  });

  select.addEventListener("change", syncDisplay);
  syncDisplay();
}
