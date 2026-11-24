import { LeadOrdersPage } from '@/pages/lead';

export default async function Page({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = await params;
  return <LeadOrdersPage warehouseId={warehouseId} />;
}
