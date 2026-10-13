import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PreviewGateway } from '../src/data/preview';

async function foodPreview(page: Page) {
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
  await page.goto('/#food');
  await page.getByRole('button', { name: 'Explore local preview' }).click();
  await expect(page.getByRole('heading', { name: 'Daily nutrition', exact: true })).toBeVisible();
}
async function goals(page: Page, calories: string, protein = '100') {
  await page.getByRole('button', { name: /^(Set|Edit) nutrition goals$/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Calorie goal (kcal)', { exact: true }).fill(calories);
  await dialog.getByLabel('Protein goal (g)', { exact: true }).fill(protein);
  await dialog.getByLabel('Carb goal (g)', { exact: true }).fill('250');
  await dialog.getByLabel('Fat goal (g)', { exact: true }).fill('60');
  await dialog.getByLabel('Fiber goal (g)', { exact: true }).fill('25');
  await dialog.getByRole('button', { name: 'Save nutrition goals' }).click();
  await expect(dialog).toBeHidden();
}
async function meal(page: Page, title: string, values: Record<string, string>) {
  await page.getByRole('button', { name: 'Add meal nutrition', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Brief description').fill(title);
  for (const [label, value] of Object.entries(values)) {
    if (
      /^(Fiber|Sugar|Sodium)/.test(label) &&
      !(await dialog.getByLabel(label, { exact: true }).isVisible())
    )
      await dialog.getByText('Fiber, sugar & sodium (optional)', { exact: true }).click();
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('nutrition goals and multiple meals persist; edits and deletes recalculate rings', async ({
  page,
}, info) => {
  await foodPreview(page);
  const calorie = page.getByRole('img', { name: /^Calories:/ });
  await expect(calorie).toHaveAttribute('aria-label', /not logged/);
  await goals(page, '2000');
  await meal(page, 'Sample macro lunch', {
    'Calories (kcal)': '650.5',
    'Protein (g)': '45',
    'Carbs (g)': '70',
    'Fat (g)': '20',
    'Fiber (g)': '8',
    'Sugar (g)': '4',
    'Sodium (mg)': '500',
  });
  await meal(page, 'Sample macro snack', {
    'Calories (kcal)': '200.25',
    'Protein (g)': '10',
    'Carbs (g)': '20',
    'Fat (g)': '5',
  });
  await expect(calorie).toHaveAttribute(
    'aria-label',
    /850.75 kcal logged.*Goal 2,000 kcal.*1,149.25 kcal remaining/,
  );
  await expect(page.getByRole('img', { name: /^Protein:/ })).toHaveAttribute(
    'aria-label',
    /55 g logged/,
  );
  await expect(page.getByRole('img', { name: /^Carbs:/ })).toHaveAttribute(
    'aria-label',
    /90 g logged/,
  );
  await expect(page.getByRole('img', { name: /^Fat:/ })).toHaveAttribute(
    'aria-label',
    /25 g logged/,
  );
  await expect(page.getByRole('img', { name: /^Fiber:/ })).toHaveAttribute(
    'aria-label',
    /8 g logged/,
  );
  const panel = page.locator('.nutrition-panel');
  await expect(panel.getByText('500 mg', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Partial totals:/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.screenshot({ path: `artifacts/${info.project.name}-nutrition.png` });
  await page.reload();
  await page.getByRole('button', { name: 'Explore local preview' }).click();
  await expect(calorie).toHaveAttribute('aria-label', /850.75 kcal logged/);
  await page.getByRole('button', { name: 'Edit Sample macro lunch', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Fiber (g)', { exact: true })).toHaveValue('8');
  await dialog.getByLabel('Calories (kcal)', { exact: true }).fill('600');
  await dialog.getByLabel('Protein (g)', { exact: true }).fill('40');
  await dialog.getByRole('button', { name: 'Save record', exact: true }).click();
  await expect(calorie).toHaveAttribute('aria-label', /800.25 kcal logged/);
  await page.getByRole('button', { name: 'Delete Sample macro snack', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Delete record', exact: true }).click();
  await expect(calorie).toHaveAttribute('aria-label', /600 kcal logged/);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('gym-progress-duo.preview.v1')!),
  );
  expect(
    saved.logs.find((log: { title: string }) => log.title === 'Sample macro lunch').nutrition
      .calories,
  ).toBe(600);
  expect(saved.logs.some((log: { title: string }) => log.title === 'Sample macro snack')).toBe(
    false,
  );
});

test('nutrition rings distinguish zero, cap over-goal visuals, and isolate partner and daily history', async ({
  page,
}) => {
  await foodPreview(page);
  await page.getByRole('button', { name: 'Set nutrition goals' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Calorie goal (kcal)', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Save nutrition goals' }).click();
  await expect(dialog.getByRole('alert')).toContainText('positive amount');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await goals(page, '100', '10');
  await meal(page, 'Zero amounts sample', { 'Calories (kcal)': '0', 'Protein (g)': '0' });
  const calorie = page.getByRole('img', { name: /^Calories:/ });
  await expect(calorie).toHaveAttribute('aria-label', /0 kcal logged.*100 kcal remaining/);
  await expect(page.getByRole('img', { name: /^Fat:/ })).toHaveAttribute(
    'aria-label',
    /not logged/,
  );
  await meal(page, 'Over goal sample', { 'Calories (kcal)': '150', 'Protein (g)': '20' });
  await expect(calorie).toHaveAttribute('aria-label', /150 kcal logged.*50 kcal over goal/);
  await expect(calorie.locator('.nutrition-dial-value')).toHaveAttribute('stroke-dashoffset', '0');
  await page.getByLabel('Nutrition date', { exact: true }).fill('2026-10-07');
  await expect(calorie).toHaveAttribute('aria-label', /not logged.*No goal set/);
  await expect(page.getByRole('button', { name: /^(Set|Edit) nutrition goals$/ })).toHaveCount(0);
  await page.getByLabel('Nutrition date', { exact: true }).fill('2026-10-08');
  await page
    .getByRole('combobox', { name: 'Nutrition member', exact: true })
    .selectOption('preview-partner');
  await expect(calorie).toHaveAttribute('aria-label', /not logged/);
  await expect(
    page.getByText('Your partner’s shared nutrition. Only they can edit their meals and goals.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Set|Edit) nutrition goals$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add meal nutrition', exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole('combobox', { name: 'Nutrition member', exact: true })
    .selectOption('preview-you');
  await expect(calorie).toHaveAttribute('aria-label', /150 kcal logged/);
  await page.getByRole('button', { name: 'Edit nutrition goals' }).click();
  for (const label of [
    'Calorie goal (kcal)',
    'Protein goal (g)',
    'Carb goal (g)',
    'Fat goal (g)',
    'Fiber goal (g)',
  ])
    await dialog.getByLabel(label, { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save nutrition goals' }).click();
  await expect(calorie).toHaveAttribute('aria-label', /150 kcal logged.*No goal set/);
});

test('older connected backends do not silently offer unsupported nutrition saving', async ({
  page,
}) => {
  const values = new Map<string, string>();
  const gateway = new PreviewGateway(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    () => new Date('2026-10-08T20:00:00Z'),
  );
  const fixture = await gateway.bootstrap();
  delete fixture.capabilities.nutritionTracking;
  await page.route('**/api/v1/bootstrap', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }),
  );
  await page.goto('/#food');
  await expect(
    page.getByRole('heading', { name: 'Nutrition tracking is not connected' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set nutrition goals' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Log a meal', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Calories (kcal)', { exact: true })).toHaveCount(
    0,
  );
});
