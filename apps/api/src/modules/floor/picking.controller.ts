import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { reportShortage } from '@ff/core/floor/shortage';
import { reassignTask, scanCell, scanItem, takeNextTask, taskView } from '@ff/core/floor/picking';
import { formWave } from '@ff/core/floor/waves';
import { scheduleAction } from '@ff/core/scheduled-actions';
import { RateLimit, StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type StaffPrincipal } from '../../common/auth/principal';
import { httpError, unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import {
  CellLinesDto,
  ReassignDto,
  ScanCellDto,
  ScanItemDto,
  ScanResultDto,
  ShortageDto,
  TaskDto,
  TaskListDto,
  WaveDto,
  WaveListDto,
} from './dto/floor.dto';
import { FloorService } from './floor.service';
import { isLeadAt, LEAD, PICK, PICK_VIEW } from './roles';

@ApiTags('picking')
@Controller('warehouses/:warehouseId')
export class PickingController {
  constructor(private readonly floor: FloorService) {}

  @Get('waves')
  @StaffAccess(LEAD, 'warehouseId')
  @Ok(WaveListDto)
  @ApiProtectedErrors()
  async waves(@Param('warehouseId', UUID) wid: string) {
    const rows = await this.floor.db.wave.findMany({
      where: { warehouseId: wid },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: rows.map((w) => ({
        id: w.id,
        trigger: w.trigger,
        createdAt: w.createdAt.toISOString(),
        orderCount: w.orderCount,
      })),
    };
  }

  /** Manual wave by the shift lead; resets the 15-minute timer. */
  @Post('waves')
  @StaffAccess(LEAD, 'warehouseId')
  @Created(WaveDto)
  @ApiProtectedErrors()
  async startWave(@Param('warehouseId', UUID) wid: string, @CurrentPrincipal() p: StaffPrincipal) {
    const r = unwrap(await this.floor.run((d, fx) => formWave(d, fx, wid, 'manual', p.id)));
    const next = new Date(this.floor.clock.now().getTime() + this.floor.env.WAVE_INTERVAL_MIN * 60_000);
    await this.floor.db
      .$executeRaw`UPDATE scheduled_actions SET due_at = ${next} WHERE kind = 'wave_timer' AND key = ${wid} AND status = 'pending'`;
    await scheduleAction(this.floor.db, { kind: 'wave_timer', key: wid, dueAt: next });
    return r;
  }

  @Get('tasks')
  @StaffAccess(LEAD, 'warehouseId')
  @Ok(TaskListDto)
  @ApiProtectedErrors()
  async tasks(@Param('warehouseId', UUID) wid: string) {
    const rows = await this.floor.db.$queryRaw<
      {
        id: string;
        order_id: string;
        external_number: string;
        status: string;
        assignee_id: string | null;
        lines: number;
        done: number;
      }[]
    >`
      SELECT t.id, t.order_id, o.external_number, t.status, t.assignee_id, count(pl.id)::int AS lines, count(pl.id) FILTER (WHERE pl.status <> 'open')::int AS done
      FROM pick_tasks t JOIN orders o ON o.id = t.order_id LEFT JOIN pick_lines pl ON pl.task_id = t.id
      WHERE t.warehouse_id = ${wid}::uuid AND t.status IN ('pending', 'assigned') GROUP BY t.id, o.external_number ORDER BY t.priority_rank LIMIT 300`;
    return {
      items: rows.map((t) => ({
        id: t.id,
        orderId: t.order_id,
        orderNumber: t.external_number,
        warehouseId: wid,
        status: t.status,
        assigneeId: t.assignee_id,
        lines: t.lines,
        linesDone: t.done,
      })),
    };
  }

  @Post('tasks/next')
  @HttpCode(200)
  @StaffAccess(PICK, 'warehouseId')
  @Ok(TaskDto)
  @ApiProtectedErrors(422)
  async next(@Param('warehouseId', UUID) wid: string, @CurrentPrincipal() p: StaffPrincipal) {
    return unwrap(await this.floor.run((d, fx) => takeNextTask(d, fx, wid, p.id)));
  }

  /** A picker sees only their own task; the shift lead sees all tasks of the warehouse. */
  @Get('tasks/:id')
  @StaffAccess(PICK_VIEW, 'warehouseId')
  @Ok(TaskDto)
  @ApiProtectedErrors(404)
  async task(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
  ) {
    const v = await taskView(this.floor.db, id);
    if (v === null || v.warehouseId !== wid || (!isLeadAt(p, wid) && v.assigneeId !== p.id))
      throw httpError('NOT_FOUND', 'task not found');
    return v;
  }

  @Post('tasks/:id/scan-cell')
  @HttpCode(200)
  @StaffAccess(PICK, 'warehouseId')
  @RateLimit('scan')
  @Ok(CellLinesDto)
  @ApiProtectedErrors(422)
  async scanCell(
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ScanCellDto,
  ) {
    return unwrap(await scanCell(this.floor.deps, id, p.id, b.cellCode));
  }

  @Post('tasks/:id/scan')
  @HttpCode(200)
  @StaffAccess(PICK, 'warehouseId')
  @RateLimit('scan')
  @Ok(ScanResultDto)
  @ApiProtectedErrors(409, 422)
  async scan(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ScanItemDto,
  ) {
    await this.assertTaskAt(id, wid);
    return unwrap(await this.floor.run((d, fx) => scanItem(d, fx, id, p.id, b)));
  }

  @Post('tasks/:id/shortage')
  @HttpCode(200)
  @StaffAccess(PICK, 'warehouseId')
  @RateLimit('scan')
  @Ok(TaskDto)
  @ApiProtectedErrors(409, 422)
  async shortage(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ShortageDto,
  ) {
    await this.assertTaskAt(id, wid);
    return unwrap(await this.floor.run((d, fx) => reportShortage(d, fx, id, p.id, b)));
  }

  @Post('tasks/:id/reassign')
  @HttpCode(200)
  @StaffAccess(LEAD, 'warehouseId')
  @Ok(TaskDto)
  @ApiProtectedErrors(404, 409, 422)
  async reassign(
    @Param('warehouseId', UUID) wid: string,
    @Param('id', UUID) id: string,
    @CurrentPrincipal() p: StaffPrincipal,
    @Body() b: ReassignDto,
  ) {
    return unwrap(await this.floor.run((d, fx) => reassignTask(d, fx, wid, id, b.pickerId, p.id)));
  }

  private async assertTaskAt(taskId: string, warehouseId: string): Promise<void> {
    if ((await this.floor.db.pickTask.count({ where: { id: taskId, warehouseId } })) === 0)
      throw httpError('NOT_FOUND', 'task not found');
  }
}
