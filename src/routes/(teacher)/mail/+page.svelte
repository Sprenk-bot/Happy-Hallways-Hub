<script lang="ts">
  import { onMount } from "svelte";
  import { account, currentSchedule } from "#lib/account.svelte.ts";
  import { periodAt } from "#lib/schedule.ts";
  import Icon from "#lib/Icon.svelte";
  import { hubRuntime } from "#lib/hub-runtime.svelte.ts";
  import {
    hubMail,
    archiveHubMail,
    markHubMailRead,
    refreshHubMail,
    replyToHubMail,
  } from "#lib/hub-mail.svelte.ts";

  let savingMessageId = $state("");
  let actionError = $state("");
  let search = $state("");
  let replyDrafts = $state<Record<string, string>>({});
  let replyingTo = $state("");
  let showArchived = $state(false);
  const currentSchedulePeriod = $derived(periodAt(currentSchedule()));
  const currentPeriodLabel = $derived(currentSchedulePeriod ? `${currentSchedulePeriod.start}–${currentSchedulePeriod.end}` : '');

  const filteredMessages = $derived.by(() => {
    const needle = search.trim().toLocaleLowerCase();
    return hubMail.messages.filter((message) => (!message.archivedAt || (hubRuntime.session?.role === 'tic' && showArchived)) && (!needle || [message.studentName, message.destinationLabel, message.senderDisplayName, message.note, ...message.recipients.map((recipient) => recipient.displayName), ...message.replies.map((reply) => `${reply.senderDisplayName} ${reply.note}`)].some((value) => value.toLocaleLowerCase().includes(needle))));
  });

  const messageDays = $derived.by(() => {
    const byDay = new Map<string, { key: string; label: string; periods: Map<string, typeof filteredMessages> }>();
    for (const message of filteredMessages) {
      const key = message.submittedAt.slice(0, 10);
      const day = byDay.get(key) ?? { key, label: new Date(message.submittedAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), periods: new Map<string, typeof filteredMessages>() };
      const visit = account.hubVisits.find((item) => item.id === message.visitId);
      const period = visit?.periodName ? null : periodAt(currentSchedule(), Date.parse(message.submittedAt));
      const periodName = visit?.periodName || (period ? `${period.start}–${period.end}` : 'Outside scheduled periods');
      day.periods.set(periodName, [...(day.periods.get(periodName) ?? []), message]);
      byDay.set(key, day);
    }
    return [...byDay.values()].sort((a, b) => b.key.localeCompare(a.key)).map((day) => ({ ...day, periodGroups: [...day.periods.entries()].sort(([a], [b]) => a.localeCompare(b)) }));
  });

  onMount(() => {
    if (hubRuntime.hosted) void refreshHubMail();
  });

  async function markAsRead(messageId: string) {
    savingMessageId = messageId;
    actionError = "";
    try {
      await markHubMailRead(messageId);
    } catch (error) {
      actionError =
        error instanceof Error
          ? error.message
          : "The message could not be marked as read.";
    } finally {
      savingMessageId = "";
    }
  }

  async function sendReply(messageId: string) {
    replyingTo = messageId;
    actionError = "";
    try {
      await replyToHubMail(messageId, replyDrafts[messageId] ?? "");
      replyDrafts[messageId] = "";
    } catch (error) {
      actionError = error instanceof Error ? error.message : "The reply could not be saved.";
    } finally {
      replyingTo = "";
    }
  }

  async function toggleArchive(messageId: string, archived: boolean) {
    try { await archiveHubMail(messageId, archived); }
    catch (error) { actionError = error instanceof Error ? error.message : 'The message could not be archived.'; }
  }
</script>

<svelte:head>
  <title>Mail Centre · Happy Hallways</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <div>
      <p class="eyebrow">Staff messages</p>
      <h1>Mail Centre</h1>
    </div>
    {#if hubRuntime.hosted && hubMail.unreadCount}
      <span class="unread-count">{hubMail.unreadCount} unread</span>
    {/if}
  </header>

  {#if !hubRuntime.hosted}
    <section class="card">
      <p>Private Hub messages are available when connected to the Hub Host.</p>
      <p class="muted small">Browser-only mode does not store or route concern notes.</p>
    </section>
  {:else if hubMail.error}
    <p class="mail-error" role="alert">{hubMail.error}</p>
  {/if}

  {#if actionError}
    <p class="mail-error" role="alert">{actionError}</p>
  {/if}

  {#if hubRuntime.hosted && hubMail.messages.length}
    <label class="mail-search">Search messages <input type="search" bind:value={search} placeholder="Student, staff member, or concern" /></label>
    {#if hubRuntime.session?.role === 'tic'}<label class="archive-toggle"><input type="checkbox" bind:checked={showArchived} /> Show archived messages</label>{/if}
    <section class="mail-list" aria-label="Hub concern messages">
      {#if !messageDays.length}<p class="muted">No messages match this search.</p>{/if}
      {#each messageDays as day (day.key)}
        <details class="mail-day" open={day.key === new Date().toISOString().slice(0, 10)}>
          <summary>{day.label}</summary>
          {#each day.periodGroups as [periodName, periodMessages] (periodName)}
            <details class="mail-period" open={day.key === new Date().toISOString().slice(0, 10) && periodName === currentPeriodLabel}>
              <summary>{periodName} ({periodMessages.length})</summary>
              {#each periodMessages as message (message.id)}
        <article class="card mail-item" class:unread={message.isRecipient && !message.readAt}>
          <div class="mail-heading">
            <div>
              <p class="mail-meta">
                {#if message.isSender}
                  Sent by you
                {:else if message.isTicOversight}
                  TIC oversight
                {:else}
                  Sent by {message.senderDisplayName}
                {/if}
                · {new Date(message.submittedAt).toLocaleString()}
              </p>
              <h2>{message.studentName} · {message.destinationLabel}</h2>
            </div>
            {#if message.isRecipient && !message.readAt}
              <span class="unread-pill">Unread</span>
            {/if}
          </div>

          <p class="mail-note">{message.note}</p>
          {#if message.archivedAt}<p class="muted small">Archived {new Date(message.archivedAt).toLocaleString()}.</p>{/if}

          {#if message.replies.length}
            <section class="reply-thread" aria-label="Replies to this message">
              {#each message.replies as reply (reply.id)}
                <article class="reply-item"><p class="mail-meta">{reply.senderDisplayName} · {new Date(reply.submittedAt).toLocaleString()}</p><p class="mail-note">{reply.note}</p></article>
              {/each}
            </section>
          {/if}

          <form class="reply-form" onsubmit={(event) => { event.preventDefault(); void sendReply(message.id); }}>
            <label>Reply in this message chain<textarea rows="2" maxlength="2000" bind:value={replyDrafts[message.id]} placeholder="Write a reply for the staff on this message"></textarea></label>
            <button class="btn btn-small" disabled={replyingTo === message.id || !(replyDrafts[message.id] ?? '').trim()}>{replyingTo === message.id ? 'Saving…' : 'Reply'}</button>
          </form>

          <details>
            <summary>Routing details</summary>
            <p class="muted small">Scope: {message.scope === 'tic' ? 'TIC' : message.scope === 'all-staff' ? 'All staff' : 'Selected staff'}</p>
            <ul>
              {#each message.recipients as recipient (`${message.id}-${recipient.staffId}`)}
                <li>{recipient.displayName} ({recipient.role.toUpperCase()})</li>
              {/each}
            </ul>
            <p class="muted small">Submitted by {message.senderDisplayName}. Message time: {new Date(message.submittedAt).toLocaleString()}.</p>
          </details>

          {#if message.isRecipient && !message.readAt}
            <button
              class="btn btn-small"
              disabled={savingMessageId === message.id}
              onclick={() => markAsRead(message.id)}
            >
              {savingMessageId === message.id ? 'Saving…' : 'Mark as read'}
            </button>
          {:else if message.isRecipient && message.readAt}
            <p class="muted small">Read {new Date(message.readAt).toLocaleString()}.</p>
          {/if}
          {#if hubRuntime.session?.role === 'tic'}<button class="btn btn-small btn-quiet" onclick={() => void toggleArchive(message.id, !message.archivedAt)}>{message.archivedAt ? 'Unarchive message' : 'Archive message'}</button>{/if}
        </article>
              {/each}
            </details>
          {/each}
        </details>
      {/each}
    </section>
  {:else if hubRuntime.hosted && !hubMail.error}
    <section class="card empty-mail">
      <Icon name="mail" size={24} />
      <p>No Hub messages yet.</p>
      <p class="muted small">Concern notes sent to you will appear here. Messages remain available while you are offline.</p>
    </section>
  {/if}
</div>

<style>
  .page {
    display: grid;
    gap: 18px;
    max-width: 1180px;
    margin: 0 auto;
  }

  .page-head,
  .mail-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .page-head h1,
  .mail-heading h2 {
    margin: 0;
  }

  .eyebrow,
  .mail-meta {
    margin: 0 0 4px;
    color: var(--muted);
    font-size: 13px;
  }

  .unread-count,
  .unread-pill {
    border-radius: 999px;
    background: #b42318;
    color: #fff;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 700;
  }

  .mail-list {
    display: grid;
    gap: 12px;
  }
  .mail-search { display:grid; gap:6px; max-width:900px; font-weight:700; }
  .archive-toggle { display:flex; gap:8px; align-items:center; }
  .mail-search input { min-height:42px; padding:8px 12px; border:1px solid var(--border-strong); border-radius:8px; }
  .mail-day, .mail-period { display:grid; gap:10px; }
  .mail-day > summary, .mail-period > summary { padding:10px 12px; border-radius:8px; background:var(--surface-sunk); font-weight:800; cursor:pointer; }
  .mail-period { margin:10px 0 0 14px; }
  .reply-thread { display:grid; gap:8px; border-left:3px solid var(--border); padding-left:12px; }
  .reply-item { padding:10px 12px; border-radius:8px; background:var(--surface-sunk); }
  .reply-item p { margin:0; }
  .reply-form { display:flex; align-items:end; gap:8px; }
  .reply-form label { display:grid; flex:1; gap:5px; font-weight:700; }
  .reply-form textarea { width:100%; box-sizing:border-box; padding:9px; border:1px solid var(--border-strong); border-radius:8px; font:inherit; }

  .mail-item {
    display: grid;
    gap: 12px;
  }

  .mail-item.unread {
    border-color: var(--accent);
  }

  .mail-note {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .mail-item details {
    color: var(--muted);
    font-size: 13px;
  }

  .mail-item summary {
    cursor: pointer;
    font-weight: 700;
  }

  .mail-item details ul {
    margin: 6px 0;
  }

  .mail-error {
    color: var(--warn);
  }

  .empty-mail {
    display: grid;
    justify-items: start;
    gap: 8px;
  }

  .empty-mail p {
    margin: 0;
  }
</style>
