'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { type Socket } from 'socket.io-client';
import { connectSocket } from '../api/socket';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Keeps the page fresh: on any of `events` the given query keys are invalidated, and after a
 * reconnect (e.g. Redis was lost) everything is refetched from REST, so nothing stale survives.
 */
export const useLive = (
  token: string | null,
  events: readonly string[],
  invalidate: readonly (readonly unknown[])[],
  join?: { warehouseId: string },
): LiveState => {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const keys = useRef(invalidate);
  keys.current = invalidate;
  const eventKey = events.join('|');
  const warehouse = join?.warehouseId;

  useEffect(() => {
    if (token === null) return;
    const socket: Socket = connectSocket(token);
    const refetchAll = () => keys.current.forEach((k) => void qc.invalidateQueries({ queryKey: [...k] }));
    socket.on('ready', () => {
      setState('live');
      if (warehouse !== undefined) socket.emit('subscribe', { warehouseId: warehouse });
      refetchAll();
    });
    socket.on('disconnect', () => setState('offline'));
    socket.on('connect_error', () => setState('offline'));
    for (const e of eventKey.split('|').filter((x) => x !== '')) socket.on(e, refetchAll);
    const beat = setInterval(() => socket.emit('presence', { token }), 10_000);
    return () => {
      clearInterval(beat);
      socket.close();
    };
  }, [token, eventKey, warehouse, qc]);

  return state;
};
