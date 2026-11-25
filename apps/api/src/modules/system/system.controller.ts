import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { type Redis } from 'ioredis';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { type Db } from '@ff/db/client';
import { changeTestClock, type Clock, type SharedTestClock } from '@ff/core/clock';
import { type ApiEnv } from '../../config/env';
import { Public } from '../../common/auth/access.decorator';
import { httpError } from '../../common/errors';
import { ApiErrors, Ok } from '../../common/openapi.decorator';
import { CLOCK, DB, ENV, REDIS, TEST_CLOCK } from '../../infra/tokens';
import { HealthDto, TestClockDto, TestClockResultDto, TimeDto } from './dto/system.dto';

/** Readiness must fail fast: a hung dependency is "not ready", not a 60 s wait. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });

@ApiTags('system')
@Controller()
export class SystemController {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
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
    try {
      await this.db.$queryRaw`SELECT 1`;
    } catch {
      throw httpError('UNAVAILABLE', 'database is not reachable');
    }
    return { ok: true, instance: this.env.API_INSTANCE_ID };
  }

  /** Readiness: the database AND Redis answer (Redis only carries disposable state, so /health ignores it). */
  @Get('ready')
  @Public()
  @Ok(HealthDto)
  @ApiErrors()
  async ready(): Promise<HealthDto> {
    try {
      await withTimeout(Promise.all([this.db.$queryRaw`SELECT 1`, this.redis.ping()]), 2000);
    } catch {
      throw httpError('UNAVAILABLE', 'a dependency is not reachable');
    }
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
