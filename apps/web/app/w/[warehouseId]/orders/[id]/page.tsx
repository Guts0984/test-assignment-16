import { LeadOrderPage } from '@/pages/lead';

export default async function Page({ params }: { params: Promise<{ warehouseId: string; id: string }> }) {
  const { warehouseId, id } = await params;
  return <LeadOrderPage warehouseId={warehouseId} id={id} />;
}
