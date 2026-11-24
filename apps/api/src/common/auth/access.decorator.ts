// Route access metadata. Every route must declare one; the guard denies undeclared routes.
import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { type StaffRole } from '@ff/shared/domain';
import { type PrincipalKind } from './principal';

export const ACCESS_KEY = 'ff:access';

export type AccessRule =
  | { readonly public: true }
  | {
      readonly public?: false;
      readonly principals: readonly PrincipalKind[];
      /** Staff must hold one of these roles (admin always passes). */
      readonly roles?: readonly StaffRole[];
      /** Route param holding a warehouse id; the roles must be held at that warehouse. */
      readonly warehouseParam?: string;
    };

export const Public = () => SetMetadata(ACCESS_KEY, { public: true } satisfies AccessRule);

export const StaffAccess = (roles: readonly StaffRole[], warehouseParam?: string) =>
  applyDecorators(
    SetMetadata(ACCESS_KEY, {
      principals: ['staff'],
      roles,
      ...(warehouseParam ? { warehouseParam } : {}),
    } satisfies AccessRule),
    ApiBearerAuth(),
  );

export const AdminOnly = () => StaffAccess(['admin']);

export const ShopAccess = () =>
  applyDecorators(
    SetMetadata(ACCESS_KEY, { principals: ['shop_user', 'api_key'] } satisfies AccessRule),
    ApiBearerAuth(),
  );

export const AnyPrincipal = () =>
  applyDecorators(
    SetMetadata(ACCESS_KEY, { principals: ['staff', 'shop_user', 'api_key'] } satisfies AccessRule),
    ApiBearerAuth(),
  );

export const RATE_LIMIT_KEY = 'ff:rate-limit';
export type RateBucket = 'login' | 'scan';
export const RateLimit = (bucket: RateBucket) => SetMetadata(RATE_LIMIT_KEY, bucket);
