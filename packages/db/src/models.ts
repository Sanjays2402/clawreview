import type { Severity } from '@clawreview/types';

export interface ReviewRecord {
  id: string;
  pullRequestId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt?: Date | null;
  totalCostUsd: number;
  totalFindings: number;
}

export interface FindingRecord {
  id: string;
  reviewId: string;
  agent: string;
  category: string;
  severity: Severity;
  title: string;
  rationale: string;
  file: string;
  startLine: number;
  endLine: number | null;
  confidence: number;
  cwe: string | null;
  dismissed: boolean;
}
