'use server';

import { validateConfig, type ValidateConfigResult } from '@/lib/data';

export interface ValidateActionState {
  status: 'idle' | 'ok' | 'invalid' | 'error';
  message?: string;
  issues?: { formErrors: string[]; fieldErrors: Record<string, string[]> };
  configJson?: string;
  yaml?: string;
}

export async function validateConfigAction(
  _prev: ValidateActionState,
  formData: FormData,
): Promise<ValidateActionState> {
  const yaml = String(formData.get('yaml') ?? '').trim();
  if (!yaml) {
    return { status: 'error', message: 'Paste a .clawreview.yml document to validate.', yaml };
  }
  const result: ValidateConfigResult = await validateConfig(yaml);
  if (result.ok) {
    return {
      status: 'ok',
      message: 'Config is valid.',
      configJson: JSON.stringify(result.config, null, 2),
      yaml,
    };
  }
  if (result.issues) {
    return { status: 'invalid', message: 'Schema validation failed.', issues: result.issues, yaml };
  }
  return { status: 'error', message: result.error ?? 'Validation failed.', yaml };
}
