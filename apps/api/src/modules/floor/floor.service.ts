// Thin adapter: calls the core floor use-cases with this process's dependencies and performs
// their effects (realtime, fast-path job enqueue) only after the transaction committed.
import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@ff/db/client';
import { type Clock } from '@ff/core/clock';
import { flushEffects, newEffects, type Effects } from '@ff/core/effects';
import { type FloorDeps } from '@ff/core/floor/context';
import { type Queues } from '@ff/core/queues';
import { type Emitter } from '@ff/core/realtime';
import { type Result } from '@ff/shared/result';
import { type ApiEnv } from '../../config/env';
import { CLOCK, DB, EMITTER, ENV, QUEUES } from '../../infra/tokens';

@Injectable()
export class FloorService {
  readonly deps: FloorDeps;

  constructor(
    @Inject(DB) readonly db: Db,
    @Inject(CLOCK) readonly clock: Clock,
    @Inject(ENV) readonly env: ApiEnv,
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(EMITTER) private readonly emitter: Emitter,
  ) {
    this.deps = {
      db,
      clock,
      settings: {
        webhookCoalesceMs: env.WEBHOOK_COALESCE_MS,
        partialReserveTtlMin: env.PARTIAL_RESERVE_TTL_MIN,
        waveReadyThreshold: env.WAVE_READY_THRESHOLD,
        waveMaxOrders: env.WAVE_MAX_ORDERS,
        waveIntervalMin: env.WAVE_INTERVAL_MIN,
      },
    };
  }

  /** Runs a use-case and flushes its effects when it succeeded. */
  async run<T>(fn: (d: FloorDeps, fx: Effects) => Promise<Result<T>>): Promise<Result<T>> {
    const fx = newEffects();
    const r = await fn(this.deps, fx);
    if (r.ok)
      await flushEffects({ db: this.db, clock: this.clock, emitter: this.emitter, queues: this.queues }, fx);
    return r;
  }
}
