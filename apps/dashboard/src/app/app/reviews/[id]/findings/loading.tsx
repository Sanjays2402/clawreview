import { Card, CardBody, CardHeader } from '@clawreview/ui';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-64 animate-pulse rounded bg-bg-subtle" />
      <div className="h-8 w-40 animate-pulse rounded bg-bg-subtle" />
      <Card>
        <CardHeader>
          <div className="h-5 w-32 animate-pulse rounded bg-bg-subtle" />
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 w-full animate-pulse rounded bg-bg-subtle" />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
