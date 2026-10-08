/**
 * Roving focus for radio groups and tab lists: the index the key moves to (wrapping), or null when the key is not a
 * navigation key. Left/Up go back, Right/Down go forward, Home/End jump to the ends.
 */
export function rovingIndex(key: string, index: number, length: number): number | null {
  if (length <= 0) return null;
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (index + 1) % length;
    case 'ArrowLeft': case 'ArrowUp': return (index - 1 + length) % length;
    case 'Home': return 0;
    case 'End': return length - 1;
    default: return null;
  }
}
