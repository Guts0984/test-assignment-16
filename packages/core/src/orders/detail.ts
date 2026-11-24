// One order with lines and status history, scoped by the caller (shop or staff warehouses).
import { type Db } from '@ff/db/client';
import { type OrderStatus } from '@ff/shared/domain';
import { fail, ok, type Result } from '@ff/shared/result';

export type OrderScope = { readonly shopId?: string; readonly warehouseIds: readonly string[] | null };

export const orderDetail = async (db: Db, id: string, scope: OrderScope) => {
  const o = await db.order.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  const visible =
    o !== null &&
    (scope.shopId === undefined || o.shopId === scope.shopId) &&
    (scope.warehouseIds === null || (o.warehouseId !== null && scope.warehouseIds.includes(o.warehouseId)));
  if (o === null || !visible) return fail('NOT_FOUND', 'order not found') as Result<never>;
  const [skus, history, warehouse] = await Promise.all([
    db.sku.findMany({ where: { id: { in: o.lines.map((l) => l.skuId) } } }),
    db.orderStatusHistory.findMany({ where: { orderId: id }, orderBy: { version: 'asc' } }),
    o.warehouseId === null ? null : db.warehouse.findUnique({ where: { id: o.warehouseId } }),
  ]);
  const sku = new Map(skus.map((s) => [s.id, s]));
  return ok({
    id: o.id,
    shopId: o.shopId,
    externalNumber: o.externalNumber,
    status: o.status as OrderStatus,
    statusVersion: o.statusVersion,
    deliveryMethod: o.deliveryMethod,
    address: o.address as Record<string, unknown>,
    customerName: o.customerName,
    warehouseId: o.warehouseId,
    warehouseCode: warehouse?.code ?? null,
    receivedAt: o.receivedAt.toISOString(),
    targetCutoffAt: o.targetCutoffAt?.toISOString() ?? null,
    shipDay: o.shipDay?.toISOString().slice(0, 10) ?? null,
    packedAt: o.packedAt?.toISOString() ?? null,
    shippedAt: o.shippedAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    lines: o.lines.map((l) => ({
      id: l.id,
      skuId: l.skuId,
      skuCode: sku.get(l.skuId)?.code ?? '',
      skuName: sku.get(l.skuId)?.name ?? '',
      qty: l.qty,
      reservedQty: l.reservedQty,
      pickedQty: l.pickedQty,
    })),
    history: history.map((h) => ({
      version: h.version,
      from: (h.fromStatus as OrderStatus | null) ?? null,
      to: h.toStatus as OrderStatus,
      actorType: h.actorType,
      reason: h.reason,
      at: h.createdAt.toISOString(),
    })),
  });
};
