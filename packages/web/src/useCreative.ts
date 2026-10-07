import type { ConversationEntry, CreativeDetail } from '@motion-studio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';

export function useCreative(slug: string, creative: string, tick: number) {
  const [detail, setDetail] = useState<CreativeDetail | null>(null);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([api.getCreative(slug, creative), api.getConversation(slug, creative)])
      .then(([d, conv]) => { if (alive) { setDetail(d); setConversation(conv); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [slug, creative, tick, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { detail, conversation, error, reload };
}
