<script lang="ts">
  import { page } from '$app/state';
  import { account, findStudent } from '#lib/account.svelte.ts';
  import { hubStudentAnalytics } from '#lib/hub-analytics.ts';
  import { hubRuntime } from '#lib/hub-runtime.svelte.ts';
  import { hubVisitRowsForStudent } from '#lib/hub-reporting.ts';

  let range = $state<'7' | '30' | 'all'>('30');
  const student = $derived(findStudent(page.params.id ?? ''));
  const since = $derived(range === 'all' ? undefined : new Date(Date.now() - Number(range) * 86_400_000).toISOString());
  const analytics = $derived(hubStudentAnalytics(account.hubVisits, student?.id ?? '', since));
  const events = $derived(hubVisitRowsForStudent(account.hubVisits, student?.id ?? '', since));
  const minutes = (value: number | null) => value === null ? 'Not enough recorded timestamps' : `${Math.round(value)} minutes`;
</script>

<div class="page wide">
  <header class="page-head"><div><p class="eyebrow">Hub · student records</p><h1>{student ? `${student.firstName} ${student.lastName}` : 'Student not found'}</h1><p class="muted">Recorded visits and check-in patterns. These records do not explain why a student visited or diagnose a condition.</p></div><label>Time period <select bind:value={range}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All available history</option></select></label></header>
  {#if hubRuntime.hosted && hubRuntime.session?.role !== 'tic'}
    <section class="card"><h2>TIC access required</h2><p class="muted">Student statistics are restricted to the Teacher in Charge.</p></section>
  {:else if student}
    <section class="stats-grid"><article class="card"><span class="muted">Hub visits</span><strong>{analytics.visitCount}</strong></article><article class="card"><span class="muted">Check-in answers</span><strong>{analytics.checkInCount}</strong></article><article class="card"><span class="muted">Average recorded Hub time</span><strong>{minutes(analytics.averageVisitMinutes)}</strong><small class="muted">{analytics.averageVisitMinutes === null ? '' : 'Based on visits with both arrival and departure times.'}</small></article></section>
    <section class="card"><h2>Ratings</h2>{#if analytics.ratings.length}<div class="report-table"><table><thead><tr><th>Question</th><th>Stage</th><th>Scale</th><th>Responses</th><th>Mean</th><th>Median</th><th>Counts by rating</th></tr></thead><tbody>{#each analytics.ratings as rating (`${rating.question}-${rating.stage}-${rating.promptVersion}`)}<tr><td>{rating.question}<span class="muted small">Prompt version {rating.promptVersion}</span></td><td>{rating.stage === 'arrival' ? 'Arrival' : 'Departure'}</td><td>1–{rating.scaleMax}</td><td>{rating.count}</td><td>{rating.mean.toFixed(1)} / {rating.scaleMax}</td><td>{rating.median}</td><td>{rating.distribution.join(' · ')}</td></tr>{/each}</tbody></table></div>{:else}<p class="muted">No visual rating responses are recorded for this period. Written responses are kept in Hub History.</p>{/if}</section>
    <section class="card"><h2>Visits by day</h2>{#if analytics.dailyVisits.length}<ul class="daily">{#each analytics.dailyVisits as day (day.day)}<li><time>{day.day}</time><span>{day.visits} {day.visits === 1 ? 'visit' : 'visits'}</span></li>{/each}</ul>{:else}<p class="muted">No visits are recorded for this period.</p>{/if}</section>
    <section class="card"><h2>Recorded check-ins</h2>{#if events.length}<div class="report-table"><table><thead><tr><th>When</th><th>Question</th><th>Response</th><th>Destination</th></tr></thead><tbody>{#each events as event (event.id)}<tr><td>{event.when}</td><td>{event.question}</td><td>{event.answer}</td><td>{event.destination}</td></tr>{/each}</tbody></table></div>{:else}<p class="muted">No check-ins are recorded for this period.</p>{/if}</section>
  {/if}
</div>

<style>
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 18px 0; }
  .stats-grid article { display: grid; gap: 7px; }
  .stats-grid strong { font-size: 1.5rem; }
  .report-table { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .small { display: block; }
  .daily { list-style: none; margin: 0; padding: 0; }
  .daily li { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
</style>
