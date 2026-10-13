import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function preview(page: Page) {
  await page.clock.setFixedTime(new Date('2026-10-08T20:00:00Z'));
  await page.route('**/api/v1/bootstrap', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NOT_CONNECTED', message: 'Backend not connected.', retryable: true },
      }),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore local preview' }).click();
  await expect(page.getByRole('heading', { name: 'Your pace. Your progress.' })).toBeVisible();
}
async function navigate(page: Page, id: string) {
  const mobile = (page.viewportSize()?.width || 0) <= 720;
  const labels: Record<string, [string, string]> = {
    today: ['Today', 'Today'],
    workouts: ['Train', 'Workouts'],
    food: ['Food', 'Meals & water'],
    progress: ['Progress', 'My progress'],
    competition: ['Duo', 'The competition'],
    settings: ['Settings', 'Settings'],
  };
  await page
    .getByRole('navigation', { name: mobile ? 'Mobile navigation' : 'Main navigation' })
    .getByRole('button', { name: labels[id][mobile ? 0 : 1], exact: true })
    .click();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test('explicit preview, all six screens, stable mobile layout and screenshot', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await preview(page);
  await noOverflow(page);
  await page.screenshot({ path: `artifacts/${info.project.name}-today.png`, fullPage: true });
  for (const [id, title] of [
    ['workouts', 'Stronger, one session at a time.'],
    ['food', 'Nourish. Hydrate. Repeat.'],
    ['progress', 'See how far you’ve come.'],
    ['competition', 'In good company.'],
    ['settings', 'A shared commitment.'],
  ]) {
    await navigate(page, id);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await noOverflow(page);
  }
  await navigate(page, 'competition');
  await expect(page.locator('.leaderboard-card.is-me .avatar.large')).toHaveText('YOU');
  await page.screenshot({ path: `artifacts/${info.project.name}-competition.png`, fullPage: true });
  if ((page.viewportSize()?.width || 0) > 720) {
    await page.getByRole('button', { name: 'Return to Today' }).click();
    await expect(page.getByRole('heading', { name: 'Your pace. Your progress.' })).toBeVisible();
  }
  await navigate(page, 'progress');
  await page.screenshot({ path: `artifacts/${info.project.name}-progress.png`, fullPage: true });
  expect(errors).toEqual([]);
});

test('log, edit, persist, copy draft without points, and delete a workout', async ({ page }) => {
  await preview(page);
  await navigate(page, 'workouts');
  await page.getByRole('button', { name: 'Log workout', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Load 1', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('Title (optional)').fill('Browser test workout');
  await dialog.getByLabel('Exercise 1', { exact: true }).fill('Bench press');
  await dialog.getByLabel('Equipment 1', { exact: true }).fill('Barbell');
  await dialog.getByLabel('Repetitions 1', { exact: true }).fill('8');
  await dialog.getByRole('button', { name: 'Complete & save' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Saved in this browser’s local preview.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Browser test workout', { exact: true })).toBeVisible();
  const before = await page.evaluate(
    () => JSON.parse(localStorage.getItem('gym-progress-duo.preview.v1')!).logs.length,
  );
  await page.getByRole('button', { name: 'Copy Browser test workout as draft' }).click();
  await expect(
    page.getByText('Editable draft. No points are counted until you complete and save.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('gym-progress-duo.preview.v1')!).logs.length,
    ),
  ).toBe(before);
  await page.getByRole('button', { name: 'Edit Browser test workout', exact: true }).click();
  await dialog.getByLabel('Title (optional)').fill('Edited browser workout');
  await dialog.getByRole('button', { name: 'Complete & save' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Explore local preview' }).click();
  await expect(page.getByText('Edited browser workout', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Edited browser workout', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete record', exact: true })
    .click();
  await expect(page.getByText('Edited browser workout', { exact: true })).toBeHidden();
});

test('common exercises add editable variants and repeated sets using preferred units', async ({
  page,
}, info) => {
  await preview(page);
  await navigate(page, 'workouts');
  await page.getByRole('button', { name: 'Log workout', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Load unit 1', { exact: true })).toHaveValue('lb');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await navigate(page, 'settings');
  await page.getByRole('combobox', { name: 'Weight', exact: true }).selectOption('kg');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(
    page.getByText('Saved in this browser’s local preview.', { exact: true }),
  ).toBeVisible();
  await navigate(page, 'workouts');
  await page.getByRole('button', { name: 'Log workout', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'Common exercises' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await dialog.screenshot({ path: `artifacts/${info.project.name}-exercise-picker.png` });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByLabel('Title (optional)').fill('Quick exercise workout');
  await dialog.getByLabel('Repetitions 1', { exact: true }).fill('9');
  await dialog.getByRole('searchbox', { name: 'Search common exercises' }).fill('BENCH barbell');
  const results = dialog.getByRole('region', { name: 'Common exercise results' });
  await expect(results.getByRole('button')).toHaveCount(1);
  await results.getByRole('button', { name: 'Bench press Barbell · flat', exact: true }).click();
  await expect(dialog.getByLabel('Exercise 1', { exact: true })).toHaveValue('Bench press');
  await expect(dialog.getByLabel('Equipment 1', { exact: true })).toHaveValue('Barbell · flat');
  await expect(dialog.getByLabel('Repetitions 1', { exact: true })).toHaveValue('9');
  await expect(dialog.getByLabel('Load unit 1', { exact: true })).toHaveValue('kg');
  await dialog.getByLabel('Equipment 1', { exact: true }).fill('Barbell · flat · narrow grip');
  await dialog.getByRole('searchbox', { name: 'Search common exercises' }).fill('squats');
  await results.getByRole('button', { name: 'Squat Barbell · back', exact: true }).click();
  await expect(dialog.getByLabel('Exercise 2', { exact: true })).toHaveValue('Squat');
  await expect(dialog.getByLabel('Equipment 2', { exact: true })).toHaveValue('Barbell · back');
  await expect(dialog.getByLabel('Load unit 2', { exact: true })).toHaveValue('kg');
  await dialog.getByLabel('Repetitions 2', { exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Add a set', exact: true }).click();
  await expect(dialog.getByLabel('Exercise 3', { exact: true })).toHaveValue('Squat');
  await expect(dialog.getByLabel('Equipment 3', { exact: true })).toHaveValue('Barbell · back');
  await expect(dialog.getByLabel('Repetitions 3', { exact: true })).toHaveValue('5');
  await expect(dialog.getByLabel('Load unit 3', { exact: true })).toHaveValue('kg');
  await dialog.getByRole('button', { name: 'Complete & save' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.getByRole('button', { name: 'Explore local preview' }).click();
  await expect(page.getByText('Quick exercise workout', { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('gym-progress-duo.preview.v1')!);
    return state.logs.find((log: { title: string }) => log.title === 'Quick exercise workout');
  });
  expect(saved.completed).toBe(true);
  expect(saved.sets).toEqual([
    {
      exercise: 'Bench press',
      equipment: 'Barbell · flat · narrow grip',
      repetitions: 9,
      load: 0,
      unit: 'kg',
    },
    { exercise: 'Squat', equipment: 'Barbell · back', repetitions: 5, load: 0, unit: 'kg' },
    { exercise: 'Squat', equipment: 'Barbell · back', repetitions: 5, load: 0, unit: 'kg' },
  ]);
});

test('exercise filters and keyboard tabs preserve custom and copied drafts without saving', async ({
  page,
}) => {
  await preview(page);
  await navigate(page, 'workouts');
  const before = await page.evaluate(() => localStorage.getItem('gym-progress-duo.preview.v1'));
  await page.getByRole('button', { name: 'Log workout', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const commonTab = dialog.getByRole('tab', { name: 'Common exercises' });
  const customTab = dialog.getByRole('tab', { name: 'Custom entry' });
  await commonTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(customTab).toBeFocused();
  await expect(customTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(commonTab).toBeFocused();
  await expect(commonTab).toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: 'Lower body', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Lower body', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const results = dialog.getByRole('region', { name: 'Common exercise results' });
  await expect(
    results.getByRole('button', { name: 'Squat Barbell · back', exact: true }),
  ).toBeVisible();
  await expect(results.getByRole('button', { name: /Bench press/i })).toHaveCount(0);
  const search = dialog.getByRole('searchbox', { name: 'Search common exercises' });
  await search.fill('not-a-listed-exercise');
  await expect(dialog.getByText('No matching exercises.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Enter your own exercise' }).click();
  await expect(customTab).toHaveAttribute('aria-selected', 'true');
  await dialog.getByLabel('Exercise 1', { exact: true }).fill('Single arm press');
  await dialog.getByLabel('Equipment 1', { exact: true }).fill('Cable · kneeling');
  await dialog.getByLabel('Repetitions 1', { exact: true }).fill('12');
  await dialog.getByLabel('Load unit 1', { exact: true }).selectOption('kg');
  await commonTab.click();
  await dialog.getByRole('button', { name: 'All', exact: true }).click();
  await search.fill('bench barbell');
  await search.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('gym-progress-duo.preview.v1'))).toBe(
    before,
  );
  await results.getByRole('button', { name: 'Bench press Barbell · flat', exact: true }).click();
  await expect(dialog.getByLabel('Exercise 1', { exact: true })).toHaveValue('Single arm press');
  await expect(dialog.getByLabel('Equipment 1', { exact: true })).toHaveValue('Cable · kneeling');
  await expect(dialog.getByLabel('Repetitions 1', { exact: true })).toHaveValue('12');
  await expect(dialog.getByLabel('Load unit 1', { exact: true })).toHaveValue('kg');
  await expect(dialog.getByLabel('Exercise 2', { exact: true })).toHaveValue('Bench press');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  expect(await page.evaluate(() => localStorage.getItem('gym-progress-duo.preview.v1'))).toBe(
    before,
  );
  await page
    .getByRole('button', { name: /^Copy .+ as draft$/ })
    .first()
    .click();
  await expect(customTab).toHaveAttribute('aria-selected', 'true');
  const copied = await dialog
    .locator('.set-card')
    .evaluateAll((cards) =>
      cards.map((card) =>
        Array.from(
          card.querySelectorAll('input, select'),
          (field) => (field as HTMLInputElement | HTMLSelectElement).value,
        ),
      ),
    );
  await commonTab.click();
  await results.getByRole('button', { name: 'Squat Barbell · back', exact: true }).click();
  await expect(dialog.locator('.set-card')).toHaveCount(copied.length + 1);
  const afterAdding = await dialog
    .locator('.set-card')
    .evaluateAll((cards) =>
      cards.map((card) =>
        Array.from(
          card.querySelectorAll('input, select'),
          (field) => (field as HTMLInputElement | HTMLSelectElement).value,
        ),
      ),
    );
  expect(afterAdding.slice(0, copied.length)).toEqual(copied);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  expect(await page.evaluate(() => localStorage.getItem('gym-progress-duo.preview.v1'))).toBe(
    before,
  );
});

test('daily hydration replaces a total; meals without secure photos are unscored', async ({
  page,
}) => {
  await preview(page);
  await navigate(page, 'food');
  await page.getByRole('button', { name: 'Update daily water' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Daily total', { exact: true }).fill('2300');
  await dialog.getByRole('button', { name: 'Save record' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/2300 ml total/)).toBeVisible();
  await page.getByRole('button', { name: 'Log a meal', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Choose existing image')).toBeDisabled();
  await dialog.getByLabel('Brief description').fill('Unscored preview meal');
  await dialog.getByLabel('Includes a protein source').check();
  await dialog.getByLabel('Includes a fruit, vegetable, or other fiber-rich food').check();
  await dialog.getByRole('button', { name: 'Save record' }).click();
  await expect(dialog).toBeHidden();
  const record = page
    .locator('article')
    .filter({ has: page.getByText('Unscored preview meal', { exact: true }) });
  await expect(record.getByText('Not scored', { exact: true })).toBeVisible();
});

test('body sharing toggles per record, target proposals stay pending, filters preserve all-time totals', async ({
  page,
}) => {
  await preview(page);
  await navigate(page, 'progress');
  await page.getByRole('button', { name: 'Body records', exact: true }).click();
  await expect(page.getByText('Hidden partner body record')).toBeHidden();
  await page.getByRole('button', { name: 'Only me · share record' }).click();
  await page.getByRole('button', { name: 'Shared with partner · revoke' }).click();
  await expect(page.getByRole('button', { name: 'Only me · share record' })).toBeVisible();
  await navigate(page, 'settings');
  await page.getByLabel('Strength days / week').fill('4');
  await page.getByRole('button', { name: 'Propose for next week' }).click();
  await expect(page.getByText(/1\/2 approvals/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Waiting for partner' })).toBeDisabled();
  await navigate(page, 'competition');
  const totals = await page.locator('.leaderboard-total').allTextContents();
  await page.getByRole('combobox', { name: 'Week', exact: true }).selectOption({ index: 1 });
  expect(await page.locator('.leaderboard-total').allTextContents()).toEqual(totals);
  await page.getByRole('button', { name: 'The rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A fair kind of competition.' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('own export downloads and profile preferences persist', async ({ page }) => {
  await preview(page);
  await navigate(page, 'settings');
  await page.getByLabel('Display name', { exact: true }).fill('Sample athlete');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(
    page.getByText('Saved in this browser’s local preview.', { exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my logs' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('duo-preview-export-2026-10-08.json');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.profile.displayName).toBe('Sample athlete');
  expect(exported.logs.every((l: { ownerId: string }) => l.ownerId === 'preview-you')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Explore local preview' }).click();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Sample athlete');
});
