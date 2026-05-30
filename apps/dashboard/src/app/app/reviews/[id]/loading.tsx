import { Skeleton } from '@clawreview/ui';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-32 lg:col-span-2" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
