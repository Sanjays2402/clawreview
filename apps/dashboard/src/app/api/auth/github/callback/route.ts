import { NextResponse } from 'next/server';

import { env } from '@/lib/env';

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookie = req.headers.get('cookie') ?? '';
  const cookieState = cookie.match(/clawreview-oauth-state=([^;]+)/)?.[1];
  if (!code || !state || !cookieState || cookieState !== state) {
    return new NextResponse('Bad OAuth state', { status: 400 });
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new NextResponse('OAuth not configured', { status: 503 });
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.PUBLIC_URL}/api/auth/github/callback`,
    }),
  });
  const token = (await tokenRes.json()) as TokenResponse;
  if (!token.access_token) {
    return new NextResponse(`OAuth exchange failed: ${token.error ?? 'unknown'}`, { status: 400 });
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json' },
  });
  const user = (await userRes.json()) as GitHubUser;

  const res = NextResponse.redirect(new URL('/app', env.PUBLIC_URL));
  res.cookies.set('clawreview-session', `gh:${user.id}:${user.login}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  res.cookies.set('clawreview-oauth-state', '', { path: '/', maxAge: 0 });
  return res;
}
