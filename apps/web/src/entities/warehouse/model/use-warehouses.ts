'use client';

import { useWarehousesControllerMine } from '@/shared/api/generated/warehouses/warehouses';

export const useMyWarehouses = () => useWarehousesControllerMine();

export const warehouseName = (
  list: readonly { id: string; code: string; name: string }[] | undefined,
  id: string,
): string => {
  const w = list?.find((x) => x.id === id);
  return w === undefined ? id.slice(0, 8) : `${w.code} - ${w.name}`;
};
