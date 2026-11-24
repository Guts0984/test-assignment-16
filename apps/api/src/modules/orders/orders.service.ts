import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@ff/db/client';
import { type Clock } from '@ff/core/clock';
import { flushEffects, newEffects } from '@ff/core/effects';
import { createImportBatch } from '@ff/core/orders/import-batch';
import { importOrder } from '@ff/core/orders/import';
import { orderDetail, type OrderScope } from '@ff/core/orders/detail';
import { searchOrders, type OrderListItem, type OrderSearchQuery } from '@ff/core/orders/search';
import { type Queues } from '@ff/core/queues';
import { type Emitter } from '@ff/core/realtime';
import { fail, map, ok, type Result } from '@ff/shared/result';
import { type BatchImportInput, type CreateOrderInput } from '@ff/shared/schemas/orders';
import { CLOCK, DB, EMITTER, QUEUES } from '../../infra/tokens';

const toListItem = (o: OrderListItem) => ({
  ...o,
  receivedAt: o.receivedAt.toISOString(),
  targetCutoffAt: o.targetCutoffAt?.toISOString() ?? null,
  shipDay: o.shipDay?.toISOString().slice(0, 10) ?? null,
});

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QUEUES) private readonly queues: Queues,
    @Inject(EMITTER) private readonly emitter: Emitter,
  ) {}

  private get deps() {
    return { db: this.db, clock: this.clock, queues: this.queues, emitter: this.emitter };
  }

  async import(shopId: string, input: CreateOrderInput) {
    const fx = newEffects();
    const r = await importOrder(this.deps, fx, shopId, input);
    await flushEffects(this.deps, fx);
    return r;
  }

  async importBatch(shopId: string, input: BatchImportInput) {
    const fx = newEffects();
    const r = await createImportBatch(this.deps, fx, shopId, input);
    await flushEffects(this.deps, fx);
    return r;
  }

  async batch(shopId: string, id: string) {
    const b = await this.db.importBatch.findFirst({ where: { id, shopId } });
    if (b === null) return fail('NOT_FOUND', 'import batch not found');
    return ok({
      id: b.id,
      status: b.status as 'pending' | 'done' | 'failed',
      results: (b.results ?? null) as never,
    });
  }

  async search(q: OrderSearchQuery) {
    return map(await searchOrders(this.db, q), (p) => ({
      items: p.items.map(toListItem),
      nextCursor: p.nextCursor,
    }));
  }

  detail(id: string, scope: OrderScope): Promise<Result<unknown>> {
    return orderDetail(this.db, id, scope);
  }
}
