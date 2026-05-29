import { expect, test } from '@playwright/test';

test('landing page renders hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('One PR comment. Many specialists behind it.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Install on GitHub/i })).toBeVisible();
});

test('docs page renders quick start snippet', async ({ page }) => {
  await page.goto('/docs');
  await expect(page.getByText('Quick start')).toBeVisible();
  await expect(page.getByText('pnpm cli -- run')).toBeVisible();
});

test('login page exposes GitHub continue', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByText('Continue with GitHub')).toBeVisible();
});
