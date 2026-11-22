import { expect, test } from '@playwright/test';

/** Tips point out what's new on a page. They're closed as they appear, so they never cover what a test clicks next. */
test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.locator('.tip'), async (tip) => {
    await tip.getByRole('button', { name: /Skip|Got it/ }).click();
  });
});

async function newClass(page: import('@playwright/test').Page, name: string, roster: string) {
  await page.goto('/classes/new');
  await page.getByLabel('Class name').fill(name);
  await page.getByRole('button', { name: 'Create class' }).click();
  await page.getByLabel('One student per line').fill(roster);
  await page.getByRole('dialog').getByRole('button', { name: 'Add students' }).click();
}

test('the same student in two classes is one student on the Roster, with their full name kept here', async ({ page }) => {
  await newClass(page, 'Period 1', 'Maya Chen\nJordan Ellis');
  await expect(page.getByText(/2 students/)).toBeVisible();
  // The full name shows on the teacher's own roster, under the short one the kiosk shows.
  await expect(page.getByRole('row', { name: /Maya C\./ })).toContainText('Maya Chen');

  // A second class: Maya is recognised and offered as the same student; Sam is new.
  await newClass(page, 'Period 2', 'Maya Chen\nSam Patel');
  await expect(page.getByText('Is each one the same student?')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Maya Chen is the same student as Maya Chen · Period 1');
  await page.getByRole('dialog').getByRole('button', { name: 'Add students' }).click();
  await expect(page.getByText(/2 students/)).toBeVisible();

  await page.getByRole('link', { name: 'Roster', exact: true }).click();
  await expect(page.getByRole('row', { name: /Maya Chen/ })).toContainText('Period 1, Period 2');
  await expect(page.getByRole('row')).toHaveCount(5); // the heading row, Jordan, Maya, Sam and the totals
});

test("a student the teacher says isn't the same joins as a new student", async ({ page }) => {
  await newClass(page, 'Period 1', 'Maya Chen');
  await newClass(page, 'Period 2', 'Maya Chen');
  await page.getByRole('dialog').getByRole('checkbox').uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Add students' }).click();
  await page.getByRole('link', { name: 'Roster', exact: true }).click();
  await expect(page.getByRole('row', { name: /Maya Chen/ })).toHaveCount(2);
});

test('year groups can be managed, assigned, searched and filtered without changing pass data', async ({ page }) => {
  await newClass(page, 'Period 1', 'Maya Chen\nJordan Ellis');
  await page.getByRole('link', { name: 'Roster', exact: true }).click();

  await page.getByRole('button', { name: 'Manage year groups' }).click();
  await page.getByRole('textbox', { name: 'New year group' }).fill('Learning Support');
  await page.getByRole('button', { name: 'Add year group' }).click();
  const newCategoryRow = page.locator('.category-list li').last();
  const newCategoryName = newCategoryRow.locator('input').first();
  await newCategoryName.fill('Year 7 Support');
  await newCategoryName.press('Tab');
  await newCategoryRow.locator('select').selectOption('orange');
  await expect(newCategoryName).toHaveValue('Year 7 Support');
  await expect(page.getByRole('alert')).toHaveCount(0);

  const needsYou = page.getByRole('button', { name: /Needs you/ });
  if ((await needsYou.getAttribute('aria-expanded')) === 'true') await needsYou.click();
  await page.getByRole('button', { name: 'Edit Maya Chen' }).click();
  await page.getByLabel('Student year group').selectOption({ label: 'Year 7 Support' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: /Maya Chen/ })).toContainText('Year 7 Support');
  await expect(page.getByRole('button', { name: 'Remove Year 7 Support' })).toBeDisabled();

  await page.getByLabel('Filter by year group').selectOption({ label: 'Year 7 Support' });
  await expect(page.getByRole('row', { name: /Maya Chen/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Jordan Ellis/ })).toHaveCount(0);
  await expect(page.getByText('1 shown')).toBeVisible();

  await page.getByLabel('Filter by year group').selectOption('');
  await page.getByLabel('Search students').fill('Year 7 Support');
  await expect(page.getByRole('row', { name: /Maya Chen/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Jordan Ellis/ })).toHaveCount(0);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hallway.account.v2')!));
  expect(saved.version).toBe(4);
  expect(saved.roster.find((student: { firstName: string }) => student.firstName === 'Maya').categoryId).toBeTruthy();
  expect(saved.passes).toEqual([]);
});

test('merging students preserves Hub visits and categories, and undo restores ownership', async ({ page }) => {
  await page.goto('/privacy');
  await page.evaluate((at) => {
    localStorage.setItem('hallway.account.v2', JSON.stringify({
      version: 2,
      laptopPeerId: 'hallway-fictional',
      roster: [
        { id: 'maya', firstName: 'Maya', categoryId: 'year-7' },
        { id: 'sam', firstName: 'Sam', categoryId: 'year-9' },
      ],
      classes: [
        { id: 'p1', name: 'Period 1', createdAt: at, members: [{ studentId: 'maya', lastPrefix: 'C', status: 'current' }] },
        { id: 'p2', name: 'Period 2', createdAt: at, members: [{ studentId: 'sam', lastPrefix: 'S', status: 'current' }] },
      ],
      passes: [],
    }));
  }, new Date().toISOString());
  await page.goto('/settings');
  const result = await page.evaluate(async () => {
    const m = await import('/src/lib/account.svelte.ts');
    const visitId = m.startHubVisit({ studentId: 'sam', destinationId: m.account.destinations[0].id }, '2026-11-12T01:00:00.000Z');
    m.mergeStudents('maya', 'sam');
    const merged = m.account.roster.find((student) => student.id === 'maya')?.categoryId;
    const mergedVisit = m.account.hubVisits.find((visit) => visit.id === visitId);
    const mergedVisitSnapshot = mergedVisit && { studentId: mergedVisit.studentId, studentName: mergedVisit.studentName };
    const mergeId = m.account.merges?.at(-1)?.id;
    if (!mergeId) throw new Error('Merge record was not created.');
    m.undoMerge(mergeId);
    return {
      merged,
      mergedVisit: mergedVisitSnapshot,
      restoredVisit: m.account.hubVisits.find((visit) => visit.id === visitId)?.studentId,
      restored: m.account.roster.map((student) => ({ id: student.id, categoryId: student.categoryId })),
    };
  });
  expect(result.merged).toBe('year-7');
  expect(result.mergedVisit).toEqual({ studentId: 'maya', studentName: 'Sam' });
  expect(result.restoredVisit).toBe('sam');
  expect(result.restored).toEqual([
    { id: 'maya', categoryId: 'year-7' },
    { id: 'sam', categoryId: 'year-9' },
  ]);
});

test('an account from before the Roster keeps every student, and the teacher merges the same child once', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const at = new Date().toISOString();
    const pass = (id: string, classId: string, studentId: string) => ({
      id, classId, studentId, studentName: 'Maya C.', destination: 'Bathroom', minutes: 5, outAt: at, inAt: at, endedBy: 'student', updatedAt: at,
    });
    localStorage.setItem(
      'hallway.account.v2',
      JSON.stringify({
        version: 1,
        laptopPeerId: 'hallway-old',
        classes: [
          { id: 'p1', name: 'Period 1', createdAt: at, students: [{ id: 'maya-1', firstName: 'Maya', lastPrefix: 'C', status: 'current', pin: '1234' }] },
          { id: 'p2', name: 'Period 2', createdAt: at, students: [{ id: 'maya-2', firstName: 'Maya', lastPrefix: 'Ch', status: 'current', exempt: true }] },
        ],
        passes: [pass('a', 'p1', 'maya-1'), pass('b', 'p2', 'maya-2')],
        lineEnabled: false,
        line: [],
        requests: [],
        deniedRequests: [],
        pin: '2468',
        kiosk: null,
        activeClass: { id: 'p1', changedAt: at },
        replacedKiosks: [],
        networkBlocked: false,
        studentLink: null,
      }),
    );
  });
  await page.reload();

  // Nothing is lost: both students are still there, each in their own class.
  await expect(page.getByText('Some students may be the same student in two of your classes.')).toBeVisible();
  // A returning teacher first sees what's changed; close it.
  while (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'These may be the same student in two classes' })).toBeVisible();
  await page.getByRole('button', { name: 'Same student…' }).click();
  await page.getByRole('dialog', { name: 'Are these the same student?' }).getByRole('button', { name: 'Merge them' }).click();

  await expect(page.getByRole('heading', { name: 'These may be the same student in two classes' })).toBeHidden();
  const maya = page.getByRole('row', { name: /Maya/ });
  await expect(maya).toHaveCount(1);
  await expect(maya).toContainText('Period 1, Period 2');
  await expect(maya).toContainText('Exempt');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('hallway.account.v2')!));
  expect(saved.roster).toHaveLength(1);
  expect(saved.roster[0].pin).toBe('1234');
  expect(new Set(saved.passes.map((pass: { studentId: string }) => pass.studentId))).toEqual(new Set([saved.roster[0].id]));
});
