// BullMQ queues named in the assignment. Jobs only point at a scheduled_actions row.
import { Queue, type ConnectionOptions } from 'bullmq';
import { type ActionKind } from './scheduled-actions';

export const QUEUE_NAMES = ['order-import', 'reservation', 'waves', 'webhooks', 'reserve-expiry', 'nightly'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_OF: Readonly<Record<ActionKind, QueueName>> = {
  import_batch: 'order-import',
  reserve_order: 'reservation',
  rereserve: 'reservation',
  wave_timer: 'waves',
  wave_check: 'waves',
  webhook_stream: 'webhooks',
  partial_reserve_expiry: 'reserve-expiry',
  nightly: 'nightly',
};

export type JobData = { readonly actionId: string };

export type Queues = {
  readonly enqueue: (kind: ActionKind, actionId: string, jobId: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly raw: Readonly<Record<QueueName, Queue<JobData>>>;
};

export const createQueues = (connection: ConnectionOptions, prefix = 'ff'): Queues => {
  const raw = Object.fromEntries(
    QUEUE_NAMES.map((n) => [
      n,
      new Queue<JobData>(n, {
        connection,
        prefix,
        defaultJobOptions: { removeOnComplete: true, removeOnFail: 1000, attempts: 1 },
      }),
    ]),
  ) as Record<QueueName, Queue<JobData>>;
  return {
    raw,
    enqueue: async (kind, actionId, jobId) => {
      await raw[QUEUE_OF[kind]].add(kind, { actionId }, { jobId });
    },
    close: async () => {
      await Promise.all(Object.values(raw).map((q) => q.close()));
    },
  };
};
