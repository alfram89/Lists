import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MockRelay } from './mock-relay';

async function createList(page: Page, name: string, items: string[]) {
  await page.getByPlaceholder('New list, e.g. Groceries').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  for (const item of items) {
    await page.getByPlaceholder('Add an item').fill(item);
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Back to all lists' }).click();
}

async function openSpaceMenu(page: Page) {
  await page.locator('.space-btn').click();
}

async function device(browser: import('@playwright/test').Browser, relay: MockRelay) {
  const context = await browser.newContext();
  await relay.attach(context);
  return { context, page: await context.newPage() };
}

test('a passphrase-protected link needs the right passphrase', async ({ browser }) => {
  const relay = new MockRelay();
  const alice = await device(browser, relay);
  await alice.page.goto('/');
  await createList(alice.page, 'Secret plans', ['Cake']);

  await alice.page.getByRole('button', { name: 'Share this space' }).click();
  await alice.page.getByRole('button', { name: 'Protect with a passphrase…' }).click();
  await alice.page.locator('#share-passphrase').fill('short');
  await expect(alice.page.getByRole('button', { name: 'Create protected link' })).toBeDisabled();
  await alice.page.locator('#share-passphrase').fill('purple elephant dances');
  await alice.page.getByRole('button', { name: 'Create protected link' }).click();
  await expect(alice.page.getByText('This link is protected.')).toBeVisible();
  const link = await alice.page.locator('#share-link').inputValue();
  expect(link).toMatch(/#v=1&s=[\w-]{22}&a=[\w-]+&w=[\w-]+$/);
  expect(link).not.toMatch(/[&#]k=/);
  await alice.page.getByRole('button', { name: 'Close' }).click();
  await expect(alice.page.getByRole('status')).toHaveText('Shared · up to date');

  const bob = await device(browser, relay);
  await bob.page.goto(link);
  expect(new URL(bob.page.url()).hash).toBe('');
  await bob.page.locator('#unlock-passphrase').fill('purple elephant');
  await bob.page.getByRole('button', { name: 'Open' }).click();
  await expect(bob.page.getByText('That passphrase is not right.')).toBeVisible();
  await bob.page.locator('#unlock-passphrase').fill('purple elephant dances');
  await bob.page.getByRole('button', { name: 'Open' }).click();
  await expect(bob.page.locator('.list-card')).toHaveText(/Secret plans/);

  await alice.context.close();
  await bob.context.close();
});

test('resetting the link cuts off the old link and others can rejoin', async ({ browser }) => {
  const relay = new MockRelay();
  const alice = await device(browser, relay);
  await alice.page.goto('/');
  await createList(alice.page, 'Groceries', ['Milk']);
  await alice.page.getByRole('button', { name: 'Share this space' }).click();
  const oldLink = await alice.page.locator('#share-link').inputValue();
  await alice.page.getByRole('button', { name: 'Close' }).click();

  const bob = await device(browser, relay);
  await bob.page.goto(oldLink);
  await expect(bob.page.locator('.list-card')).toHaveText(/Groceries/);

  // Alice resets the link.
  alice.page.on('dialog', (dialog) => dialog.accept());
  await openSpaceMenu(alice.page);
  await alice.page.getByRole('button', { name: 'Reset share link…' }).click();
  const newLink = await alice.page.locator('#share-link').inputValue();
  expect(newLink).not.toBe(oldLink);
  await alice.page.getByRole('button', { name: 'Close' }).click();

  // Bob, still on the old key, is told and stops syncing.
  await expect(bob.page.getByRole('status')).toHaveText('Shared · link was reset, not syncing');
  await expect(bob.page.getByText(/The share link for .* was reset/)).toBeVisible();

  // Alice keeps editing under the new key.
  await alice.page.locator('.list-card').click();
  await alice.page.getByPlaceholder('Add an item').fill('After reset');
  await alice.page.keyboard.press('Enter');
  await alice.page.getByRole('button', { name: 'Back to all lists' }).click();
  await expect(alice.page.getByRole('status')).toHaveText(/Shared · up to date/);

  // Someone who only has the old link gets nothing new.
  const eve = await device(browser, relay);
  await eve.page.goto(oldLink);
  await expect(eve.page.getByRole('status')).toHaveText('Shared · link was reset, not syncing');
  await expect(eve.page.locator('.list-card')).toHaveCount(0);

  // Bob gets the new link from Alice and accepts it.
  await bob.page.goto(newLink);
  await expect(bob.page.getByText(/has a new link/)).toBeVisible();
  await bob.page.getByRole('button', { name: 'Use the new link' }).click();
  await bob.page.locator('.list-card').click();
  await expect(bob.page.locator('.text')).toHaveText(['Milk', 'After reset']);

  await Promise.all(
    [alice.context, bob.context, eve.context].map((c: BrowserContext) => c.close()),
  );
});

test('export to a file and import it again', async ({ browser }) => {
  const relay = new MockRelay();
  const { context, page } = await device(browser, relay);
  await page.goto('/');
  await createList(page, 'Hardware', ['Screws', 'Glue']);
  await page.locator('.list-card').click();
  await page.getByText('Glue').click();
  await page.getByRole('button', { name: 'Back to all lists' }).click();

  await openSpaceMenu(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export to file' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^lists-my-lists-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();

  // Importing the file creates a new space with the same lists and check state
  // (the file's exact contents are covered by unit tests).
  await openSpaceMenu(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import from file…' }).click(),
  ]);
  await chooser.setFiles(path);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My lists');
  await openSpaceMenu(page);
  await expect(page.locator('.space-option')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.locator('.list-card').click();
  await expect(page.locator('#done-items .text')).toHaveText(['Glue']);

  // A file that is not an export is rejected with a message.
  await page.getByRole('button', { name: 'Back to all lists' }).click();
  await openSpaceMenu(page);
  const [badChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import from file…' }).click(),
  ]);
  await badChooser.setFiles('e2e/fixtures/not-an-export.json');
  await expect(page.getByRole('alert')).toHaveText(/not a Lists export file/);
  await context.close();
});
