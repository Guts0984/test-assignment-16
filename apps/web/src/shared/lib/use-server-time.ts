'use client';

import { useEffect, useState } from 'react';
import { systemControllerTime } from '../api/generated/system/system';
import { clockOffset, serverNow } from './server-time';

/** Server clock as a ticking value; re-synced every minute. Never the browser clock alone. */
export const useServerNow = (tickMs = 1000): number => {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const sent = Date.now();
      const r = await systemControllerTime().catch(() => null);
      if (alive && r !== null)
        setOffset(clockOffset({ serverNowMs: Date.parse(r.now), sentAtMs: sent, receivedAtMs: Date.now() }));
    };
    void sync();
    const resync = setInterval(() => void sync(), 60_000);
    const tick = setInterval(() => setNow(Date.now()), tickMs);
    return () => {
      alive = false;
      clearInterval(resync);
      clearInterval(tick);
    };
  }, [tickMs]);
  return serverNow(now, offset);
};
