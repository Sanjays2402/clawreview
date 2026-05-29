import { redirect } from 'next/navigation';

import { env } from '@/lib/env';

export async function GET() {
  if (!env.GITHUB_CLIENT_ID) {
    return new Response(
      'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, then restart the dashboard.',
      { status: 503 },
    );
  }
  const state = crypto.randomUUID();
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${env.PUBLIC_URL}/api/auth/github/callback`);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);

  const res = new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      'set-cookie': `clawreview-oauth-state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
  return res;
}
