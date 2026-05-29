import { trace, type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api';

let tracerName = 'clawreview';

export function setTracerName(name: string): void {
  tracerName = name;
}

export function getTracer(): Tracer {
  return trace.getTracer(tracerName);
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    if (attrs) span.setAttributes(attrs);
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
