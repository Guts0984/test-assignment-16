import { LeadReportPage } from '@/pages/lead';

export default async function Page({ params }: { params: Promise<{ warehouseId: string }> }) {
  const { warehouseId } = await params;
  return <LeadReportPage warehouseId={warehouseId} />;
}
