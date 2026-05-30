import { Card, CardBody, CardHeader } from '@clawreview/ui';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-48 animate-pulse rounded bg-bg-subtle" />
      <div className="h-8 w-72 animate-pulse rounded bg-bg-subtle" />
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardHeader>
              <div className="h-4 w-24 animate-pulse rounded bg-bg-subtle" />
            </CardHeader>
            <CardBody>
              <div className="h-7 w-32 animate-pulse rounded bg-bg-subtle" />
            </CardBody>
          </Card>
        ))}
      </div>
      <Card>
        <CardBody>
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 w-full animate-pulse rounded bg-bg-subtle" />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
