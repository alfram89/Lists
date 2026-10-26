import { expect, test, type Page } from '@playwright/test';
import { MockRelay } from './mock-relay';

async function createList(page: Page, name: string, items: string[]) {
  await page.getByPlaceholder('New list, e.g. Groceries').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  for (const item of items) {
    await page.getByPlaceholder('Add an item').fill(item);
    await page.keyboard.press('Enter');
  }
}

async function shareLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share this space' }).click();
  const link = await page.locator('#share-link').inputValue();
  await page.getByRole('button', { name: 'Close' }).click();
  return link;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text()))
      errors.push(message.text());
  });
  return errors;
}

test('a local space makes no network connections', async ({ browser }) => {
  const relay = new MockRelay();
  const context = await browser.newContext();
  await relay.attach(context);
  const page = await context.newPage();
  const errors = collectErrors(page);

  await page.goto('/');
  await createList(page, 'Private', ['Secret item']);
  await page.getByRole('button', { name: 'Back to all lists' }).click();
  await page.waitForTimeout(1000);

  expect(relay.connections).toBe(0);
  await expect(page.getByRole('status')).toHaveText('Only on this device');
  expect(errors).toEqual([]);
  await context.close();
});

test('two devices share a list in real time over WebRTC', async ({ browser }) => {
  const relay = new MockRelay();
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  await relay.attach(aliceContext);
  await relay.attach(bobContext);
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const errors = [...collectErrors(alice), ...collectErrors(bob)];

  await alice.goto('/');
  await createList(alice, 'Groceries', ['Milk', 'Bread']);
  await alice.getByRole('button', { name: 'Back to all lists' }).click();

  const link = await shareLink(alice);
  expect(link).toMatch(/#v=1&s=[\w-]{22}&k=[\w-]{43}$/);
  await expect(alice.getByRole('status')).toHaveText('Shared · up to date');

  // Bob opens the link on another device.
  await bob.goto(link);
  await expect(bob.locator('.list-card')).toHaveText(/Groceries/);
  await expect(bob.getByRole('heading', { level: 1 })).toHaveText('Shared lists');
  expect(new URL(bob.url()).hash).toBe(''); // the key is removed from the address bar
  await expect(bob.getByRole('status')).toHaveText('Shared · up to date · 1 other device online');
  await expect(alice.getByRole('status')).toHaveText('Shared · up to date · 1 other device online');

  // Bob adds an item; Alice sees it.
  await bob.locator('.list-card').click();
  await expect(bob.locator('.text')).toHaveText(['Milk', 'Bread']);
  await bob.getByPlaceholder('Add an item').fill('Eggs');
  await bob.keyboard.press('Enter');

  await alice.locator('.list-card').click();
  await expect(alice.locator('.text')).toHaveText(['Milk', 'Bread', 'Eggs']);

  // Alice checks off Milk; Bob sees it move to Completed.
  await alice.getByText('Milk').click();
  await expect(bob.locator('#done-items .text')).toHaveText(['Milk']);

  // Bob goes offline and edits; changes merge when he reconnects.
  await bob.close();
  await alice.getByPlaceholder('Add an item').fill('Coffee');
  await alice.keyboard.press('Enter');
  const bobAgain = await bobContext.newPage();
  errors.push(...collectErrors(bobAgain));
  await bobAgain.goto('/');
  await bobAgain.locator('.list-card').click();
  await expect(bobAgain.locator('ul.items').first().locator('.text')).toHaveText([
    'Bread',
    'Eggs',
    'Coffee',
  ]);

  expect(errors).toEqual([]);
  await aliceContext.close();
  await bobContext.close();
});

test('tabs in the same browser stay in sync', async ({ browser }) => {
  const relay = new MockRelay();
  const context = await browser.newContext();
  await relay.attach(context);
  const tab1 = await context.newPage();
  await tab1.goto('/');
  await createList(tab1, 'Chores', ['Laundry']);
  await tab1.getByRole('button', { name: 'Back to all lists' }).click();
  await shareLink(tab1);

  const tab2 = await context.newPage();
  await tab2.goto('/');
  await tab2.locator('.list-card').click();
  await tab2.getByText('Laundry').click();

  await tab1.locator('.list-card').click();
  await expect(tab1.locator('#done-items .text')).toHaveText(['Laundry']);
  await context.close();
});

test('invalid links are rejected without side effects', async ({ page }) => {
  await page.goto('/#v=1&s=short&k=nope');
  await expect(page.getByRole('alert')).toHaveText(/not a valid share link/);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('status')).toHaveText('Only on this device');
});

test('reload keeps the open list, and leaving a space removes it', async ({ browser }) => {
  const relay = new MockRelay();
  const context = await browser.newContext();
  await relay.attach(context);
  const page = await context.newPage();
  await page.goto('/');
  await createList(page, 'Weekend', ['Hike']);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Weekend');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My lists');

  // Share it, create a second (local) space, then leave the shared one.
  await shareLink(page);
  await page.locator('.space-btn').click();
  await page.getByRole('button', { name: 'New space' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My lists');
  await expect(page.locator('.list-card')).toHaveCount(0);

  await page.locator('.space-btn').click();
  await page.getByRole('button', { name: /Shared lists/ }).click();
  await expect(page.locator('.list-card')).toHaveText(/Weekend/);

  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('.space-btn').click();
  await page.getByRole('button', { name: 'Leave this space' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My lists');
  await page.locator('.space-btn').click();
  await expect(page.locator('.space-option')).toHaveCount(1);
  await context.close();
});

test('changes reach someone who opens the link after the sender has left', async ({ browser }) => {
  const relay = new MockRelay();
  const aliceContext = await browser.newContext();
  await relay.attach(aliceContext);
  const alice = await aliceContext.newPage();
  const errors = collectErrors(alice);

  await alice.goto('/');
  const link = await shareLink(alice);
  await createList(alice, 'Groceries', ['Milk', 'Bread']);
  await alice.getByText('Bread').click();
  await alice.getByRole('button', { name: 'Back to all lists' }).click();
  await expect(alice.getByRole('status')).toHaveText('Shared · up to date');
  await aliceContext.close();

  // Nothing on the relay is readable: only ciphertext under a pseudonymous key.
  const mailbox = relay.events.filter((e) => e.kind === 30078);
  expect(mailbox.length).toBeGreaterThan(0);
  for (const event of mailbox) {
    expect(event.content).not.toMatch(/Milk|Bread|Groceries/);
    expect(atob(event.content)).not.toMatch(/Milk|Bread|Groceries/);
  }

  // Bob opens the link later, with Alice offline.
  const bobContext = await browser.newContext();
  await relay.attach(bobContext);
  const bob = await bobContext.newPage();
  errors.push(...collectErrors(bob));
  await bob.goto(link);
  await bob.locator('.list-card').click();
  await expect(bob.locator('ul.items').first().locator('.text')).toHaveText(['Milk']);
  await expect(bob.locator('#done-items .text')).toHaveText(['Bread']);

  // Bob's reply waits on the relay for Alice.
  await bob.getByPlaceholder('Add an item').fill('Eggs');
  await bob.keyboard.press('Enter');
  await bob.getByRole('button', { name: 'Back to all lists' }).click();
  await expect(bob.getByRole('status')).toHaveText('Shared · up to date');
  await bobContext.close();

  const aliceAgain = await browser.newContext();
  await relay.attach(aliceAgain);
  // A fresh context has no local data, so join through the link again.
  const page = await aliceAgain.newPage();
  await page.goto(link);
  await page.locator('.list-card').click();
  await expect(page.locator('ul.items').first().locator('.text')).toHaveText(['Milk', 'Eggs']);

  expect(errors).toEqual([]);
  await aliceAgain.close();
});
