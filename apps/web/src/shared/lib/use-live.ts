'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { type Socket } from 'socket.io-client';
import { freshAccessToken } from '../api/mutator';
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
    const socket: Socket = connectSocket();
    const refetchAll = () => keys.current.forEach((k) => void qc.invalidateQueries({ queryKey: [...k] }));
    socket.on('ready', () => {
      setState('live');
      if (warehouse !== undefined) socket.emit('subscribe', { warehouseId: warehouse });
      refetchAll();
    });
    socket.on('disconnect', (reason) => {
      setState('offline');
      // The server ends a socket whose token expired or was revoked; socket.io does not retry that
      // by itself. Reconnecting takes a fresh token (and fails cleanly after logout).
      if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1000);
    });
    socket.on('connect_error', () => setState('offline'));
    for (const e of eventKey.split('|').filter((x) => x !== '')) socket.on(e, refetchAll);
    const beat = setInterval(() => {
      void freshAccessToken().then((t) => {
        if (t !== null) socket.emit('presence', { token: t });
      });
    }, 10_000);
    return () => {
      clearInterval(beat);
      socket.close();
    };
  }, [token, eventKey, warehouse, qc]);

  return state;
};
