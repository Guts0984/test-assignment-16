// Injection tokens for infrastructure created at the edge (db, redis, queues, clock, emitter).
export const ENV = Symbol('ENV');
export const DB = Symbol('DB');
export const REDIS = Symbol('REDIS');
export const LIMITER = Symbol('LIMITER');
export const CLOCK = Symbol('CLOCK');
export const TEST_CLOCK = Symbol('TEST_CLOCK');
export const QUEUES = Symbol('QUEUES');
export const EMITTER = Symbol('EMITTER');
export const TRUSTED_PROXIES = Symbol('TRUSTED_PROXIES');
