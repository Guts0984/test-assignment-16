// Priority rules for re-reserve and for wave composition (ASSIGNMENT "Re-reserve", "Wave").
import { type DeliveryMethod } from '../domain';

export type WaitingOrder = {
  readonly id: string;
  readonly deliveryMethod: DeliveryMethod;
  readonly receivedAt: Date;
};

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const expressFirst = (a: WaitingOrder, b: WaitingOrder): number =>
  Number(b.deliveryMethod === 'express') - Number(a.deliveryMethod === 'express');

/** Re-reserve order: express first, then by arrival time, then id. */
export const rereserveCompare = (a: WaitingOrder, b: WaitingOrder): number =>
  expressFirst(a, b) || a.receivedAt.getTime() - b.receivedAt.getTime() || byId(a, b);

export const sortForRereserve = <T extends WaitingOrder>(orders: readonly T[]): readonly T[] =>
  orders.slice().sort(rereserveCompare);

export type ReadyOrder = WaitingOrder & { readonly targetCutoffAt: Date };

/** Wave order: nearest cutoff first, then express, then arrival time, then id. */
export const waveCompare = (a: ReadyOrder, b: ReadyOrder): number =>
  a.targetCutoffAt.getTime() - b.targetCutoffAt.getTime() ||
  expressFirst(a, b) ||
  a.receivedAt.getTime() - b.receivedAt.getTime() ||
  byId(a, b);

export const pickWaveOrders = <T extends ReadyOrder>(orders: readonly T[], max: number): readonly T[] =>
  orders.slice().sort(waveCompare).slice(0, Math.max(0, max));
