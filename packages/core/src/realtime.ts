// Realtime contract: rooms and events. Rooms are joined only on the server (plan.md A-32).
export const rooms = {
  shop: (shopId: string) => `shop:${shopId}`,
  lead: (warehouseId: string) => `wh:${warehouseId}:lead`,
  floor: (warehouseId: string) => `wh:${warehouseId}:floor`,
  picker: (staffId: string) => `picker:${staffId}`,
} as const;

export const EVENTS = {
  orderStatus: 'order.status',
  stockChanged: 'stock.changed',
  waveFormed: 'wave.formed',
  taskChanged: 'task.changed',
  scan: 'pick.scan',
  shortage: 'pick.shortage',
  countChanged: 'count.changed',
  presence: 'presence',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export type RealtimeMessage = {
  readonly room: string;
  readonly event: EventName;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** Anything that can push messages to Socket.IO rooms (the api server, or the worker's redis emitter). */
export type Emitter = { readonly emit: (messages: readonly RealtimeMessage[]) => void };

export const nullEmitter: Emitter = { emit: () => undefined };
