import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Redis } from 'ioredis';
import { dashboard } from '@ff/core/floor/dashboard';
import { periodReport } from '@ff/core/floor/reports';
import { StaffAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { warehousesOf, type StaffPrincipal } from '../../common/auth/principal';
import { httpError } from '../../common/errors';
import { ApiProtectedErrors, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { REDIS } from '../../infra/tokens';
import { presenceOnline } from '../realtime/presence';
import { DashboardDto, ReportDto, ReportQueryDto } from './dto/floor.dto';
import { FloorService } from './floor.service';
import { LEAD } from './roles';

@ApiTags('shift lead')
@Controller()
export class LeadController {
  constructor(
    private readonly floor: FloorService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('warehouses/:warehouseId/dashboard')
  @StaffAccess(LEAD, 'warehouseId')
  @Ok(DashboardDto)
  @ApiProtectedErrors(404)
  async dashboard(@Param('warehouseId', UUID) wid: string) {
    const online = await presenceOnline(this.redis, wid).catch(() => new Set<string>());
    const d = await dashboard(
      this.floor.db,
      wid,
      this.floor.clock.now(),
      this.floor.env.AT_RISK_THRESHOLD_MIN,
      online,
    );
    if (d === null) throw httpError('NOT_FOUND', 'warehouse not found');
    return d;
  }

  /** Period and filters come from the query string, so the page state lives in the URL. */
  @Get('reports/summary')
  @StaffAccess(LEAD)
  @Ok(ReportDto)
  @ApiProtectedErrors()
  async report(@CurrentPrincipal() p: StaffPrincipal, @Query() q: ReportQueryDto) {
    const mine = warehousesOf(p, LEAD);
    if (q.warehouseId !== undefined && mine !== 'all' && !mine.includes(q.warehouseId))
      throw httpError('FORBIDDEN', 'not your warehouse');
    const warehouseIds = q.warehouseId !== undefined ? [q.warehouseId] : mine === 'all' ? null : mine;
    return periodReport(this.floor.db, {
      from: q.from,
      to: q.to,
      warehouseIds,
      ...(q.staffId === undefined ? {} : { staffId: q.staffId }),
    });
  }
}
