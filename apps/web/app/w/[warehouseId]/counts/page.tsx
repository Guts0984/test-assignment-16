import { LeadCountsPage } from '@/pages/lead';

export default async function Page({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = await params;
  return <LeadCountsPage warehouseId={warehouseId} />;
}
