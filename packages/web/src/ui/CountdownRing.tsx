import { useEffect, useState } from 'react';
import { useT } from '../i18n.tsx';

export interface CountdownRingProps { createdAt: number; ttlSec: number }

const R = 9;
const C = 2 * Math.PI * R;

const secondsLeft = (createdAt: number, ttlSec: number, now: number) => Math.max(0, ttlSec - (now - createdAt) / 1000);

/** Real-time countdown ring for approvals (T8): the arc empties as the time runs out; ticks stop at zero. */
export function CountdownRing({ createdAt, ttlSec }: CountdownRingProps) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const left = secondsLeft(createdAt, ttlSec, now);

  useEffect(() => {
    if (secondsLeft(createdAt, ttlSec, Date.now()) <= 0) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (secondsLeft(createdAt, ttlSec, at) <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [createdAt, ttlSec]);

  const frac = ttlSec > 0 ? left / ttlSec : 0;
  const whole = Math.ceil(left - 1e-6);
  const time = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  return (
    <span className="ms-ring" role="timer" aria-label={t.web.ui.timeLeft({ time })}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r={R} className="ms-ring-track" />
        <circle cx="12" cy="12" r={R} className="ms-ring-prog" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 12 12)" />
      </svg>
      <span aria-hidden="true">{time}</span>
    </span>
  );
}
