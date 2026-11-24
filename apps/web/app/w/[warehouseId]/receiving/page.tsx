import { ReceivingPage } from '@/pages/floor';

export default async function Page({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = await params;
  return <ReceivingPage warehouseId={warehouseId} />;
}
