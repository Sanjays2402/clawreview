import { expect, test } from '@playwright/test';

test.use({
  extraHTTPHeaders: {
    cookie: 'clawreview-session=gh:1:test-user',
  },
});

test('app overview renders empty state when API is unset', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('reviews list renders header', async ({ page }) => {
  await page.goto('/app/reviews');
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
});

test('audit page renders empty state', async ({ page }) => {
  await page.goto('/app/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
});
