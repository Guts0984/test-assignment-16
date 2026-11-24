import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ORDER_STATUSES } from '@ff/shared/domain';
import {
  approveCountSchema,
  createCountSchema,
  createReceiptSchema,
  createTransferSchema,
  moveSchema,
  packSchema,
  putawayConfirmSchema,
  putawaySuggestSchema,
  reassignSchema,
  receiptLineSchema,
  receiveTransferSchema,
  reportQuerySchema,
  scanCellSchema,
  scanItemSchema,
  shipSchema,
  shortageSchema,
  submitCountSchema,
} from '@ff/shared/schemas/floor';
import { idempotencyKeySchema } from '@ff/shared/schemas/common';

export class CreateReceiptDto extends createZodDto(createReceiptSchema) {}
export class ReceiptLineDto extends createZodDto(receiptLineSchema) {}
export class PutawaySuggestDto extends createZodDto(putawaySuggestSchema) {}
export class PutawayConfirmDto extends createZodDto(putawayConfirmSchema) {}
export class MoveDto extends createZodDto(moveSchema) {}
export class CreateTransferDto extends createZodDto(createTransferSchema) {}
export class ReceiveTransferDto extends createZodDto(receiveTransferSchema) {}
export class ScanCellDto extends createZodDto(scanCellSchema) {}
export class ScanItemDto extends createZodDto(scanItemSchema) {}
export class ShortageDto extends createZodDto(shortageSchema) {}
export class ReassignDto extends createZodDto(reassignSchema) {}
export class PackDto extends createZodDto(packSchema) {}
export class ShipDto extends createZodDto(shipSchema) {}
export class CreateCountDto extends createZodDto(createCountSchema) {}
export class SubmitCountDto extends createZodDto(submitCountSchema) {}
export class ApproveCountDto extends createZodDto(approveCountSchema) {}
export class ReportQueryDto extends createZodDto(reportQuerySchema) {}
export class CancelDto extends createZodDto(z.object({ reason: z.string().max(200).optional() }).strict()) {}
export class KeyOnlyDto extends createZodDto(z.object({ idempotencyKey: idempotencyKeySchema }).strict()) {}

export class IdDto extends createZodDto(z.object({ id: z.string().uuid(), status: z.string() })) {}

const taskLine = z.object({
  lineId: z.string().uuid(),
  cellCode: z.string(),
  walkOrder: z.number().int(),
  skuId: z.string().uuid(),
  skuCode: z.string(),
  skuName: z.string(),
  barcode: z.string(),
  batchCode: z.string(),
  tracksExpiry: z.boolean(),
  qty: z.number().int(),
  pickedQty: z.number().int(),
  status: z.string(),
});
export const taskSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  orderNumber: z.string(),
  warehouseId: z.string().uuid(),
  status: z.string(),
  assigneeId: z.string().uuid().nullable(),
  lines: z.array(taskLine),
});
export class TaskDto extends createZodDto(taskSchema) {}
export class TaskListDto extends createZodDto(
  z.object({
    items: z.array(
      taskSchema.omit({ lines: true }).extend({ lines: z.number().int(), linesDone: z.number().int() }),
    ),
  }),
) {}
export class CellLinesDto extends createZodDto(z.object({ lines: z.array(taskLine) })) {}
export class ScanResultDto extends createZodDto(
  z.object({
    lineId: z.string().uuid(),
    pickedQty: z.number().int(),
    lineDone: z.boolean(),
    taskDone: z.boolean(),
    orderStatus: z.enum(ORDER_STATUSES),
  }),
) {}
export class WaveDto extends createZodDto(
  z.object({ waveId: z.string().uuid().nullable(), orderCount: z.number().int() }),
) {}
export class WaveListDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        id: z.string().uuid(),
        trigger: z.string(),
        createdAt: z.string(),
        orderCount: z.number().int(),
      }),
    ),
  }),
) {}
export class PackResultDto extends createZodDto(
  z.object({
    orderId: z.string().uuid(),
    orderNumber: z.string(),
    shipDay: z.string(),
    packedAt: z.string(),
    labelUrl: z.string(),
  }),
) {}
export class ShipResultDto extends createZodDto(
  z.object({ shipped: z.array(z.string().uuid()), skipped: z.array(z.string().uuid()) }),
) {}
export class CancelResultDto extends createZodDto(
  z.object({
    orderId: z.string().uuid(),
    status: z.literal('cancelled'),
    returnedUnits: z.number().int(),
    alreadyCancelled: z.boolean(),
  }),
) {}
export class ReceiptLineResultDto extends createZodDto(
  z.object({
    lineId: z.string().uuid(),
    skuId: z.string().uuid(),
    batchId: z.string().uuid(),
    qty: z.number().int(),
  }),
) {}
export class ReceiptSummaryDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
    status: z.string(),
    discrepancies: z.array(
      z.object({ skuId: z.string().uuid(), expectedQty: z.number().int(), receivedQty: z.number().int() }),
    ),
  }),
) {}
export class ReceiptListDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        id: z.string().uuid(),
        shopId: z.string().uuid(),
        inboundId: z.string().uuid().nullable(),
        status: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
) {}
export class PendingPutawayDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        sourceLocationId: z.string().uuid(),
        kind: z.string(),
        skuId: z.string().uuid(),
        skuCode: z.string(),
        barcode: z.string(),
        batchId: z.string().uuid(),
        batchCode: z.string(),
        qty: z.number().int(),
      }),
    ),
  }),
) {}
export class SuggestionsDto extends createZodDto(
  z.object({ items: z.array(z.object({ cellId: z.string().uuid(), code: z.string(), reason: z.string() })) }),
) {}
export class QtyDto extends createZodDto(z.object({ qty: z.number().int() })) {}
export class PutawayResultDto extends createZodDto(
  z.object({ cellId: z.string().uuid(), qty: z.number().int() }),
) {}
export class TransferCreatedDto extends createZodDto(z.object({ transferId: z.string().uuid() })) {}
export class TransferReceivedDto extends createZodDto(
  z.object({ received: z.number().int(), missing: z.number().int() }),
) {}
export class TransferListDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        id: z.string().uuid(),
        fromWarehouseId: z.string().uuid(),
        toWarehouseId: z.string().uuid(),
        status: z.string(),
        createdAt: z.string(),
        lines: z.array(
          z.object({
            skuId: z.string().uuid(),
            batchId: z.string().uuid(),
            qty: z.number().int(),
            receivedQty: z.number().int().nullable(),
          }),
        ),
      }),
    ),
  }),
) {}
const countLine = z.object({
  skuId: z.string().uuid(),
  batchId: z.string().uuid(),
  systemQty: z.number().int(),
  countedQty: z.number().int(),
  delta: z.number().int(),
  requiresApproval: z.boolean(),
  reason: z.string().nullable(),
});
export const countSchema = z.object({
  id: z.string().uuid(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid(),
  cellCode: z.string(),
  status: z.string(),
  origin: z.string(),
  assigneeId: z.string().uuid().nullable(),
  needsApproval: z.boolean(),
  approvedBy: z.string().uuid().nullable(),
  lines: z.array(countLine),
});
export class CountDto extends createZodDto(countSchema) {}
export class CountListDto extends createZodDto(
  z.object({ items: z.array(countSchema.omit({ lines: true })) }),
) {}
export class CountsCreatedDto extends createZodDto(z.object({ ids: z.array(z.string().uuid()) })) {}
export class CountQueryDto extends createZodDto(
  z.object({ status: z.enum(['open', 'pending_approval', 'closed']).optional() }).strict(),
) {}

export class DashboardDto extends createZodDto(
  z.object({
    serverTime: z.string(),
    warehouse: z.object({ id: z.string().uuid(), code: z.string(), timeZone: z.string() }),
    nextCutoff: z.object({ shipDay: z.string(), at: z.string(), msLeft: z.number() }),
    ordersByStatus: z.record(z.number().int()),
    waves: z.array(
      z.object({
        id: z.string().uuid(),
        trigger: z.string(),
        createdAt: z.string(),
        orderCount: z.number().int(),
        tasks: z.number().int(),
        tasksDone: z.number().int(),
      }),
    ),
    pickers: z.array(
      z.object({
        staffId: z.string().uuid(),
        name: z.string(),
        online: z.boolean(),
        taskId: z.string().uuid().nullable(),
        orderNumber: z.string().nullable(),
        lines: z.number().int(),
        linesDone: z.number().int(),
      }),
    ),
    atRisk: z.array(
      z.object({
        orderId: z.string().uuid(),
        orderNumber: z.string(),
        status: z.enum(ORDER_STATUSES),
        express: z.boolean(),
        targetCutoffAt: z.string().nullable(),
        late: z.boolean(),
      }),
    ),
    countsAwaitingApproval: z.number().int(),
  }),
) {}

const person = z.object({
  warehouseId: z.string().uuid(),
  warehouseCode: z.string(),
  staffId: z.string().uuid(),
  staffName: z.string(),
  events: z.number().int(),
  units: z.number().int(),
});
export class ReportDto extends createZodDto(
  z.object({
    period: z.object({ from: z.string(), to: z.string() }),
    orders: z.object({
      shipped: z.number().int(),
      onTime: z.number().int(),
      onTimeRate: z.number().nullable(),
      medianMinutes: z.number().nullable(),
      p90Minutes: z.number().nullable(),
    }),
    byWarehouse: z.array(
      z.object({
        warehouseId: z.string().uuid(),
        warehouseCode: z.string(),
        shipped: z.number().int(),
        onTime: z.number().int(),
        medianMinutes: z.number().nullable(),
        p90Minutes: z.number().nullable(),
      }),
    ),
    shortages: z.array(person),
    adjustments: z.array(person),
  }),
) {}
