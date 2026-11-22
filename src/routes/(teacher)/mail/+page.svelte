<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "#lib/Icon.svelte";
  import { hubRuntime } from "#lib/hub-runtime.svelte.ts";
  import {
    hubMail,
    markHubMailRead,
    refreshHubMail,
  } from "#lib/hub-mail.svelte.ts";

  let savingMessageId = $state("");
  let actionError = $state("");

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
    <section class="mail-list" aria-label="Hub concern messages">
      {#each hubMail.messages as message (message.id)}
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
        </article>
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
    max-width: 920px;
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
