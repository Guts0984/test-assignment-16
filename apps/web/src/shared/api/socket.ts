// One authenticated Socket.IO connection (websocket transport, so no sticky sessions are needed
// behind nginx). Rooms are joined by the server from the token; the client never asks for access.
import { io, type Socket } from 'socket.io-client';
import { publicEnv } from '../config/env';

export const connectSocket = (token: string): Socket =>
  io({
    path: publicEnv.NEXT_PUBLIC_SOCKET_PATH,
    transports: ['websocket'],
    auth: { token },
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
