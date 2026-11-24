import { type CookieOptions } from 'express';
import { type ApiEnv } from '../../../config/env';

export const REFRESH_COOKIE = 'ff_refresh';

export const refreshCookieOptions = (env: ApiEnv): CookieOptions => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: env.COOKIE_SECURE,
  path: '/api/auth',
});
