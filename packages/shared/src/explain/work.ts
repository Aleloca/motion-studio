// A deterministic work counter: the explain code adds the characters it visits and the strings it builds, so tests can
// assert linear time (work ≤ k·n) without wall-clock timing.
let units = 0;

export const explainWork = {
  add(n: number): void { units += n; },
  reset(): void { units = 0; },
  get(): number { return units; },
};
