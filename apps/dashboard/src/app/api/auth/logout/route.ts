import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.redirect(new URL('/', process.env.PUBLIC_URL ?? 'http://localhost:3000'));
  res.cookies.set('clawreview-session', '', { path: '/', maxAge: 0 });
  return res;
}
