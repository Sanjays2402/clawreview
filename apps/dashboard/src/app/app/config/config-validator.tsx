'use client';

import { useActionState } from 'react';

import { Banner } from '@/components/ui/banner';

import { validateConfigAction, type ValidateActionState } from './actions';

const INITIAL: ValidateActionState = { status: 'idle' };

export function ConfigValidator({ defaultYaml }: { defaultYaml: string }) {
  const [state, formAction, pending] = useActionState(validateConfigAction, INITIAL);
  const yaml = state.yaml ?? defaultYaml;

  return (
    <form action={formAction} className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-2">
        <label htmlFor="yaml" className="text-xs font-medium text-fg-muted">
          .clawreview.yml
        </label>
        <textarea
          id="yaml"
          name="yaml"
          spellCheck={false}
          defaultValue={yaml}
          className="font-mono min-h-[420px] w-full rounded-lg border border-border bg-bg-subtle p-3 text-xs leading-relaxed text-fg outline-none focus:border-accent"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center rounded-lg bg-fg px-3 text-xs font-medium text-bg transition-colors hover:bg-fg/90 disabled:opacity-50"
          >
            {pending ? 'Validating' : 'Validate'}
          </button>
          <button
            type="reset"
            className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-xs font-medium text-fg-muted hover:bg-bg-subtle"
          >
            Reset
          </button>
          <span className="text-xs text-fg-muted">POST /api/config/validate</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-fg-muted">Result</div>
        {state.status === 'idle' ? (
          <div className="rounded-lg border border-dashed border-border-subtle p-6 text-center text-sm text-fg-muted">
            Paste a config and click Validate to see parse and schema results.
          </div>
        ) : null}

        {state.status === 'ok' ? (
          <>
            <Banner tone="info">{state.message}</Banner>
            <pre className="overflow-auto rounded-lg border border-border bg-bg-subtle p-3 text-xs leading-relaxed">
              {state.configJson}
            </pre>
          </>
        ) : null}

        {state.status === 'invalid' ? (
          <>
            <Banner tone="warning">{state.message}</Banner>
            {state.issues?.formErrors && state.issues.formErrors.length > 0 ? (
              <ul className="rounded-lg border border-border p-3 text-xs text-fg">
                {state.issues.formErrors.map((e, i) => (
                  <li key={i} className="font-mono">{e}</li>
                ))}
              </ul>
            ) : null}
            {state.issues?.fieldErrors && Object.keys(state.issues.fieldErrors).length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-bg-subtle text-fg-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Field</th>
                      <th className="px-3 py-2 text-left font-medium">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(state.issues.fieldErrors).map(([field, msgs]) => (
                      <tr key={field} className="border-t border-border-subtle">
                        <td className="px-3 py-2 font-mono">{field}</td>
                        <td className="px-3 py-2">{msgs.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}

        {state.status === 'error' ? <Banner tone="danger">{state.message}</Banner> : null}
      </div>
    </form>
  );
}
