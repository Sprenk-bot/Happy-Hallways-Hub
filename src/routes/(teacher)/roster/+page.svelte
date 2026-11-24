<script lang="ts">
  import { page } from '$app/state';
  import { replaceState } from '$app/navigation';
  import { account, addStudentCategory, classesOf, dismissMerge, dismissRosterMerge, findStudent, mergeStudents, removeStudentCategory, setStudentCategories, setStudentPins, undoMerge, updateStudentCategory } from '#lib/account.svelte.ts';
  import Modal from '#lib/Modal.svelte';
  import type { MergeSuggestion } from '#lib/merge.ts';
  import { shortDate } from '#lib/passes.ts';
  import EditStudentDialog from '#lib/EditStudentDialog.svelte';
  import Icon from '#lib/Icon.svelte';
  import { mergeSuggestions } from '#lib/merge.ts';
  import { minutesOut, startOfWeek } from '#lib/stats.ts';
  import { destinationColors, type DestinationColor } from '#lib/destinations.ts';
  import type { Student } from '#lib/types.ts';

  /**
   * The Roster: every student the teacher teaches, each once, with the classes
   * they're in, their PIN and how often they've gone this week across every
   * class. Full names stay on this computer. See docs/adr/0015 and 0017.
   */
  const suggestions = $derived(mergeSuggestions(account));
  /** The pair the teacher is checking before merging, and whose PIN to keep if they differ. */
  let confirming = $state<MergeSuggestion | null>(null);
  let pinFrom = $state('');
  const passCount = (studentId: string) => account.passes.filter((pass) => pass.studentId === studentId).length;
  const fullName = (student: { firstName: string; lastName?: string }) => (student.lastName ? `${student.firstName} ${student.lastName}` : null);
  const recentMerges = $derived([...(account.merges ?? [])].reverse().slice(0, 3));

  function confirmMerge(suggestion: MergeSuggestion) {
    confirming = suggestion;
    pinFrom = suggestion.keep.id;
  }

  function differentStudents() {
    for (const suggestion of suggestions) dismissMerge(suggestion.keep.id, suggestion.drop.id);
    dismissRosterMerge();
  }
  let showPins = $state(false);
  let showCategoryManager = $state(false);
  let search = $state('');
  let categoryFilter = $state('');
  let sortBy = $state<'name' | 'category'>('name');
  let newCategoryName = $state('');
  let newCategoryColor = $state<DestinationColor>('blue');
  let categoryError = $state('');
  let selectedStudentIds = $state<string[]>([]);
  let bulkCategoryId = $state('');
  const categoryColors = Object.keys(destinationColors) as DestinationColor[];
  const isCategoryColor = (value: string): value is DestinationColor =>
    categoryColors.some((color) => color === value);
  /** A class page links here with ?student=, to edit that student. */
  let editing = $state<Student | null>(findStudent(page.url.searchParams.get('student') ?? undefined) ?? null);

  function closeEditor() {
    editing = null;
    if (page.url.searchParams.has('student')) replaceState('/roster', {});
  }

  const shownPrefix = (studentId: string) =>
    account.classes.flatMap((cls) => cls.members).find((member) => member.studentId === studentId)?.lastPrefix ?? '';
  const nameOf = (student: { id: string; firstName: string; lastName?: string }) =>
    student.lastName ? `${student.firstName} ${student.lastName}` : `${student.firstName} ${shownPrefix(student.id)}${shownPrefix(student.id) ? '.' : ''}`;

  const rows = $derived.by(() => {
    const weekStart = startOfWeek().toISOString();
    const thisWeek = account.passes.filter((pass) => pass.outAt >= weekStart && pass.endedBy !== 'cancelled');
    return account.roster
      .map((student) => {
        const mine = thisWeek.filter((pass) => pass.studentId === student.id);
        const category = account.studentCategories.find((each) => each.id === student.categoryId);
        return { student, name: nameOf(student), classes: classesOf(student.id), category, week: mine.length, minutesWeek: minutesOut(mine) };
      })
      .sort((a, b) => {
        if (sortBy === 'category') {
          const aOrder = a.category ? account.studentCategories.indexOf(a.category) : Number.MAX_SAFE_INTEGER;
          const bOrder = b.category ? account.studentCategories.indexOf(b.category) : Number.MAX_SAFE_INTEGER;
          if (aOrder !== bOrder) return aOrder - bOrder;
        }
        return a.name.localeCompare(b.name);
      });
  });
  const visibleRows = $derived(rows.filter((row) => {
    if (categoryFilter === 'unassigned' && row.category) return false;
    if (categoryFilter && categoryFilter !== 'unassigned' && row.student.categoryId !== categoryFilter) return false;
    const query = search.trim().toLocaleLowerCase();
    return !query || [row.name, row.category?.name ?? '', ...row.classes].some((value) => value.toLocaleLowerCase().includes(query));
  }));
  const totals = $derived({
    week: visibleRows.reduce((sum, row) => sum + row.week, 0),
    minutesWeek: visibleRows.reduce((sum, row) => sum + row.minutesWeek, 0),
  });

  function addCategory() {
    categoryError = '';
    try {
      addStudentCategory(newCategoryName, newCategoryColor);
      newCategoryName = '';
    } catch (error) {
      categoryError = error instanceof Error ? error.message : 'The year group could not be added.';
    }
  }

  function renameCategory(id: string, input: HTMLInputElement) {
    const category = account.studentCategories.find((each) => each.id === id);
    if (!category) return;
    categoryError = '';
    try {
      updateStudentCategory(id, { name: input.value, color: category.color });
    } catch (error) {
      categoryError = error instanceof Error ? error.message : 'The year group could not be renamed.';
      input.value = category.name;
    }
  }

  function recolorCategory(id: string, color: string) {
    const category = account.studentCategories.find((each) => each.id === id);
    if (!category) return;
    if (!isCategoryColor(color)) {
      categoryError = 'Choose a listed colour.';
      return;
    }
    categoryError = '';
    updateStudentCategory(id, { name: category.name, color });
  }

  function deleteCategory(id: string) {
    categoryError = '';
    try {
      removeStudentCategory(id);
    } catch (error) {
      categoryError = error instanceof Error ? error.message : 'The year group could not be removed.';
    }
  }

  function assignSelected() {
    categoryError = '';
    try {
      setStudentCategories(selectedStudentIds, bulkCategoryId || null);
      selectedStudentIds = [];
    } catch (error) {
      categoryError = error instanceof Error ? error.message : 'The year groups could not be assigned.';
    }
  }

  function toggleStudent(studentId: string) {
    selectedStudentIds = selectedStudentIds.includes(studentId)
      ? selectedStudentIds.filter((id) => id !== studentId)
      : [...selectedStudentIds, studentId];
  }

  function toggleVisibleSelection() {
    const visibleIds = visibleRows.map((row) => row.student.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedStudentIds.includes(id));
    selectedStudentIds = allSelected
      ? selectedStudentIds.filter((id) => !visibleIds.includes(id))
      : [...new Set([...selectedStudentIds, ...visibleIds])];
  }
</script>

<svelte:head>
  <title>Roster · Happy Hallways</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <p class="eyebrow">Roster</p>
      <h1>Your students</h1>
      <p class="muted">
        Every student you teach, once, whichever classes they're in. A student in two of your classes shares one PIN, one
        Pass Allowance and one history. Full names stay on this computer; the kiosk only ever shows a first name and a few
        letters. That first name can be a nickname, the name students know them by.
      </p>
    </div>
    <button class="btn btn-small" aria-expanded={showCategoryManager} onclick={() => (showCategoryManager = !showCategoryManager)}>
      {showCategoryManager ? 'Close year groups' : 'Manage year groups'}
    </button>
  </header>

  {#if showCategoryManager}
    <section class="card category-manager" aria-labelledby="category-manager-title">
      <div>
        <h2 id="category-manager-title">Year groups</h2>
        <p class="muted small">Rename or recolour groups to fit your school. Existing students are unassigned until you choose a group.</p>
      </div>
      <form class="category-add" onsubmit={(event) => { event.preventDefault(); addCategory(); }}>
        <label class="field">New year group <input aria-label="New year group" bind:value={newCategoryName} /></label>
        <label class="field">Colour
          <select aria-label="New year group colour" bind:value={newCategoryColor}>
            {#each categoryColors as color (color)}
              <option value={color}>{color}</option>
            {/each}
          </select>
        </label>
        <button class="btn btn-primary btn-small" disabled={!newCategoryName.trim()}>Add year group</button>
      </form>
      {#if categoryError}<p class="form-error" role="alert">{categoryError}</p>{/if}
      <ul class="category-list">
        {#each account.studentCategories as category (category.id)}
          {@const assigned = account.roster.filter((student) => student.categoryId === category.id).length}
          <li>
            <label class="field">Name
              <input aria-label="Name for {category.name}" value={category.name} onchange={(event) => renameCategory(category.id, event.currentTarget)} />
            </label>
            <label class="field">Colour
              <select aria-label="Colour for {category.name}" value={category.color} onchange={(event) => recolorCategory(category.id, event.currentTarget.value)}>
                {#each categoryColors as color (color)}
                  <option value={color}>{color}</option>
                {/each}
              </select>
            </label>
            <span class="muted small">{assigned} {assigned === 1 ? 'student' : 'students'}</span>
            <button class="btn btn-small btn-quiet" aria-label="Remove {category.name}" disabled={assigned > 0} title={assigned ? 'Reassign students before removing this group.' : undefined} onclick={() => deleteCategory(category.id)}>Remove</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if suggestions.length}
    <section class="card" aria-labelledby="merge-title">
      <div>
        <p class="eyebrow">Same student?</p>
        <h2 id="merge-title">These may be the same student in two classes</h2>
        <p class="muted small">
          Before the Roster, a student in two of your classes was kept twice. Merge the ones that are the same child, and
          their passes come together. Leave the others as they are.
        </p>
      </div>
      <ul class="merges">
        {#each suggestions as suggestion (suggestion.keep.id + suggestion.drop.id)}
          <li>
            <span>
              <strong>{nameOf(suggestion.keep)}</strong> in {suggestion.keepClasses.join(', ') || 'no class now'}
              <span class="muted">and</span>
              <strong>{nameOf(suggestion.drop)}</strong> in {suggestion.dropClasses.join(', ') || 'no class now'}
            </span>
            <span class="row">
              <button class="btn btn-small btn-quiet" onclick={() => dismissMerge(suggestion.keep.id, suggestion.drop.id)}>Different students</button>
              <button class="btn btn-small btn-primary" onclick={() => confirmMerge(suggestion)}>
                <Icon name="check" size={14} />Same student…
              </button>
            </span>
          </li>
        {/each}
      </ul>
      {#if !account.rosterMergeSeen}
        <div><button class="btn btn-small" onclick={differentStudents}>The rest are different students</button></div>
      {/if}
    </section>
  {/if}

  {#if recentMerges.length}
    <section class="card" aria-labelledby="merged-title">
      <h2 id="merged-title">Merged students</h2>
      <ul class="merges">
        {#each recentMerges as merge (merge.id)}
          <li>
            <span>
              <strong>{nameOf(merge.drop)}</strong> <span class="muted">into</span> <strong>{nameOf(merge.keep)}</strong>
              <span class="muted small">· {shortDate(merge.at)}</span>
            </span>
            <button class="btn btn-small" onclick={() => undoMerge(merge.id)}><Icon name="history" size={14} />Undo</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="card" aria-labelledby="pins-title">
    <div class="option-row">
      <div>
        <h2 id="pins-title">Student PINs</h2>
        <p class="muted small">
          After tapping their name at the kiosk, each student types their own PIN, so nobody takes a pass as someone else. A
          student needs one to use their own device for passes, too. Each student has one PIN for all your
          classes. Happy Hallways makes them up; never use real student ID numbers.
        </p>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label="Students use PINs"
          checked={!!account.studentPins}
          onchange={(event) => setStudentPins(event.currentTarget.checked)}
        />
        <span aria-hidden="true"></span>
      </label>
    </div>
    {#if account.studentPins && rows.length}
      <div class="row">
        <button class="btn btn-small" onclick={() => (showPins = !showPins)}>
          <Icon name="key" size={14} />{showPins ? 'Hide PINs' : 'Show PINs'}
        </button>
        {#each account.classes as cls (cls.id)}
          <a class="btn btn-small btn-quiet" href="/classes/{cls.id}/pins"><Icon name="printer" size={14} />PIN cards: {cls.name}</a>
        {/each}
      </div>
    {/if}
  </section>

  <section class="card table-card">
    {#if rows.length}
      <!-- The card holds only the table, so the column headers sit right at its top. -->
      <div class="roster-filters">
        <label class="field">Search students
          <input aria-label="Search students" type="search" bind:value={search} placeholder="Name, class or year group" />
        </label>
        <label class="field">Filter by year group
          <select aria-label="Filter by year group" bind:value={categoryFilter}>
            <option value="">All year groups</option>
            {#each account.studentCategories as category (category.id)}
              <option value={category.id}>{category.name}</option>
            {/each}
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
        <label class="field">Sort by
          <select aria-label="Sort students by" bind:value={sortBy}>
            <option value="name">Name</option>
            <option value="category">Year group</option>
          </select>
        </label>
      </div>
      <div class="bulk-year-group">
        <label class="field">Assign selected students to
          <select aria-label="Bulk assign year group" bind:value={bulkCategoryId}>
            <option value="">Unassigned</option>
            {#each account.studentCategories as category (category.id)}<option value={category.id}>{category.name}</option>{/each}
          </select>
        </label>
        <button class="btn btn-small btn-primary" disabled={!selectedStudentIds.length} onclick={assignSelected}>Apply to {selectedStudentIds.length} selected</button>
        <button class="btn btn-small btn-quiet" disabled={!selectedStudentIds.length} onclick={() => (selectedStudentIds = [])}>Clear selection</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="Select all shown students" checked={visibleRows.length > 0 && visibleRows.every((row) => selectedStudentIds.includes(row.student.id))} onchange={toggleVisibleSelection} /></th><th>Student</th>
              <th>Year group</th>
              <th>Classes</th>
              {#if account.studentPins}<th>PIN</th>{/if}
              <th class="num">This week</th>
              <th class="num">Min. this week</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each visibleRows as row (row.student.id)}
              <tr>
                <td><input type="checkbox" aria-label="Select {row.name}" checked={selectedStudentIds.includes(row.student.id)} onchange={() => toggleStudent(row.student.id)} /></td>
                <td>
                  <strong>{row.name}</strong>
                  {#if row.student.alwaysGo}<span class="badge">Can always go</span>{:else if row.student.exempt}<span class="badge">Exempt</span>{/if}
                </td>
                <td>
                  {#if row.category}
                    <span class="category-badge" style:background={destinationColors[row.category.color].soft} style:color={destinationColors[row.category.color].strong}>{row.category.name}</span>
                  {:else}–{/if}
                </td>
                <td>{row.classes.join(', ') || '–'}</td>
                {#if account.studentPins}
                  <!-- Hidden until asked for, so a student glancing at the screen doesn't see a classmate's. -->
                  <td class="pin">{!row.student.pin ? '–' : showPins ? row.student.pin : '••••'}</td>
                {/if}
                <td class="num">{row.week}</td>
                <td class="num">{row.minutesWeek}</td>
                <td class="num">
                  <button class="btn btn-small btn-quiet" aria-label="Edit {row.name}" onclick={() => (editing = row.student)}>
                    <Icon name="pencil" size={14} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td colspan={account.studentPins ? 5 : 4}><strong>{visibleRows.length === rows.length ? 'All students' : `${visibleRows.length} shown`}</strong></td>
              <td class="num"><strong>{totals.week}</strong></td>
              <td class="num"><strong>{totals.minutesWeek}</strong></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    {:else}
      <p class="muted">No students yet. Add them to a class, and they appear here.</p>
    {/if}
    {#if rows.length > 0 && visibleRows.length === 0}<p class="muted">No students match these filters.</p>{/if}
  </section>
</div>

{#if confirming}
  {@const pair = confirming}
  {@const pinsDiffer = !!pair.keep.pin && !!pair.drop.pin && pair.keep.pin !== pair.drop.pin}
  <Modal onClose={() => (confirming = null)} labelledby="confirm-merge-title">
    <div class="dialog" style="width:min(560px,100%)">
      <h2 id="confirm-merge-title">Are these the same student?</h2>
      <p class="muted small">Merging can be undone from this page.</p>
      <div class="pair">
        {#each [{ student: pair.keep, classes: pair.keepClasses }, { student: pair.drop, classes: pair.dropClasses }] as side (side.student.id)}
          <div class="side">
            <strong>{nameOf(side.student)}</strong>
            {#if fullName(side.student)}<span>{fullName(side.student)}</span>{:else}<span class="muted small">Full name not known</span>{/if}
            <span class="muted small">{side.classes.join(', ') || 'No class now'}</span>
            <span class="muted small">PIN {side.student.pin ?? 'none'} · {passCount(side.student.id)} passes</span>
          </div>
        {/each}
      </div>
      {#if pinsDiffer}
        <fieldset class="pin-choice">
          <legend>They have different PINs. Which one should they keep?</legend>
          <label class="check"><input type="radio" bind:group={pinFrom} value={pair.keep.id} />{pair.keep.pin} ({pair.keepClasses.join(', ') || 'no class'})</label>
          <label class="check"><input type="radio" bind:group={pinFrom} value={pair.drop.id} />{pair.drop.pin} ({pair.dropClasses.join(', ') || 'no class'})</label>
        </fieldset>
      {/if}
      {#if pair.keep.alwaysGo || pair.drop.alwaysGo}
        <p class="muted small">The merged student can always go, since one of them could.</p>
      {:else if pair.keep.exempt || pair.drop.exempt}
        <p class="muted small">The merged student is exempt from the Pass Allowance, since one of them was.</p>
      {/if}
      <div class="dialog-actions">
        <button class="btn" onclick={() => (confirming = null)}>Cancel</button>
        <button
          class="btn btn-primary"
          onclick={() => {
            mergeStudents(pair.keep.id, pair.drop.id, pinFrom);
            confirming = null;
          }}>Merge them</button
        >
      </div>
    </div>
  </Modal>
{/if}

{#if editing}
  <EditStudentDialog student={editing} onClose={closeEditor} />
{/if}

<style>
  .bulk-year-group { display:flex; flex-wrap:wrap; align-items:end; gap:8px; padding:10px 0; }
  .bulk-year-group .field { min-width:220px; }

  tfoot td {
    border-top: 1px solid var(--border);
    background: var(--surface-sunk);
  }

  .option-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .pin {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: 0.1em;
  }

  .category-manager, .category-list, .roster-filters, .category-add {
    display: grid;
    gap: 12px;
  }

  .category-add, .roster-filters {
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    align-items: end;
  }

  .category-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .category-list li {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) minmax(120px, 180px) auto auto;
    align-items: end;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }

  .category-badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
  }

  .roster-filters {
    padding: 14px;
  }

  .merges {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .merges li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .side {
    display: grid;
    gap: 3px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .pin-choice {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .pin-choice legend {
    margin-bottom: 6px;
    font-size: 14px;
    font-weight: 700;
  }

  @media (max-width: 650px) {
    .category-list li {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
