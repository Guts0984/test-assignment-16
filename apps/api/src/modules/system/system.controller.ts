import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { type Db } from '@ff/db/client';
import { changeTestClock, type Clock, type SharedTestClock } from '@ff/core/clock';
import { type ApiEnv } from '../../config/env';
import { Public } from '../../common/auth/access.decorator';
import { httpError } from '../../common/errors';
import { ApiErrors, Ok } from '../../common/openapi.decorator';
import { CLOCK, DB, ENV, TEST_CLOCK } from '../../infra/tokens';
import { HealthDto, TestClockDto, TestClockResultDto, TimeDto } from './dto/system.dto';

@ApiTags('system')
@Controller()
export class SystemController {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Clients compute "time to cutoff" from this, never from their own clock. */
  @Get('time')
  @Public()
  @Ok(TimeDto)
  @ApiErrors()
  time(): TimeDto {
    return { now: this.clock.now().toISOString(), instance: this.env.API_INSTANCE_ID };
  }

  @Get('health')
  @Public()
  @Ok(HealthDto)
  @ApiErrors()
  async health(): Promise<HealthDto> {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true, instance: this.env.API_INSTANCE_ID };
  }
}

/** Mounted only when TEST_CLOCK_ENABLED=true (the route does not exist otherwise). */
@ApiExcludeController()
@Controller('test')
export class TestClockController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(TEST_CLOCK) private readonly testClock: SharedTestClock | null,
  ) {}

  @Post('clock')
  @HttpCode(200)
  @Public()
  async set(
    @Headers('x-test-token') token: string | undefined,
    @Body() b: TestClockDto,
  ): Promise<TestClockResultDto> {
    const expected = Buffer.from(this.env.TEST_CONTROL_TOKEN ?? '');
    const given = Buffer.from(token ?? '');
    if (
      this.testClock === null ||
      expected.length === 0 ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      throw httpError('FORBIDDEN', 'test control token required');
    }
    const offsetMs = await changeTestClock(
      this.db,
      b.setTo !== undefined
        ? { setTo: new Date(b.setTo) }
        : b.advanceMs !== undefined
          ? { advanceMs: b.advanceMs }
          : { reset: true },
    );
    await this.testClock.refresh();
    return { now: this.testClock.clock.now().toISOString(), offsetMs };
  }
}
