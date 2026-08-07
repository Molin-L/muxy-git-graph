import { el } from "./dom.ts";

export interface MenuAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

export type MenuEntry = MenuAction | "divider";

let openMenu: HTMLElement | null = null;
let teardown: (() => void) | null = null;

export function closeContextMenu(): void {
  teardown?.();
  teardown = null;
  openMenu?.remove();
  openMenu = null;
}

export function openContextMenu(x: number, y: number, entries: readonly MenuEntry[]): void {
  closeContextMenu();
  if (entries.length === 0) return;

  const menu = el("div", "menu");
  for (const entry of entries) {
    if (entry === "divider") {
      if (menu.lastElementChild) menu.appendChild(el("div", "menu__divider"));
      continue;
    }
    const item = el("button", `menu__item${entry.danger ? " menu__item--danger" : ""}`, entry.label);
    item.disabled = entry.disabled === true;
    item.addEventListener("click", () => {
      closeContextMenu();
      void entry.run();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  openMenu = menu;

  // Keep the menu inside the panel, which is narrow — flip rather than overflow.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${x + rect.width > window.innerWidth ? Math.max(4, x - rect.width) : x}px`;
  menu.style.top = `${y + rect.height > window.innerHeight ? Math.max(4, y - rect.height) : y}px`;

  const dismiss = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    // event.target is not always a Node — a synthetic dispatch on window isn't one.
    if (event.type === "mousedown" && event.target instanceof Node && menu.contains(event.target)) {
      return;
    }
    closeContextMenu();
  };

  teardown = () => {
    window.removeEventListener("mousedown", dismiss, true);
    window.removeEventListener("keydown", dismiss, true);
    window.removeEventListener("blur", dismiss, true);
  };

  queueMicrotask(() => {
    if (openMenu !== menu) return;
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", dismiss, true);
    window.addEventListener("blur", dismiss, true);
  });
}
