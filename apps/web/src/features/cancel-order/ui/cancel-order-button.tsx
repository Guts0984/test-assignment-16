'use client';

import { useQueryClient } from '@tanstack/react-query';
import { canCancel } from '@/entities/order';
import { useShopOutboundControllerCancel } from '@/shared/api/generated/shop/shop';
import { messageOf } from '@/shared/lib/form-errors';
import { Button, toast } from '@/shared/ui';

export const CancelOrderButton = ({ orderId, status }: { orderId: string; status: string }) => {
  const qc = useQueryClient();
  const cancel = useShopOutboundControllerCancel();
  if (!canCancel(status)) return null;
  return (
    <Button
      variant="danger"
      disabled={cancel.isPending}
      onClick={async () => {
        try {
          await cancel.mutateAsync({ id: orderId, data: {} });
          toast('ok', 'Order cancelled');
          await qc.invalidateQueries();
        } catch (e) {
          toast('error', messageOf(e));
        }
      }}
    >
      Cancel order
    </Button>
  );
};
