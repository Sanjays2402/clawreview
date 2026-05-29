'use client';

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html>
      <body className="grid min-h-screen place-items-center bg-bg px-6 text-fg">
        <div className="text-center">
          <div className="text-xs uppercase tracking-wide text-fg-subtle">Error</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="mt-2 max-w-md text-sm text-fg-muted">{error.message}</p>
          <button onClick={reset} className="mt-6 rounded-lg bg-fg px-4 py-2 text-xs font-medium text-bg">Try again</button>
        </div>
      </body>
    </html>
  );
}
