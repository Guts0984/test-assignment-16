// Domain vocabulary shared by api, worker and web.
import { z } from 'zod';

export const ORDER_STATUSES = [
  'received',
  'awaiting_stock',
  'reserved',
  'in_wave',
  'picking',
  'picked',
  'packed',
  'shipped',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const DELIVERY_METHODS = ['standard', 'express'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];
export const deliveryMethodSchema = z.enum(DELIVERY_METHODS);

export const STAFF_ROLES = ['admin', 'shift_lead', 'storekeeper', 'picker', 'packer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const staffRoleSchema = z.enum(STAFF_ROLES);

/** Who performed an action, as seen by the status transition table. */
export const ACTORS = ['shop', 'system', 'admin', 'shift_lead', 'storekeeper', 'picker', 'packer'] as const;
export type Actor = (typeof ACTORS)[number];

export const LOCATION_KINDS = ['storage', 'receiving', 'packing', 'return', 'transit'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const MOVEMENT_KINDS = [
  'receipt',
  'putaway',
  'reserve',
  'unreserve',
  'pick',
  'ship',
  'move',
  'transfer_out',
  'transfer_in',
  'return',
  'adjustment',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const CELL_BLOCK_REASONS = ['count', 'shortage'] as const;
export type CellBlockReason = (typeof CELL_BLOCK_REASONS)[number];

export const COUNT_STATUSES = ['open', 'submitted', 'pending_approval', 'closed'] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const TASK_STATUSES = ['pending', 'assigned', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WEBHOOK_EVENT_TYPES = ['order.status_changed', 'stock.available_changed'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
