/**
 * Motion accessibility helpers.
 *
 * The CSS in globals.css already collapses every `animate-*` / `transition`
 * utility and CSS `scroll-behavior` under `@media (prefers-reduced-motion:
 * reduce)`. JavaScript-driven smooth scrolling (`scrollIntoView({ behavior:
 * 'smooth' })`) bypasses CSS entirely, so it must be gated explicitly -- that's
 * what these helpers are for.
 */

/** True when the OS asks for reduced motion. SSR-safe (returns false on the server). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The ScrollBehavior to use for a JS-driven scroll: `'auto'` (instant) when the
 * user prefers reduced motion, `'smooth'` otherwise. Use this instead of
 * hard-coding `behavior: 'smooth'`.
 */
export function motionScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
