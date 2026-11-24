// BullMQ processors: one Worker per queue plus the reconciler loop. A job only carries the id of a
// scheduled_actions row; processing claims that row (so copies never run it twice) and runs its handler.
import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Worker } from 'bullmq';
import { QUEUE_NAMES, type JobData, type QueueName } from '@ff/core/queues';
import { processAction } from '@ff/core/jobs/run-action';
import { reconcileOnce } from '@ff/core/jobs/reconciler';
import { redisOptions } from '@ff/core/redis';
import { type Runtime } from './infra/deps';

export class JobsProcessor implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('worker');
  private workers: Worker<JobData>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly rt: Runtime) {}

  onApplicationBootstrap(): void {
    const connection = { ...redisOptions(this.rt.env.REDIS_URL), maxRetriesPerRequest: null };
    this.workers = QUEUE_NAMES.map((name: QueueName) => {
      const w = new Worker<JobData>(
        name,
        async (job) => {
          const outcome = await processAction(this.rt.jobDeps, job.data.actionId, this.rt.workerId);
          if (outcome === 'dead') this.log.warn(`action ${job.data.actionId} exhausted its attempts`);
        },
        {
          connection,
          prefix: 'ff',
          concurrency:
            name === 'webhooks' ? this.rt.env.WORKER_CONCURRENCY * 4 : this.rt.env.WORKER_CONCURRENCY,
        },
      );
      w.on('error', () => undefined);
      return w;
    });
    this.timer = setInterval(() => void this.tick(), this.rt.env.RECONCILE_INTERVAL_MS);
    void this.tick();
    this.log.log(`${this.rt.workerId} started`);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await reconcileOnce({
        ...this.rt.jobDeps,
        queues: this.rt.queues,
        nightlyLocalTime: this.rt.env.NIGHTLY_LOCAL_TIME,
      });
    } catch (e) {
      this.log.warn(`reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await this.rt.stop();
  }
}
