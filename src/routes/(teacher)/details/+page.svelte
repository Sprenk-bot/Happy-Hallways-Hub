<script lang="ts">
  import { account, hubVisitStatus } from '#lib/account.svelte.ts';
  import Icon from '#lib/Icon.svelte';
  import { time } from '#lib/passes.ts';
  import { hubRuntime } from '#lib/hub-runtime.svelte.ts';
  import type { HubVisit } from '#lib/types.ts';

  let query = $state('');
  let statusFilter = $state('');
  let concernFilter = $state('');

  const statusLabels: Record<ReturnType<typeof hubVisitStatus>, string> = {
    'on-the-way': 'On the way to the Hub',
    'at-hub': 'At the Hub',
    'on-temporary-trip': 'On a Temporary Trip',
    'left-hub-awaiting-class': 'Left the Hub · return not confirmed',
    'returned-to-class': 'Returned to class',
    cancelled: 'Notification withdrawn',
    'did-not-arrive': 'Did not arrive',
  };

  const movements = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    return account.hubVisits
      .filter((visit) => !visit.arrivedBackAtClassAt && !visit.cancelledAt)
      .filter((visit) => !statusFilter || hubVisitStatus(visit) === statusFilter)
      .filter((visit) => !concernFilter || Boolean(visit.hasConcern) === (concernFilter === 'yes'))
      .filter((visit) => {
        if (!needle) return true;
        return [visit.studentName, visit.destinationLabel, visit.className, visit.periodName]
          .some((part) => part?.toLocaleLowerCase().includes(needle));
      })
      .sort((a, b) => (b.leftClassAt ?? b.arrivedAtHubAt ?? '').localeCompare(a.leftClassAt ?? a.arrivedAtHubAt ?? ''));
  });

  function started(visit: HubVisit) {
    return visit.leftClassAt ?? visit.arrivedAtHubAt ?? '';
  }
</script>

<div class="page wide">
  <header class="page-head">
    <div>
      <p class="eyebrow">Hub · current movements</p>
      <h1>Details</h1>
      <p class="muted">Students whose Hub visit or return to class is still unresolved.</p>
    </div>
    <a class="btn" href="/hub-history"><Icon name="history" size={16} />Hub History</a>
  </header>

  {#if !hubRuntime.hosted}
    <section class="card"><h2>Open this page through the Hub Host</h2><p class="muted">Hub visit records are available when you are signed in to the Hub Host.</p></section>
  {:else}
    <div class="filter-bar">
      <label class="search">Search students or places <input type="search" bind:value={query} placeholder="Name, destination, class" /></label>
      <label>Status
        <select bind:value={statusFilter} aria-label="Filter Hub movements by status">
          <option value="">All unresolved movements</option>
          {#each Object.entries(statusLabels) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <label>Concern
        <select bind:value={concernFilter} aria-label="Filter Hub movements by concern">
          <option value="">All</option><option value="yes">Concern recorded</option><option value="no">No concern recorded</option>
        </select>
      </label>
      <span class="count muted small">{movements.length} movements</span>
    </div>

    {#if movements.length}
      <div class="report-table">
        <table>
          <thead><tr><th>Student</th><th>Status</th><th>Destination</th><th>Started</th><th>Class / period</th><th>Concern</th></tr></thead>
          <tbody>
            {#each movements as visit (visit.id)}
              <tr>
                <td><a href={`/student-patterns/${visit.studentId}`}><strong>{visit.studentName}</strong></a>{#if visit.studentCategory}<span class="muted small">{visit.studentCategory.name}</span>{/if}</td>
                <td>{statusLabels[hubVisitStatus(visit)]}</td>
                <td>{visit.destinationLabel}</td>
                <td>{started(visit) ? time(started(visit)) : 'Time not recorded'}</td>
                <td>{visit.className ?? 'Direct Hub arrival'}{#if visit.periodName}<span class="muted small">{visit.periodName}</span>{/if}</td>
                <td>{visit.hasConcern ? 'Recorded' : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <section class="empty card"><h2>No unresolved Hub movements</h2><p>Completed or withdrawn visits remain available in Hub History.</p></section>
    {/if}
  {/if}
</div>

<style>
  .search { min-width: min(280px, 100%); }
  .search input { display: block; width: 100%; margin-top: 5px; }
  .filter-bar { align-items: end; }
  .filter-bar label { display: grid; gap: 5px; font-size: 13px; font-weight: 700; }
  .filter-bar select, .filter-bar input { min-height: 38px; }
  .report-table { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--paper); }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-size: 12px; }
  td strong, td .small { display: block; }
  tbody tr:last-child td { border-bottom: 0; }
</style>
