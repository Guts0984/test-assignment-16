import { type Page, expect } from '@playwright/test';
import { PASSWORD } from './world';

/** Signs in through the real form (labels, keyboard) and waits for the role's home screen. */
export const signIn = async (page: Page, email: string, home: RegExp, password = PASSWORD): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(home);
};

/** A scanner is keyboard input ending with Enter. */
export const scanKeys = async (page: Page, value: string): Promise<void> => {
  const input = page.getByTestId('scan-input');
  await input.fill(value);
  await input.press('Enter');
};
