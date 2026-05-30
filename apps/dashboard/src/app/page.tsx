import Link from 'next/link';
import { ArrowRightIcon, CheckIcon, EyeIcon, GaugeIcon, GitPullRequestIcon, LockIcon, ShieldIcon, SparkleIcon } from '@clawreview/ui';

import { SampleComment } from '@/components/sample-comment';
import { TopNav } from '@/components/top-nav';
import { Footer } from '@/components/footer';

export default function HomePage() {
  return (
    <main className="relative">
      <div className="gradient-radial pointer-events-none absolute inset-x-0 top-0 h-[500px]" />
      <TopNav />
      <Hero />
      <HowItWorks />
      <Features />
      <SampleSection />
      <Pricing />
      <Footer />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative mx-auto max-w-5xl px-4 pb-16 pt-20 sm:pt-28">
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-subtle/60 px-2 py-0.5 font-mono text-[11px] text-fg-muted">
          <SparkleIcon size={12} /> pre-alpha. built for repos you own.
        </span>
        <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          one pr comment. many specialists behind it.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-balance text-sm text-fg-muted sm:text-base">
          security, performance, style, secrets. parallel agents. one ranked comment with file:line anchors and patches.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            href={'/login' as any}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 font-mono text-xs font-medium text-accent-fg hover:bg-accent/90"
          >
            install on github <ArrowRightIcon size={14} />
          </Link>
          <Link
            href={'/docs' as any}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-3 font-mono text-xs font-medium text-fg hover:bg-bg-muted"
          >
            read the docs
          </Link>
        </div>
        <p className="mt-3 font-mono text-[11px] text-fg-subtle">no card. self-host with docker compose.</p>
      </div>
    </section>
  );
}

const STEPS = [
  { icon: <GitPullRequestIcon />, title: 'pr opens or updates', body: 'webhook verified, review queued, diff fetched.' },
  { icon: <ShieldIcon />, title: 'specialists run in parallel', body: 'security, performance, style, secrets. each scans its slice.' },
  { icon: <CheckIcon />, title: 'one ranked comment lands', body: 'aggregator dedupes, ranks by severity, posts a check-run.' },
];

function HowItWorks() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <h2 className="font-mono text-xl font-semibold tracking-tight lowercase">how it works</h2>
      <p className="mt-1 text-sm text-fg-muted">plug the github app in. pipeline runs in &lt;60s on a 500-line diff.</p>
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="relative overflow-hidden rounded-md border border-border bg-bg-subtle/40 p-4">
            <div className="absolute right-3 top-3 font-mono text-[10px] text-fg-subtle">{String(i + 1).padStart(2, '0')}</div>
            <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-bg text-accent">{s.icon}</div>
            <h3 className="mt-3 font-mono text-sm font-semibold lowercase">{s.title}</h3>
            <p className="mt-0.5 text-xs text-fg-muted">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const FEATURES = [
  { icon: <ShieldIcon />, title: 'security', body: 'cwe-tagged findings on auth, injection, deserialization, secrets.' },
  { icon: <GaugeIcon />, title: 'performance', body: 'flags n+1 queries, quadratic loops, blocking io on request paths.' },
  { icon: <EyeIcon />, title: 'style + readability', body: 'confusing names, dead code, unsafe casts. no nit spam.' },
  { icon: <LockIcon />, title: 'secret scanning', body: 'regex pre-filter + llm confirm. no false-positive chase.' },
  { icon: <SparkleIcon />, title: 'per-repo config', body: '.clawreview.yml controls agents, models, paths, budget.' },
  { icon: <GitPullRequestIcon />, title: 'one comment, ranked', body: 'aggregator merges dupes. no three-comment dogpile.' },
];

function Features() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <h2 className="font-mono text-xl font-semibold tracking-tight lowercase">what ships in the box</h2>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-md border border-border bg-bg-subtle/40 p-3">
            <div className="text-accent">{f.icon}</div>
            <h3 className="mt-2 font-mono text-sm font-semibold lowercase">{f.title}</h3>
            <p className="mt-0.5 text-xs text-fg-muted">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SampleSection() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="grid gap-6 md:grid-cols-2 md:items-center">
        <div>
          <h2 className="font-mono text-xl font-semibold tracking-tight lowercase">high-signal pr comments</h2>
          <p className="mt-2 text-sm text-fg-muted">
            severity. category. agent. precise file:line. optional suggested patch you can paste.
          </p>
          <ul className="mt-4 space-y-1.5 font-mono text-xs text-fg-muted">
            <li className="flex items-center gap-2"><CheckIcon size={12} /> one comment per review, edited in place on new pushes.</li>
            <li className="flex items-center gap-2"><CheckIcon size={12} /> check-run conclusion derived from the worst finding.</li>
            <li className="flex items-center gap-2"><CheckIcon size={12} /> dismiss with a reason. sticks across syncs.</li>
          </ul>
        </div>
        <SampleComment />
      </div>
    </section>
  );
}

const TIERS = [
  { name: 'solo', price: 'free', blurb: '1 repo, 200 reviews/mo, community support.', features: ['all agents', 'per-repo config', 'cli dogfood mode'] },
  { name: 'team', price: '$29/mo', blurb: '25 repos, 2k reviews/mo, audit log retention.', features: ['org rbac', 'cost guards', 'email digest'] },
  { name: 'enterprise', price: 'contact', blurb: 'unlimited repos, self-host, byo llm, saml.', features: ['soc 2 controls', 'private deploy', 'custom agents'] },
];

function Pricing() {
  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <h2 className="font-mono text-xl font-semibold tracking-tight lowercase">pricing preview</h2>
      <p className="mt-1 text-sm text-fg-muted">subject to change before 0.1.0. self-host stays free.</p>
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {TIERS.map((t) => (
          <div key={t.name} className="rounded-md border border-border bg-bg-subtle/40 p-4">
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">{t.name}</div>
            <div className="mt-1 font-mono text-2xl font-semibold tracking-tight">{t.price}</div>
            <p className="mt-1 text-xs text-fg-muted">{t.blurb}</p>
            <ul className="mt-3 space-y-1 font-mono text-xs">
              {t.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-fg">
                  <CheckIcon size={12} className="text-accent" /> {f}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
