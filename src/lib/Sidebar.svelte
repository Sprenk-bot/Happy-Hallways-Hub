<script lang="ts">
  import { page } from '$app/state';
  import { account } from './account.svelte';
  import BrandMark from './BrandMark.svelte';
  import HelpButton from './HelpButton.svelte';
  import Icon from './Icon.svelte';
  import SidebarClasses from './SidebarClasses.svelte';
  import StatusWidget from './StatusWidget.svelte';
  import { hubRuntime } from './hub-runtime.svelte';
  import { hubMail } from './hub-mail.svelte';

  /**
   * The status box first, then Home, the classes, what the teacher sets up and
   * the devices that run the door, then History and Settings, each group under
   * its own label. What's happening right
   * now lives on Home.
   */
  let classesOpen = $state(true);

  const path = $derived(page.url.pathname);
  /** Settings' tabs: the teacher's data, the guides, about and privacy. */
  const settingsTab = $derived(['/settings', '/settings/guides', '/about', '/privacy'].includes(path));
  const tic = $derived(!hubRuntime.hosted || hubRuntime.session?.role === 'tic');
</script>

<aside class="sidebar">
  <a class="brand" href="/"><BrandMark />Happy Hallways</a>

  {#if account.classes.length}<StatusWidget />{/if}

  <nav class="nav" aria-label="Main">
    <a class="nav-link" class:active={path === '/'} href="/"><Icon name="home" />Home</a>

    {#if tic}
      <button class="nav-toggle" aria-expanded={classesOpen} onclick={() => (classesOpen = !classesOpen)}>
        <Icon name="users" />Classes
        <span class="chevron"><Icon name="chevron-down" size={16} /></span>
      </button>
      {#if classesOpen}
        <div class="nav-sub">
          <SidebarClasses />
          <a class="nav-link add" class:active={path === '/classes/new'} href="/classes/new">
            <Icon name="plus" size={15} />New class
          </a>
        </div>
      {/if}

      <p class="nav-label">Setup</p>
      <a class="nav-link" class:active={path === '/roster'} href="/roster">
        <Icon name="contact" />Roster
      </a>
      <a class="nav-link" class:active={path === '/destinations'} href="/destinations">
        <Icon name="map-pin" />Destinations
      </a>
      <a class="nav-link" class:active={path.startsWith('/schedule')} href="/schedule">
        <Icon name="calendar" />Schedule
      </a>
      <a class="nav-link" class:active={path === '/pass-options'} href="/pass-options">
        <Icon name="clock" />Pass Options
      </a>

      <p class="nav-label">Devices</p>
      <a class="nav-link" class:active={path === '/kiosk'} href="/kiosk">
        <Icon name="kiosk" />Kiosk
      </a>
      <a class="nav-link" class:active={path === '/student-link'} href="/student-link">
        <Icon name="smartphone" />Student devices
      </a>
    {/if}

    <p class="nav-label">More</p>
    <a class="nav-link" class:active={path === '/history'} href="/history"><Icon name="history" />History</a>
    <a class="nav-link" class:active={path === '/mail'} href="/mail">
      <Icon name="mail" />Mail Centre
      {#if hubRuntime.hosted && hubMail.unreadCount}
        <span class="unread-badge" aria-label="{hubMail.unreadCount} unread messages">{hubMail.unreadCount}</span>
      {/if}
    </a>
    {#if tic}
      <a class="nav-link" class:active={settingsTab} href="/settings"><Icon name="settings" />Settings</a>
    {/if}

  </nav>

  <div class="sidebar-foot">
    {#if hubRuntime.hosted}
      <p class="hub-save" class:hub-pending={hubRuntime.saveStatus !== 'saved'}>
        {#if hubRuntime.saveStatus === 'saved'}Saved to Hub{:else if hubRuntime.saveStatus === 'saving'}Saving to Hub…{:else if hubRuntime.saveStatus === 'offline'}Not saved to Hub{:else if hubRuntime.saveStatus === 'conflict' || hubRuntime.saveStatus === 'forbidden'}Needs attention{:else}Hub Host{/if}
      </p>
    {/if}
    <a class="credit" href="https://teacher.dev" target="_blank" rel="noopener noreferrer">
      <img src="/edtechathon-logo.svg" alt="" width="20" height="20" />Built by teacher.dev
    </a>
    <HelpButton />
  </div>
</aside>

<style>
  .hub-save { margin: 0; color: var(--muted); font-size: 12px; }
  .hub-pending { color: var(--warn); font-weight: 700; }
  .unread-badge {
    display: inline-grid;
    min-width: 20px;
    height: 20px;
    margin-left: auto;
    padding: 0 5px;
    place-items: center;
    border-radius: 999px;
    background: #b42318;
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
  }
</style>
