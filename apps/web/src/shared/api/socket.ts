// One authenticated Socket.IO connection (websocket transport, so no sticky sessions are needed
// behind nginx). Rooms are joined by the server from the token; the client never asks for access.
// The token is read on every (re)connect, so a connection that outlives one access token still works.
import { io, type Socket } from 'socket.io-client';
import { publicEnv } from '../config/env';
import { freshAccessToken } from './mutator';

export const connectSocket = (): Socket =>
  io({
    path: publicEnv.NEXT_PUBLIC_SOCKET_PATH,
    transports: ['websocket'],
    auth: (cb) => {
      void freshAccessToken().then((token) => cb({ token: token ?? '' }));
    },
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
