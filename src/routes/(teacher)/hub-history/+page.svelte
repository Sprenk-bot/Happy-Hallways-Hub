<script lang="ts">
  import { account, staffStudentName } from '#lib/account.svelte.ts';
  import { download } from '#lib/csv.ts';
  import Icon from '#lib/Icon.svelte';
  import { dayKey, time } from '#lib/passes.ts';
  import { hubRuntime } from '#lib/hub-runtime.svelte.ts';
  import { hubMovementRows, hubVisitSummaryRowsToCsv } from '#lib/hub-reporting.ts';

  let query = $state('');
  let from = $state('');
  let to = $state('');
  let concernFilter = $state('');
  let newestFirst = $state(true);

  const allRows = $derived(hubMovementRows(account.hubVisits));
  const rows = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    return allRows
      .filter((row) => {
        const day = dayKey(row.occurredAt);
        return (!from || day >= from) && (!to || day <= to);
      })
      .filter((row) => !concernFilter || row.concern === (concernFilter === 'yes'))
      .filter((row) => !needle || [row.studentName, row.yearGroup, row.event, row.destination, row.className, row.periodName, row.staff, row.detail]
        .some((part) => part.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => newestFirst
        ? b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)
        : a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  });

  function exportCsv() {
    const visitIds = new Set(rows.map((row) => row.visitId));
    const visits = account.hubVisits.filter((visit) => visitIds.has(visit.id));
    download(`Hub visit summary ${dayKey(new Date())}.csv`, hubVisitSummaryRowsToCsv(visits, staffStudentName), 'text/csv');
  }
</script>

<div class="page wide">
  <header class="page-head">
    <div>
      <p class="eyebrow">Hub · records</p>
      <h1>Hub History</h1>
      <p class="muted">A timeline of Hub arrivals, departures, temporary trips, check-ins, and class returns.</p>
    </div>
    <button class="btn" onclick={exportCsv} disabled={!rows.length}><Icon name="download" size={16} />Download visit summary CSV</button>
  </header>

  {#if !hubRuntime.hosted}
    <section class="card"><h2>Open this page through the Hub Host</h2><p class="muted">Hub visit records are available when you are signed in to the Hub Host.</p></section>
  {:else}
    <div class="filter-bar">
      <label class="search">Search records <input type="search" bind:value={query} placeholder="Student, class, event" /></label>
      <label>From <input type="date" bind:value={from} /></label>
      <label>To <input type="date" bind:value={to} /></label>
      <label>Concern
        <select bind:value={concernFilter} aria-label="Filter Hub history by concern">
          <option value="">All records</option><option value="yes">Concern recorded</option><option value="no">No concern recorded</option>
        </select>
      </label>
      <span class="count muted small">{rows.length} of {allRows.length}</span>
    </div>

    {#if rows.length}
      <p class="notice-text">This report contains student movement and check-in information. Store downloaded files only in school-approved locations. Private concern notes are kept in the Mail Centre and are not included here.</p>
      <div class="report-table">
        <table>
          <thead>
            <tr>
              <th aria-sort={newestFirst ? 'descending' : 'ascending'}><button class="sort" onclick={() => (newestFirst = !newestFirst)}>When <Icon name={newestFirst ? 'arrow-down' : 'arrow-up'} size={13} /></button></th>
              <th>Student</th><th>Event</th><th>Destination</th><th>Class / period</th><th>Staff member</th><th>Concern</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <tr>
                <td>{dayKey(row.occurredAt)}<span class="muted small">{time(row.occurredAt)}</span></td>
                <td><strong>{staffStudentName(row.studentId, row.studentName)}</strong>{#if row.yearGroup}<span class="muted small">{row.yearGroup}</span>{/if}</td>
                <td>{row.event}{#if row.detail}<span class="muted small detail">{row.detail}</span>{/if}</td>
                <td>{row.destination}</td>
                <td>{row.className || 'Direct Hub arrival'}{#if row.periodName}<span class="muted small">{row.periodName}</span>{/if}</td>
                <td>{row.staff || '—'}</td>
                <td>{row.concern ? 'Recorded' : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <section class="empty card"><h2>No Hub events match these filters</h2><p>Clear the filters or check back after a Hub visit has been recorded.</p></section>
    {/if}
  {/if}
</div>

<style>
  .search { min-width: min(250px, 100%); }
  .search input { display: block; width: 100%; margin-top: 5px; }
  .filter-bar { align-items: end; }
  .filter-bar label { display: grid; gap: 5px; font-size: 13px; font-weight: 700; }
  .filter-bar input, .filter-bar select { min-height: 38px; }
  .report-table { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--paper); }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 11px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-size: 12px; white-space: nowrap; }
  td .small { display: block; max-width: 340px; }
  .detail { white-space: pre-wrap; }
  tbody tr:last-child td { border-bottom: 0; }
  .sort { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
</style>
