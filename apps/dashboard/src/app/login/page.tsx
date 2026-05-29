import Link from 'next/link';

export default function LoginPage() {
  const githubLoginUrl = process.env.NEXT_PUBLIC_GITHUB_OAUTH_URL ?? '/api/auth/github';

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-subtle/50 p-7 text-center backdrop-blur">
        <Link href="/" className="mx-auto inline-flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">ClawReview</span>
        </Link>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-fg-muted">
          We use GitHub OAuth and the same identity that owns your installation.
        </p>
        <a
          href={githubLoginUrl}
          className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-fg text-sm font-medium text-bg transition-colors hover:bg-fg/90"
        >
          <GitHubMark /> Continue with GitHub
        </a>
        <p className="mt-4 text-xs text-fg-subtle">
          By signing in you agree to the project licence and the security policy.
        </p>
      </div>
    </main>
  );
}

function GitHubMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.1.63-1.35-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.26-.45-1.28.1-2.67 0 0 .84-.27 2.75 1.02a9.55 9.55 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.39.2 2.41.1 2.67.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.7-4.57 4.95.36.31.68.93.68 1.87v2.78c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}
