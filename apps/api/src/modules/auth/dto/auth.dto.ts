import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { STAFF_ROLES } from '@ff/shared/domain';
import { loginSchema } from '@ff/shared/schemas/setup';

export class LoginDto extends createZodDto(loginSchema) {}

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200).optional() }).strict();
export class RefreshDto extends createZodDto(refreshSchema) {}

export const meSchema = z.object({
  kind: z.enum(['staff', 'shop_user', 'api_key']),
  id: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  shopId: z.string().uuid().nullable(),
  roles: z.array(z.object({ role: z.enum(STAFF_ROLES), warehouseId: z.string().uuid().nullable() })),
});
export class MeDto extends createZodDto(meSchema) {}

export const sessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  /** Also set as an httpOnly cookie; returned for non-browser clients. */
  refreshToken: z.string(),
  me: meSchema,
});
export class SessionDto extends createZodDto(sessionSchema) {}
