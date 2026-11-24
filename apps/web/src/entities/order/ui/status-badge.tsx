import { Badge } from '@/shared/ui';
import { statusColor, statusLabel } from '../model/status';

export const StatusBadge = ({ status }: { status: string }) => (
  <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>
);
