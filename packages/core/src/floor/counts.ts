// Stock counts (ASSIGNMENT "Stock count"; invariant 7): the cell is blocked until the count closes;
// a discrepancy over 5 units or 10% waits for the shift lead; every adjustment has reason and author.
import { fail, ok, type Result } from '@ff/shared/result';
import { evaluateCountLine } from '@ff/shared/rules/count';
import { type SubmitCountInput } from '@ff/shared/schemas/floor';
import { type Tx } from '@ff/db/client';
import { type Effects } from '../effects';
import { EVENTS, rooms } from '../realtime';
import { runTx } from '../tx-result';
import { ctxOf, type FloorDeps } from './context';
import { idempotent } from './idempotency';
import { scheduleRereserve, stockChanged, writeMovements, type Ctx } from './ledger-ops';
import { blockCell, relocateCellReservations } from './relocate';

export type CountView = {
  readonly id: string;
  readonly warehouseId: string;
  readonly locationId: string;
  readonly cellCode: string;
  readonly status: string;
  readonly origin: string;
  readonly assigneeId: string | null;
  readonly needsApproval: boolean;
  readonly approvedBy: string | null;
  readonly lines: readonly {
    skuId: string;
    batchId: string;
    systemQty: number;
    countedQty: number;
    delta: number;
    requiresApproval: boolean;
    reason: string | null;
  }[];
};

export const countView = async (tx: Tx | FloorDeps['db'], id: string): Promise<CountView | null> => {
  const [c] = await tx.$queryRaw<
    {
      id: string;
      warehouse_id: string;
      location_id: string;
      code: string;
      status: string;
      origin: string;
      assignee_id: string | null;
      needs_approval: boolean;
      approved_by: string | null;
    }[]
  >`
    SELECT c.id, c.warehouse_id, c.location_id, l.code, c.status, c.origin, c.assignee_id, c.needs_approval, c.approved_by
    FROM stock_counts c JOIN locations l ON l.id = c.location_id WHERE c.id = ${id}::uuid`;
  if (c === undefined) return null;
  const lines = await tx.$queryRaw<
    {
      sku_id: string;
      batch_id: string;
      system_qty: number;
      counted_qty: number;
      delta: number;
      requires_approval: boolean;
      reason: string | null;
    }[]
  >`
    SELECT sku_id, batch_id, system_qty, counted_qty, delta, requires_approval, reason FROM stock_count_lines WHERE count_id = ${id}::uuid ORDER BY sku_id, batch_id`;
  return {
    id: c.id,
    warehouseId: c.warehouse_id,
    locationId: c.location_id,
    cellCode: c.code,
    status: c.status,
    origin: c.origin,
    assigneeId: c.assignee_id,
    needsApproval: c.needs_approval,
    approvedBy: c.approved_by,
    lines: lines.map((l) => ({
      skuId: l.sku_id,
      batchId: l.batch_id,
      systemQty: l.system_qty,
      countedQty: l.counted_qty,
      delta: l.delta,
      requiresApproval: l.requires_approval,
      reason: l.reason,
    })),
  };
};

/** Opens a count per cell: blocks the cell and moves its reservations away, per cell transaction. */
export const createCounts = async (
  d: FloorDeps,
  outer: Effects,
  warehouseId: string,
  leadId: string,
  input: { readonly cellIds: readonly string[]; readonly assigneeId?: string },
): Promise<Result<readonly string[]>> => {
  const ids: string[] = [];
  for (const cellId of input.cellIds) {
    const r = await runTx<string>(d.db, outer, async (tx, fx) => {
      const now = d.clock.now();
      const [cell] = await tx.$queryRaw<{ id: string; kind: string }[]>`
        SELECT id, kind FROM locations WHERE id = ${cellId}::uuid AND warehouse_id = ${warehouseId}::uuid FOR UPDATE`;
      if (cell === undefined || cell.kind !== 'storage')
        return fail('NOT_FOUND', 'storage cell not found in this warehouse');
      const [open] = await tx.$queryRaw<{ id: string; assignee_id: string | null }[]>`
        SELECT id, assignee_id FROM stock_counts WHERE location_id = ${cellId}::uuid AND status <> 'closed'`;
      if (open !== undefined) {
        // A shortage already opened a count here: the lead assigns it instead of creating another.
        if (open.assignee_id === null && input.assigneeId !== undefined) {
          await tx.$executeRaw`UPDATE stock_counts SET assignee_id = ${input.assigneeId}::uuid, created_by = ${leadId}::uuid WHERE id = ${open.id}::uuid`;
          return ok(open.id);
        }
        return fail('COUNT_ALREADY_OPEN', 'this cell already has an open count');
      }
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: leadId }, 'stock_count', cellId, now);
      await blockCell(ctx, cellId, 'count');
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO stock_counts (warehouse_id, location_id, status, origin, assignee_id, created_by, created_at)
        VALUES (${warehouseId}::uuid, ${cellId}::uuid, 'open', 'manual', ${input.assigneeId ?? null}::uuid, ${leadId}::uuid, ${now}) RETURNING id`;
      if (row === undefined) throw new Error('count insert returned nothing');
      const rel = await relocateCellReservations(ctx, d, warehouseId, cellId);
      if (!rel.ok) return rel;
      fx.realtime.push({
        room: rooms.lead(warehouseId),
        event: EVENTS.countChanged,
        payload: { countId: row.id, status: 'open' },
      });
      return ok(row.id);
    });
    if (!r.ok) return r;
    ids.push(r.value);
  }
  return ok(ids);
};

const applyAndClose = async (
  ctx: Ctx,
  countId: string,
  warehouseId: string,
  locationId: string,
  approvedBy: string | null,
): Promise<void> => {
  const lines = await ctx.tx.$queryRaw<
    { sku_id: string; batch_id: string; delta: number; reason: string | null; counted_by: string }[]
  >`
    SELECT sku_id, batch_id, delta, reason, counted_by FROM stock_count_lines WHERE count_id = ${countId}::uuid AND delta <> 0`;
  for (const l of lines) {
    await ctx.tx.$executeRaw`
      INSERT INTO adjustments (warehouse_id, count_id, location_id, sku_id, batch_id, delta, reason, author_id, approved_by, created_at)
      VALUES (${warehouseId}::uuid, ${countId}::uuid, ${locationId}::uuid, ${l.sku_id}::uuid, ${l.batch_id}::uuid, ${l.delta},
              ${l.reason ?? ''}, ${l.counted_by}::uuid, ${approvedBy}::uuid, ${ctx.now})`;
    await writeMovements(ctx, [
      {
        kind: 'adjustment',
        warehouseId,
        locationId,
        skuId: l.sku_id,
        batchId: l.batch_id,
        onHandDelta: l.delta,
        reservedDelta: 0,
        qty: Math.abs(l.delta),
        from: l.delta < 0 ? locationId : null,
        to: l.delta > 0 ? locationId : null,
        reason: l.reason ?? '',
      },
    ]);
  }
  await ctx.tx
    .$executeRaw`UPDATE stock_counts SET status = 'closed', closed_at = ${ctx.now}, approved_by = ${approvedBy}::uuid WHERE id = ${countId}::uuid`;
  await ctx.tx.$executeRaw`UPDATE locations SET blocked_reason = NULL WHERE id = ${locationId}::uuid`;
  const skus = (
    await ctx.tx.$queryRaw<
      { sku_id: string }[]
    >`SELECT DISTINCT sku_id FROM stock_balances WHERE location_id = ${locationId}::uuid`
  ).map((r) => r.sku_id);
  await scheduleRereserve(ctx, warehouseId, skus);
  await stockChanged(ctx, skus);
};

/**
 * Submits counted quantities. The system quantity is read under the cell lock, so any scan that
 * landed before the block is already in it, and none can land after. Uncounted items count as 0.
 */
export const submitCount = (
  d: FloorDeps,
  outer: Effects,
  countId: string,
  counterId: string,
  input: SubmitCountInput,
): Promise<Result<CountView>> =>
  runTx<CountView>(d.db, outer, (tx, fx) =>
    idempotent(tx, `count:${counterId}`, input.idempotencyKey, { countId, ...input }, async () => {
      const now = d.clock.now();
      const [c] = await tx.$queryRaw<
        { id: string; warehouse_id: string; location_id: string; status: string }[]
      >`
        SELECT id, warehouse_id, location_id, status FROM stock_counts WHERE id = ${countId}::uuid FOR UPDATE`;
      if (c === undefined) return fail('NOT_FOUND', 'count not found');
      if (c.status !== 'open') return fail('COUNT_NOT_OPEN', 'this count is not open');
      await tx.$executeRaw`SELECT id FROM locations WHERE id = ${c.location_id}::uuid FOR UPDATE`;
      const system = await tx.$queryRaw<{ sku_id: string; batch_id: string; on_hand: number }[]>`
        SELECT sku_id, batch_id, on_hand FROM stock_balances WHERE location_id = ${c.location_id}::uuid AND on_hand > 0 FOR UPDATE`;
      const counted = new Map(input.lines.map((l) => [`${l.skuId}/${l.batchId}`, l]));
      const keys = [...new Set([...system.map((s) => `${s.sku_id}/${s.batch_id}`), ...counted.keys()])];
      for (const k of keys) {
        const [skuId = '', batchId = ''] = k.split('/');
        const [valid] = await tx.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM batches WHERE id = ${batchId}::uuid AND sku_id = ${skuId}::uuid`;
        if ((valid?.n ?? 0) === 0)
          return fail('VALIDATION_FAILED', 'unknown SKU / batch in count', { line: k });
        const sys = system.find((s) => `${s.sku_id}/${s.batch_id}` === k)?.on_hand ?? 0;
        const line = counted.get(k);
        const outcome = evaluateCountLine(sys, line?.countedQty ?? 0);
        if (outcome.delta !== 0 && (line?.reason === undefined || line.reason.trim() === '')) {
          return fail('VALIDATION_FAILED', 'a reason is required for every discrepancy', { line: k });
        }
        await tx.$executeRaw`
          INSERT INTO stock_count_lines (count_id, sku_id, batch_id, system_qty, counted_qty, delta, requires_approval, reason, counted_by)
          VALUES (${countId}::uuid, ${skuId}::uuid, ${batchId}::uuid, ${sys}, ${outcome.countedQty}, ${outcome.delta}, ${outcome.requiresApproval},
                  ${line?.reason ?? null}, ${counterId}::uuid)`;
      }
      const [needs] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM stock_count_lines WHERE count_id = ${countId}::uuid AND requires_approval`;
      const ctx = ctxOf(tx, fx, d, { type: 'staff', id: counterId }, 'stock_count', countId, now);
      if ((needs?.n ?? 0) > 0) {
        await tx.$executeRaw`UPDATE stock_counts SET status = 'pending_approval', needs_approval = true, submitted_at = ${now} WHERE id = ${countId}::uuid`;
      } else {
        await tx.$executeRaw`UPDATE stock_counts SET submitted_at = ${now} WHERE id = ${countId}::uuid`;
        await applyAndClose(ctx, countId, c.warehouse_id, c.location_id, null);
      }
      fx.realtime.push({
        room: rooms.lead(c.warehouse_id),
        event: EVENTS.countChanged,
        payload: { countId, status: (needs?.n ?? 0) > 0 ? 'pending_approval' : 'closed' },
      });
      const v = await countView(tx, countId);
      return v === null ? fail('NOT_FOUND', 'count vanished') : ok(v);
    }),
  );

/** The shift lead approves (adjustments applied, cell unblocked) or sends the count back for a recount. */
export const approveCount = (
  d: FloorDeps,
  outer: Effects,
  countId: string,
  leadId: string,
  approve: boolean,
): Promise<Result<CountView>> =>
  runTx<CountView>(d.db, outer, async (tx, fx) => {
    const now = d.clock.now();
    const [c] = await tx.$queryRaw<{ warehouse_id: string; location_id: string; status: string }[]>`
      SELECT warehouse_id, location_id, status FROM stock_counts WHERE id = ${countId}::uuid FOR UPDATE`;
    if (c === undefined) return fail('NOT_FOUND', 'count not found');
    if (c.status !== 'pending_approval')
      return fail('APPROVAL_REQUIRED', 'this count is not waiting for approval');
    await tx.$executeRaw`SELECT id FROM locations WHERE id = ${c.location_id}::uuid FOR UPDATE`;
    const ctx = ctxOf(tx, fx, d, { type: 'staff', id: leadId }, 'stock_count', countId, now);
    if (approve) {
      await applyAndClose(ctx, countId, c.warehouse_id, c.location_id, leadId);
    } else {
      await tx.$executeRaw`DELETE FROM stock_count_lines WHERE count_id = ${countId}::uuid`;
      await tx.$executeRaw`UPDATE stock_counts SET status = 'open', needs_approval = false, submitted_at = NULL WHERE id = ${countId}::uuid`;
    }
    fx.realtime.push({
      room: rooms.lead(c.warehouse_id),
      event: EVENTS.countChanged,
      payload: { countId, status: approve ? 'closed' : 'open' },
    });
    const v = await countView(tx, countId);
    return v === null ? fail('NOT_FOUND', 'count vanished') : ok(v);
  });
