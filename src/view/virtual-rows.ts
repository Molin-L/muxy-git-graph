/** A constant vertical gap inserted after a row, for the inline details view. */
export interface Expansion {
  readonly afterIndex: number;
  readonly amount: number;
}

export interface VirtualRowsOptions {
  readonly scroller: HTMLElement;
  readonly container: HTMLElement;
  readonly rowHeight: number;
  readonly overscan: number;
  createRow(): HTMLElement;
  renderRow(element: HTMLElement, index: number): void;
}

/**
 * Recycles row elements as the user scrolls (ADR-0007). Only the rows are
 * virtualised; the graph SVG behind them spans the whole loaded range.
 */
export class VirtualRows {
  private readonly options: VirtualRowsOptions;
  private readonly mounted = new Map<number, HTMLElement>();
  private readonly pool: HTMLElement[] = [];
  private count = 0;
  private expansion: Expansion | null = null;
  private first = -1;
  private last = -1;

  constructor(options: VirtualRowsOptions) {
    this.options = options;
    this.options.scroller.addEventListener("scroll", this.onScroll, { passive: true });
  }

  setCount(count: number, expansion: Expansion | null = null): void {
    this.count = count;
    this.expansion = expansion;
    this.reset();
  }

  setExpansion(expansion: Expansion | null): void {
    this.expansion = expansion;
    this.reset();
  }

  /** Pixel offset of a row's top edge, including any expansion above it. */
  topOf(index: number): number {
    const base = index * this.options.rowHeight;
    const gap = this.expansion !== null && index > this.expansion.afterIndex
      ? this.expansion.amount
      : 0;
    return base + gap;
  }

  get totalHeight(): number {
    return this.count * this.options.rowHeight + (this.expansion?.amount ?? 0);
  }

  get mountedCount(): number {
    return this.mounted.size;
  }

  refresh(): void {
    for (const [index, element] of this.mounted) this.options.renderRow(element, index);
  }

  destroy(): void {
    this.options.scroller.removeEventListener("scroll", this.onScroll);
  }

  private reset(): void {
    this.first = -1;
    this.last = -1;
    for (const [, element] of this.mounted) this.release(element);
    this.mounted.clear();
    this.update();
  }

  private readonly onScroll = (): void => {
    this.update();
  };

  /** Inverse of topOf: the index whose row contains this pixel offset. */
  private indexAt(offset: number): number {
    const { rowHeight } = this.options;
    if (this.expansion !== null) {
      const gapStart = (this.expansion.afterIndex + 1) * rowHeight;
      if (offset >= gapStart) {
        return Math.max(
          this.expansion.afterIndex + 1,
          Math.floor((offset - this.expansion.amount) / rowHeight),
        );
      }
    }
    return Math.floor(offset / rowHeight);
  }

  private update(): void {
    const { scroller, overscan } = this.options;
    if (this.count === 0) {
      for (const [, element] of this.mounted) this.release(element);
      this.mounted.clear();
      return;
    }

    const top = scroller.scrollTop;
    const first = Math.max(0, this.indexAt(top) - overscan);
    const last = Math.min(this.count - 1, this.indexAt(top + scroller.clientHeight) + overscan);
    if (first === this.first && last === this.last) return;

    for (const [index, element] of this.mounted) {
      if (index < first || index > last) {
        this.release(element);
        this.mounted.delete(index);
      }
    }

    for (let index = first; index <= last; index++) {
      if (this.mounted.has(index)) continue;
      const element = this.pool.pop() ?? this.options.createRow();
      element.style.transform = `translateY(${this.topOf(index)}px)`;
      this.options.renderRow(element, index);
      this.options.container.appendChild(element);
      this.mounted.set(index, element);
    }

    this.first = first;
    this.last = last;
  }

  private release(element: HTMLElement): void {
    element.remove();
    this.pool.push(element);
  }
}
