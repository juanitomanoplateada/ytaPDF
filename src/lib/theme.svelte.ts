/**
 * Light or dark interface. "system" follows the operating system. The
 * choice is applied as `data-theme` on <html>; an inline script in
 * index.html applies it before the first paint so there is no flash.
 */
export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "ytapdf.theme";

function saved(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

class Theme {
  choice = $state<ThemeChoice>(globalThis.window === undefined ? "system" : saved());

  set(choice: ThemeChoice): void {
    this.choice = choice;
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // The choice simply does not persist.
    }
    apply(choice);
  }
}

function apply(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export const theme = new Theme();
