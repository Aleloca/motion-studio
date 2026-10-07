import { useCallback, useEffect, useState } from 'react';

export function useProjectData<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [...deps, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}
