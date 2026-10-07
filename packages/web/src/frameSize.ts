export function fitFrame(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  const s = Math.min(maxW / width, maxH / height);
  return { width: Math.max(8, Math.round(width * s)), height: Math.max(8, Math.round(height * s)) };
}
