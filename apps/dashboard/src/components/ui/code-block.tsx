export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs leading-relaxed text-fg">
      <code data-lang={lang}>{code}</code>
    </pre>
  );
}
