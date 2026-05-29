import Link from 'next/link';
import { ArrowRightIcon, CheckIcon, EyeIcon, GaugeIcon, GitPullRequestIcon, LockIcon, ShieldIcon, SparkleIcon } from '@clawreview/ui';

import { SampleComment } from '@/components/sample-comment';
import { TopNav } from '@/components/top-nav';
import { Footer } from '@/components/footer';

export default function HomePage() {
  return (
    <main className="relative">
      <div className="gradient-radial pointer-events-none absolute inset-x-0 top-0 h-[600px]" />
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
    <section className="relative mx-auto max-w-6xl px-6 pb-20 pt-24 sm:pt-32">
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-subtle/60 px-3 py-1 text-xs text-fg-muted">
          <SparkleIcon size={14} /> Pre-alpha. Built for repos you actually own.
        </span>
        <h1 className="mt-6 text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
          One PR comment. Many specialists behind it.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-balance text-lg text-fg-muted">
          ClawReview fans your diff out to security, performance, style, and secrets agents in parallel,
          then merges the signal into one comment with file:line anchors and suggested patches.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={'/login' as any}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-fg px-5 text-sm font-medium text-bg transition-colors hover:bg-fg/90"
          >
            Install on GitHub <ArrowRightIcon size={16} />
          </Link>
          <Link
            href={'/docs' as any}
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-bg-subtle px-5 text-sm font-medium text-fg transition-colors hover:bg-bg-muted"
          >
            Read the docs
          </Link>
        </div>
        <p className="mt-3 text-xs text-fg-subtle">
          No card required. Self-host with the included Docker Compose stack.
        </p>
      </div>
    </section>
  );
}

const STEPS = [
  {
    icon: <GitPullRequestIcon />,
    title: 'A PR opens or updates',
    body: 'ClawReview verifies the webhook signature, queues the review, and fetches the diff.',
  },
  {
    icon: <ShieldIcon />,
    title: 'Specialists run in parallel',
    body: 'Security, performance, style, and secrets agents each scan their slice with a focused prompt.',
  },
  {
    icon: <CheckIcon />,
    title: 'One ranked comment lands',
    body: 'The aggregator dedupes findings, ranks by severity, and posts a check-run plus a single PR comment.',
  },
];

function HowItWorks() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
      <p className="mt-2 max-w-2xl text-fg-muted">
        Plug the GitHub App into a repo. The pipeline takes care of the rest in under a minute on a 500-line diff.
      </p>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <div
            key={s.title}
            className="group relative overflow-hidden rounded-2xl border border-border bg-bg-subtle/40 p-6 transition-colors hover:border-border-subtle"
          >
            <div className="absolute right-4 top-4 text-xs font-mono text-fg-subtle">{String(i + 1).padStart(2, '0')}</div>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg text-accent">
              {s.icon}
            </div>
            <h3 className="mt-4 text-base font-semibold">{s.title}</h3>
            <p className="mt-1 text-sm text-fg-muted">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const FEATURES = [
  { icon: <ShieldIcon />, title: 'Security specialist', body: 'CWE-tagged findings on auth, injection, deserialization, and secrets handling.' },
  { icon: <GaugeIcon />, title: 'Performance specialist', body: 'Flags N+1 queries, quadratic loops, blocking IO on request paths.' },
  { icon: <EyeIcon />, title: 'Style and readability', body: 'Catches confusing names, dead code, and unsafe casts without nit spam.' },
  { icon: <LockIcon />, title: 'Secret scanning', body: 'Regex pre-filter with LLM confirmation so you do not chase false positives.' },
  { icon: <SparkleIcon />, title: 'Per-repo config', body: 'A .clawreview.yml controls agents, threshold, models, ignored paths, and budget.' },
  { icon: <GitPullRequestIcon />, title: 'One comment, ranked', body: 'Aggregator merges duplicates and ranks by severity. No three-comment dogpile.' },
];

function Features() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <h2 className="text-3xl font-semibold tracking-tight">What ships in the box</h2>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-2xl border border-border bg-bg-subtle/40 p-5">
            <div className="text-accent">{f.icon}</div>
            <h3 className="mt-3 text-sm font-semibold">{f.title}</h3>
            <p className="mt-1 text-sm text-fg-muted">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SampleSection() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="grid gap-10 md:grid-cols-2 md:items-center">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">High-signal PR comments</h2>
          <p className="mt-3 text-fg-muted">
            Every finding has a severity, a category, the agent that produced it, a precise file:line anchor,
            and an optional suggested patch you can paste straight into your editor.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-fg-muted">
            <li className="flex items-center gap-2"><CheckIcon size={14} /> One comment per review, edited in place on new pushes.</li>
            <li className="flex items-center gap-2"><CheckIcon size={14} /> Check-run conclusion derived from the worst finding.</li>
            <li className="flex items-center gap-2"><CheckIcon size={14} /> Dismiss with a reason. It sticks across syncs.</li>
          </ul>
        </div>
        <SampleComment />
      </div>
    </section>
  );
}

const TIERS = [
  {
    name: 'Solo',
    price: 'Free',
    blurb: 'Up to 1 repo, 200 reviews/mo, community support.',
    features: ['All agents', 'Per-repo config', 'CLI dogfood mode'],
  },
  {
    name: 'Team',
    price: '$29/mo',
    blurb: 'Up to 25 repos, 2k reviews/mo, audit log retention.',
    features: ['Org RBAC', 'Cost guards', 'Email digest'],
  },
  {
    name: 'Enterprise',
    price: 'Talk to us',
    blurb: 'Unlimited repos, self-host, BYO LLM endpoints, SAML.',
    features: ['SOC 2 controls', 'Private deploy', 'Custom agents'],
  },
];

function Pricing() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <h2 className="text-3xl font-semibold tracking-tight">Pricing preview</h2>
      <p className="mt-2 max-w-2xl text-fg-muted">Subject to change before 0.1.0. Self-host is free forever.</p>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {TIERS.map((t) => (
          <div key={t.name} className="rounded-2xl border border-border bg-bg-subtle/40 p-6">
            <div className="text-sm font-medium text-fg-muted">{t.name}</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight">{t.price}</div>
            <p className="mt-2 text-sm text-fg-muted">{t.blurb}</p>
            <ul className="mt-4 space-y-2 text-sm">
              {t.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-fg">
                  <CheckIcon size={14} className="text-accent" /> {f}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
