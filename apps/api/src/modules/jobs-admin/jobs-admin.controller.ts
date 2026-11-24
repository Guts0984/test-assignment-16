import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { type Db } from '@ff/db/client';
import { type Clock } from '@ff/core/clock';
import { reviveDeadEvents } from '@ff/core/jobs/webhooks';
import { deadActions, rerunDeadAction } from '@ff/core/scheduled-actions';
import { AdminOnly } from '../../common/auth/access.decorator';
import { httpError } from '../../common/errors';
import { ApiProtectedErrors, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { CLOCK, DB } from '../../infra/tokens';

const jobSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  key: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  dueAt: z.string(),
  updatedAt: z.string(),
});
class FailedJobsDto extends createZodDto(z.object({ items: z.array(jobSchema) })) {}
class RerunDto extends createZodDto(z.object({ id: z.string().uuid(), rerun: z.boolean() })) {}

/** Jobs that used up their attempts: visible to admins only, rerunnable by hand exactly once. */
@ApiTags('admin')
@Controller('admin/jobs')
export class JobsAdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('failed')
  @AdminOnly()
  @Ok(FailedJobsDto)
  @ApiProtectedErrors()
  async failed() {
    const rows = await deadActions(this.db, 200);
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        key: r.key,
        attempts: r.attempts,
        lastError: r.lastError,
        dueAt: r.dueAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  @Post('failed/:id/rerun')
  @HttpCode(200)
  @AdminOnly()
  @Ok(RerunDto)
  @ApiProtectedErrors(404, 409)
  async rerun(@Param('id', UUID) id: string) {
    const now = this.clock.now();
    const row = await this.db.scheduledAction.findUnique({ where: { id } });
    if (row === null) throw httpError('NOT_FOUND', 'job not found');
    if (row.status !== 'dead') throw httpError('JOB_NOT_RERUNNABLE', 'only failed jobs can be rerun');
    const ok = await rerunDeadAction(this.db, id, now);
    if (!ok) throw httpError('JOB_NOT_RERUNNABLE', 'the job was already rerun');
    if (row.kind === 'webhook_stream') {
      const [shopId = '', ...rest] = row.key.split('|');
      await reviveDeadEvents(this.db, shopId, rest.join('|'), now);
    }
    return { id, rerun: true };
  }
}
