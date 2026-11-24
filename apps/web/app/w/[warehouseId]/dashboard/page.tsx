import { LeadDashboardPage } from '@/pages/lead';

export default async function Page({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = await params;
  return <LeadDashboardPage warehouseId={warehouseId} />;
}
