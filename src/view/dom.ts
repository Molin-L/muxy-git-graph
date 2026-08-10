export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/* Date and clock are formatted separately and joined by hand. A single
   toLocaleString over the same fields glues them with a connector — "Aug 9,
   2026 at 14:23" in current ICU — which is words, not information, in a column
   this narrow. Both halves stay locale-aware; only the join is ours. */
const DAY = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function format(date: Date): string {
  return `${DAY.format(date)} ${CLOCK.format(date)}`;
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return format(date);
}

/**
 * Every width `absoluteTime` can produce in the given years: twelve month
 * names, both two-digit day shapes, and a two-digit hour. Sizing a column off
 * these is exact and costs a few dozen formats, where formatting each of
 * thousands of commits would cost thousands for the same answer.
 */
export function absoluteTimeWidths(years: Iterable<number>): string[] {
  const samples: string[] = [];
  for (const year of years) {
    for (let month = 0; month < 12; month++) {
      for (const day of [28, 30]) {
        samples.push(format(new Date(year, month, day, 22, 38)));
      }
    }
  }
  return samples;
}

export async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = el("textarea");
    area.value = value;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * Opens a URL for the user. `muxy.browser.open` shows it in one of Muxy's own
 * browser tabs and always runs in the app — unlike `muxy.exec(["open", …])`,
 * which on a remote workspace would run `open` on the remote host.
 */
export function openExternal(url: string): void {
  const muxy = globalThis.muxy;
  if (muxy?.browser?.open) {
    // Positional string, not an options object — the bridge does String(url),
    // so an object arrives as "[object Object]" and gets googled.
    void Promise.resolve(muxy.browser.open(url)).catch(() => {
      void muxy.exec(["open", url]).catch(() => undefined);
    });
    return;
  }
  if (muxy) {
    void muxy.exec(["open", url]).catch(() => undefined);
    return;
  }
  window.open(url, "_blank");
}
