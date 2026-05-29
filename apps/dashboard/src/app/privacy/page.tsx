import { TopNav } from '@/components/top-nav';
import { Footer } from '@/components/footer';

export default function PrivacyPage() {
  return (
    <main>
      <TopNav />
      <article className="mx-auto max-w-3xl px-6 py-16 text-fg">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-4 text-fg-muted">
          ClawReview stores diff content only for as long as a review is in flight. Findings are kept
          for 90 days by default. We never sell or share data with third parties. Self-hosted deployments
          keep all data inside your boundary.
        </p>
      </article>
      <Footer />
    </main>
  );
}
