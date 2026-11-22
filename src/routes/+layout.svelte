<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import '../app.css';
  import { exportAccount, isHubHostEdition, unreadable } from '#lib/account.svelte.ts';
  import { startAnalytics } from '#lib/analytics.ts';
  import { download } from '#lib/csv.ts';
  import { hasUnsavedHubChanges, hubRuntime, reloadFromHost, startHubRuntime } from '#lib/hub-runtime.svelte.ts';
  import UnreadableData from '#lib/UnreadableData.svelte';

  let { children } = $props();

  const hubAdminPage = $derived(page.url.pathname === '/hub-admin');
  const hubKioskPage = $derived(page.url.pathname === '/hub-kiosk');

  onMount(() => {
    if (isHubHostEdition()) {
      if (!hubKioskPage) void startHubRuntime();
    }
    else startAnalytics();
  });

  function retryHost() {
    void startHubRuntime();
  }

  function downloadUnsavedCopy() {
    download(
      `happy-hallways-unsaved-${new Date().toISOString().slice(0, 10)}.json`,
      exportAccount(),
      'application/json',
    );
  }

  async function returnToHostCopy() {
    if (!confirm('This will replace the unsaved changes in this tab with the current Host copy. Download them first if you may need them. Continue?')) return;
    await reloadFromHost();
  }

  function protectPendingChanges(event: BeforeUnloadEvent) {
    if (!hasUnsavedHubChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  }
</script>

<svelte:window onbeforeunload={protectPendingChanges} />

{#if hubRuntime.hosted && !hubAdminPage && !hubKioskPage && hubRuntime.status !== 'ready'}
  <main class="hub-gate" aria-live="polite">
    <h1>Happy Hallways Hub</h1>
    {#if hubRuntime.status === 'checking'}
      <p>Checking your staff sign-in and the Hub Host account…</p>
    {:else if hubRuntime.status === 'signed-out'}
      {#if hasUnsavedHubChanges()}<p>Some changes in this tab were not acknowledged by the Host. Download them before signing in again so you can recover them if needed.</p><button class="btn" onclick={downloadUnsavedCopy}>Download unsaved changes</button>{:else}<p>Sign in with your authorised staff account before opening Hub records.</p>{/if}
      <a class="btn btn-primary" href="/hub-admin">Continue to staff sign-in</a>
    {:else if hubRuntime.status === 'no-data'}
      <p>The Host has no shared account yet. A TIC can initialise it from an existing browser account after downloading a backup.</p>
      <a class="btn btn-primary" href="/hub-admin">Open Host setup</a>
    {:else if hubRuntime.status === 'conflict'}
      <p>{hubRuntime.message}</p>
      {#if hubRuntime.conflictPaths.length}<p class="small">Conflicting fields: {hubRuntime.conflictPaths.join(', ')}</p>{/if}
      <div class="actions">
        <button class="btn" onclick={downloadUnsavedCopy}>Download my unsaved copy</button>
        <button class="btn btn-primary" onclick={returnToHostCopy}>Load Host copy</button>
      </div>
    {:else if hubRuntime.status === 'offline'}
      <p>The Hub Host cannot be reached. This screen is paused and browser storage has not been updated.</p>
      {#if hasUnsavedHubChanges()}<button class="btn" onclick={downloadUnsavedCopy}>Download unsaved changes</button>{/if}
      <button class="btn btn-primary" onclick={retryHost}>Try again</button>
    {:else}
      <p>{hubRuntime.message || 'The Hub Host could not open this account.'}</p>
      <a class="btn" href="/hub-admin">Open Host access and recovery</a>
    {/if}
    {#if hubRuntime.session}<p class="small">Signed in as {hubRuntime.session.displayName} ({hubRuntime.session.role.toUpperCase()}).</p>{/if}
    {#if hubRuntime.saveStatus === 'saving' || hasUnsavedHubChanges()}<p class="small">Changes are waiting for Host acknowledgement.</p>{/if}
  </main>
{:else if unreadable.raw !== null}
  <UnreadableData />
{:else}
  {@render children()}
{/if}

<style>
  .hub-gate {
    box-sizing: border-box;
    min-height: 100vh;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 14px;
    width: min(100% - 40px, 620px);
    margin: auto;
    padding: 48px 0;
  }

  .hub-gate h1 { margin: 0; }
  .hub-gate p { margin: 0; line-height: 1.55; }
  .small { color: var(--text-subtle, #5b6572); font-size: 0.9rem; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; }
</style>
