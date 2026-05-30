import Link from 'next/link';

export default function LoginPage() {
  const githubLoginUrl = process.env.NEXT_PUBLIC_GITHUB_OAUTH_URL ?? '/api/auth/github';

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-md border border-border bg-bg-subtle/50 p-5 text-center">
        <Link href="/" className="mx-auto inline-flex items-center gap-1.5">
          <span className="font-mono text-[12px] font-semibold tracking-tight">clawreview</span>
        </Link>
        <h1 className="mt-5 font-mono text-base font-semibold tracking-tight lowercase">sign in</h1>
        <p className="mt-0.5 text-xs text-fg-muted">github oauth. same identity that owns your install.</p>
        <a
          href={githubLoginUrl}
          className="mt-5 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-fg font-mono text-xs font-medium text-bg transition-colors hover:bg-fg/90"
        >
          <GitHubMark /> continue with github
        </a>
        <p className="mt-3 font-mono text-[10px] text-fg-subtle">
          by signing in you agree to the project licence and security policy.
        </p>
      </div>
    </main>
  );
}

function GitHubMark() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.1.63-1.35-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.26-.45-1.28.1-2.67 0 0 .84-.27 2.75 1.02a9.55 9.55 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.39.2 2.41.1 2.67.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.93.68 1.87v2.78c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}
