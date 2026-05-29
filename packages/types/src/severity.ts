import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'nit']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  nit: 'Nit',
};
