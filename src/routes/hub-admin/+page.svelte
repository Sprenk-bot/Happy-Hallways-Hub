<script lang="ts">
  import { onMount } from 'svelte';
  import BrandMark from '#lib/BrandMark.svelte';
  import Icon from '#lib/Icon.svelte';
  import { account, exportAccount, saveHubKioskSoundSettings, unreadable } from '#lib/account.svelte.ts';
  import { download } from '#lib/csv.ts';
  import { hasUnsavedHubChanges, importLocalAccountToHost, flushHubSaves, hubRuntime, signOutHubRuntime, startHubRuntime } from '#lib/hub-runtime.svelte.ts';
  import { hubChimeOptions, playHubChime } from '../../lib/sound';
  import {
    isHubKioskChime,
    type HubKioskSoundSettings,
    type HubPromptStage,
  } from '../../lib/types';

  type StaffSession = {
    sessionId: string;
    staffId: string;
    displayName: string;
    role: 'ea' | 'tic';
    authMethod: string;
    identityVerified: boolean;
    mfaVerified: boolean;
    expiresAt: string;
  };

  type ConcernScope = 'tic' | 'all-staff' | 'selected';
  type ConcernPolicy = {
    availableScopes: ConcernScope[];
    defaultScope: ConcernScope;
    updatedAt: string;
  };

  type Health = {
    status: string;
    storage: string;
    application: string;
    network: { mode: string; schoolLanTest: string };
    revision: number;
    lastSavedAt: string | null;
  };

  type BackupHealth = {
    encryption: { status: 'enabled' | 'disabled' | 'key_mismatch' | 'key_unavailable'; keyId: string | null; legacyUnencryptedBackups: number; unavailableEncryptedBackups: number };
    local: { status: string; latestSnapshotAt: string | null; latestRevision: number | null; error: string | null };
    offHost: {
      status: string;
      latestCopyAt: string | null;
      latestCopyLagMs: number | null;
      pendingCopies: number;
      independentStorageVerified: false;
      fallbackOperational: boolean;
      error: string | null;
      destinations: { role: string; path: string | null; status: string; latestCopyAt: string | null; latestCopyLagMs: number | null; pendingCopies: number; error: string | null }[];
    };
    restoreTest: { status: string; lastTestAt: string | null; error: string | null };
    localSnapshotIntervalMinutes: number;
    targetOffHostLagMinutes: number;
    retention: string;
  };

  type RestorePoint = {
    backupId: string;
    kind: string;
    createdAt: string;
    revision: number;
    schemaVersion: number;
    recordCounts: Record<string, number>;
    integrityCheck: string;
    checksumValid: boolean;
    restorable: boolean;
    staffName?: string | null;
    staffRole?: 'ea' | 'tic' | null;
    changeType?: string;
    error?: string | null;
  };

  type StoredState = {
    revision: number;
    savedAt: string | null;
    checksum: string | null;
    snapshot: Record<string, unknown> | null;
  };

  let loading = $state(true);
  let working = $state(false);
  let health = $state<Health | null>(null);
  let backupHealth = $state<BackupHealth | null>(null);
  let session = $state<StaffSession | null>(null);
  let entraEnabled = $state(false);
  let fallbackEnabled = $state(false);
  let fallbackRealDataApproved = $state(false);
  let restorePoints = $state<RestorePoint[]>([]);
  let staffProfiles = $state<{ id: string; displayName: string; authMethod: string; role: 'ea' | 'tic' | null }[]>([]);
  let concernPolicy = $state<ConcernPolicy>({
    availableScopes: ['tic', 'all-staff', 'selected'],
    defaultScope: 'tic',
    updatedAt: '',
  });
  let stagedRestore = $state<{ stageId: string; backupId: string; preview: { backupCreatedAt: string; snapshotRevision: number; recordCounts: Record<string, number>; integrityCheck: string; snapshotChecksumValid: boolean } } | null>(null);
  let confirmRestore = $state(false);
  let error = $state('');
  let notice = $state('');
  let invitationToken = $state('');
  let displayName = $state('');
  let entraInviteToken = $state('');
  let invitedEmail = $state('');
  let invitedRole = $state<'ea' | 'tic'>('ea');
  let invitationAuthMode = $state<'entra' | 'fallback'>('entra');
  let invitedProfileId = $state('');
  let issuedInvitation = $state<{ token: string; expiresAt: string; invitedEmail: string | null; role: string } | null>(null);
  let kioskActivation = $state<{ url: string; expiresAt: string } | null>(null);
  let hostState = $state<StoredState | null>(null);
  let promptOverrideStudentId = $state('');
  let promptOverrideDestinationId = $state('');
  let promptOverrideStage = $state<HubPromptStage>('arrival');
  let promptOverrideReason = $state('');
  let confirmLocalImport = $state(false);
  let localImportWorking = $state(false);
  let eaPassword = $state('');
  let eaPasswordSet = $state(false);
  const defaultHubSoundSettings: HubKioskSoundSettings = {
    muted: false,
    volume: 70,
    commonChime: 'soft',
  };
  const hubSoundSettings = $derived(account.hubKioskSoundSettings ?? defaultHubSoundSettings);

  async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(errorText(body?.error, response.status));
    return body as T;
  }

  async function issuePromptOverride() {
    if (!session || !promptOverrideStudentId || !promptOverrideDestinationId) return;
    if (hubRuntimeDirty()) {
      error = 'Save or download the unsaved changes before issuing a prompt override.';
      return;
    }
    working = true;
    error = '';
    notice = '';
    try {
      const result = await requestJson<{ revision: number; expiresAt: string }>(
        '/api/v1/hub/prompt-overrides',
        {
          method: 'POST',
          body: JSON.stringify({
            studentId: promptOverrideStudentId,
            destinationId: promptOverrideDestinationId,
            stage: promptOverrideStage,
            reason: promptOverrideReason.trim(),
          }),
        },
      );
      promptOverrideReason = '';
      notice = `One-use override saved at Host revision ${result.revision}; it expires ${formatDate(result.expiresAt)}. Its reason and staff attribution are not shown on the kiosk.`;
      hostState = await requestJson<StoredState>('/api/v1/state');
    } catch (problem) {
      error = problem instanceof Error
        ? problem.message
        : 'The prompt override was not saved by the Hub Host.';
    } finally {
      working = false;
    }
  }

  async function setEAPassword() {
    if (!eaPassword.trim()) return;
    working = true;
    try {
      const stored = await requestJson<StoredState>('/api/v1/state', {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: hostState?.revision ?? 0,
          baseSnapshot: hostState?.snapshot ?? null,
          snapshot: { ...accountSnapshot(), password: eaPassword }
        })
      });
      hostState = stored;
      eaPasswordSet = true;
      eaPassword = '';
      notice = 'EA Password set. All staff can now sign in using this password.';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not save EA password.';
    } finally {
      working = false;
    }
  }

  function currentPromptOverrideStudents() {
    const snapshot = hostState?.snapshot;
    if (!snapshot) return [];
    const currentIds = new Set(
      snapshotRecords(snapshot.classes).flatMap((cls) =>
        snapshotRecords(cls.members)
          .flatMap((member) =>
            member.status === 'current' && typeof member.studentId === 'string'
              ? [member.studentId]
              : [],
          ),
      ),
    );
    return snapshotRecords(snapshot.roster)
      .filter(
        (student) =>
          typeof student.id === 'string' &&
          currentIds.has(student.id) &&
          typeof student.firstName === 'string',
      )
      .map((student) => ({
        id: String(student.id),
        label: `${String(student.firstName)}${typeof student.lastName === 'string' && student.lastName ? ` ${student.lastName}` : ''}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  function currentPromptOverrideDestinations() {
    const snapshot = hostState?.snapshot;
    if (!snapshot) return [];
    const field = promptOverrideStage === 'arrival'
      ? 'hubArrivalPrompts'
      : 'hubDeparturePrompts';
    return snapshotRecords(snapshot.destinations)
      .filter(
        (destination) =>
          typeof destination.id === 'string' &&
          typeof destination.label === 'string' &&
          destination.kioskAvailable !== false &&
          hasRequiredPrompt(destination[field]),
      )
      .map((destination) => ({
        id: String(destination.id),
        label: String(destination.label),
      }));
  }

  function snapshotRecords(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
      ? value.filter(isRecordValue)
      : [];
  }

  function hasRequiredPrompt(value: unknown) {
    return (
      Array.isArray(value) &&
      value.some(
        (prompt) => isRecordValue(prompt) && prompt.required === true,
      )
    );
  }

  function isRecordValue(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function errorText(code: string | undefined, status: number) {
    const messages: Record<string, string> = {
      entra_sign_in_not_configured: 'Microsoft Entra sign-in is not configured yet. Use the named-profile fallback approved for this Host.',
      fallback_sign_in_not_configured: 'The named-profile fallback is disabled in Host configuration. Ask the Host administrator to enable it.',
      invitation_unavailable: 'That invitation has expired, was used already, or does not match this staff account.',
      invalid_invitation: 'Check the invitation token and try again.',
      staff_session_required: 'Sign in with an authorised staff account to continue.',
      tic_role_required: 'This action is available to a Teacher-in-Charge account.',
      state_integrity_failed: 'The Host detected a data integrity problem and has stopped this action.',
      required_hub_prompt_missing: 'Answer each required Hub question before continuing.',
      hub_prompt_configuration_changed: 'The Hub prompt configuration changed. Refresh and try again.',
      invalid_hub_prompt_response: 'One or more Hub prompt answers could not be accepted.',
    };
    return messages[code ?? ''] ?? (code ? `The Host could not complete this action (${code}).` : `The Host request failed (${status}).`);
  }

  async function refreshHealth() {
    health = await requestJson<Health>('/api/v1/health');
    const options = await requestJson<{ preferred: { enabled: boolean }; fallback: { enabled: boolean; realStudentDataAllowed: boolean } }>('/api/v1/auth/options');
    entraEnabled = options.preferred.enabled;
    fallbackEnabled = options.fallback.enabled;
    fallbackRealDataApproved = options.fallback.realStudentDataAllowed;
  }

  async function refreshTicData() {
    if (session?.role !== 'tic') return;
    const [backups, points, staff, routing] = await Promise.all([
      requestJson<BackupHealth>('/api/v1/backups/health'),
      requestJson<{ restorePoints: RestorePoint[] }>('/api/v1/backups/restore-points'),
      requestJson<{ staff: { id: string; displayName: string; authMethod: string; role: 'ea' | 'tic' | null }[] }>('/api/v1/staff'),
      requestJson<ConcernPolicy>('/api/v1/concerns/settings'),
    ]);
    backupHealth = backups;
    restorePoints = points.restorePoints;
    staffProfiles = staff.staff;
    concernPolicy = routing;
  }

  async function refreshSession() {
    session = await requestJson<StaffSession>('/api/v1/session').catch(() => null);
    hostState = session ? await requestJson<StoredState>('/api/v1/state').catch(() => null) : null;
    if (session?.role === 'tic') {
      try {
        await refreshTicData();
      } catch (problem) {
        backupHealth = null;
        error = problem instanceof Error ? problem.message : 'TIC tools could not load.';
      }
    } else {
      backupHealth = null;
      restorePoints = [];
    }
  }

  async function refreshAll() {
    error = '';
    try {
      await refreshHealth();
      await refreshSession();
    } catch (problem) {
      health = null;
      error = problem instanceof Error ? problem.message : 'The Hub Host could not be reached.';
    } finally {
      loading = false;
    }
  }

  async function signInWithEntra() {
    if (!confirmSignInWithPendingChanges()) return;
    error = '';
    working = true;
    try {
      const body = entraInviteToken.trim() ? { invitationToken: entraInviteToken.trim() } : {};
      const result = await requestJson<{ authorizationUrl: string }>('/api/v1/auth/entra/start', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      window.location.assign(result.authorizationUrl);
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Microsoft Entra sign-in could not start.';
      working = false;
    }
  }

  async function enrollFallback() {
    if (!confirmSignInWithPendingChanges()) return;
    error = '';
    notice = '';
    working = true;
    try {
      await requestJson('/api/v1/enroll', {
        method: 'POST',
        body: JSON.stringify({ invitationToken: invitationToken.trim(), displayName: displayName.trim() }),
      });
      invitationToken = '';
      displayName = '';
      notice = 'Development fallback session started. It does not verify identity or provide MFA.';
      await refreshAll();
      await startHubRuntime();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The invitation could not be used.';
    } finally {
      working = false;
    }
  }

  async function signOut() {
    if (hubRuntimeDirty()) {
      error = 'Save or download the unsaved changes before signing out.';
      return;
    }
    working = true;
    try {
      await requestJson('/api/v1/sign-out', { method: 'POST' });
      session = null;
      signOutHubRuntime();
      backupHealth = null;
      restorePoints = [];
      notice = 'You have signed out.';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Sign-out failed.';
    } finally {
      working = false;
    }
  }

  async function startStudentKiosk() {
    if (session?.role !== 'tic' || hubRuntimeDirty()) return;
    working = true;
    error = '';
    notice = '';
    try {
      const activation = await requestJson<{ token: string; expiresAt: string }>('/api/v1/kiosk/start', {
        method: 'POST',
      });
      const url = new URL('/hub-kiosk', window.location.origin);
      url.hash = new URLSearchParams({ activate: activation.token }).toString();
      kioskActivation = { url: url.toString(), expiresAt: activation.expiresAt };
      notice = 'One-use kiosk activation link created. Open it in a separate kiosk browser profile within ten minutes.';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The kiosk activation link could not be created.';
    } finally {
      working = false;
    }
  }

  async function copyKioskActivation() {
    if (!kioskActivation) return;
    try {
      await navigator.clipboard.writeText(kioskActivation.url);
      notice = 'Kiosk activation link copied. Open it in the separate kiosk browser profile.';
    } catch (problem) {
      error = problem instanceof Error
        ? `The link could not be copied. Select and copy the link below instead. (${problem.message})`
        : 'The link could not be copied. Select and copy the link below instead.';
    }
  }

  async function stopStudentKiosk() {
    if (session?.role !== 'tic') return;
    working = true;
    error = '';
    notice = '';
    try {
      const result = await requestJson<{
        stoppedCount: number;
        revokedActivationCount: number;
      }>('/api/v1/kiosk/stop', {
        method: 'POST',
      });
      kioskActivation = null;
      notice = result.stoppedCount || result.revokedActivationCount
        ? 'The active kiosk session was stopped and any unused activation link was revoked.'
        : 'No active kiosk session or unused activation link was found.';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The student kiosk could not be stopped.';
    } finally {
      working = false;
    }
  }

  function downloadUnsavedCopy() {
    download(
      `happy-hallways-unsaved-${new Date().toISOString().slice(0, 10)}.json`,
      exportAccount(),
      'application/json',
    );
  }

  function confirmSignInWithPendingChanges() {
    if (!hubRuntimeDirty()) return true;
    downloadUnsavedCopy();
    return confirm('A backup of the unsaved changes was downloaded. Continue to sign-in? The Host copy will load after sign-in.');
  }

  async function initialiseHostAccount() {
    if (!confirmLocalImport || session?.role !== 'tic' || hostState?.snapshot !== null || unreadable.raw !== null) return;
    localImportWorking = true;
    error = '';
    notice = '';
    try {
      const backupText = exportAccount();
      download(`happy-hallways-before-hub-${new Date().toISOString().slice(0, 10)}.json`, backupText, 'application/json');
      await importLocalAccountToHost();
      confirmLocalImport = false;
      notice = 'The browser account was copied to the Host. The original browser copy remains in place.';
      await refreshAll();
      window.setTimeout(() => window.location.assign('/'), 700);
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The local account could not be copied to the Host.';
    } finally {
      localImportWorking = false;
    }
  }

  function hubRuntimeDirty() {
    return hasUnsavedHubChanges();
  }

  async function updateHubKioskSoundSettings(changes: Partial<HubKioskSoundSettings>) {
    if (session?.role !== 'tic' || working) return;
    if (hubRuntime.status !== 'ready') {
      error = 'Connect to the Hub Host before changing kiosk sound settings.';
      return;
    }
    if (hubRuntimeDirty()) {
      error = 'Save or download the other unsaved changes before changing kiosk sound settings.';
      return;
    }
    working = true;
    error = '';
    notice = '';
    try {
      saveHubKioskSoundSettings({ ...hubSoundSettings, ...changes });
      if (!(await flushHubSaves())) {
        throw new Error(hubRuntime.message || 'The Hub Host did not acknowledge the sound settings.');
      }
      hostState = await requestJson<StoredState>('/api/v1/state');
      notice = 'Hub kiosk sound settings were saved by the Hub Host.';
    } catch (problem) {
      error = problem instanceof Error
        ? problem.message
        : 'The Hub Host did not confirm the sound settings.';
    } finally {
      working = false;
    }
  }

  async function runBackup() {
    working = true;
    error = '';
    notice = '';
    try {
      await requestJson('/api/v1/backups/run', { method: 'POST' });
      notice = 'The Host completed a backup cycle. Check the status below for each destination.';
      await refreshTicData();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The backup cycle failed.';
    } finally {
      working = false;
    }
  }

  async function stageBackup(backupId: string) {
    working = true;
    error = '';
    confirmRestore = false;
    try {
      const result = await requestJson<{ stage: { stageId: string; backupId: string; preview: NonNullable<typeof stagedRestore>['preview'] } }>('/api/v1/backups/restore/stage', {
        method: 'POST',
        body: JSON.stringify({ backupId }),
      });
      stagedRestore = result.stage;
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The restore point could not be staged.';
    } finally {
      working = false;
    }
  }

  async function promoteRestore() {
    if (!stagedRestore || !confirmRestore) return;
    working = true;
    error = '';
    try {
      await requestJson('/api/v1/backups/restore/promote', {
        method: 'POST',
        body: JSON.stringify({ stageId: stagedRestore.stageId }),
      });
      stagedRestore = null;
      confirmRestore = false;
      notice = 'The staged restore was promoted. A pre-restore copy and audit record were created.';
      await refreshTicData();
      await refreshHealth();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The restore was not promoted.';
    } finally {
      working = false;
    }
  }

  async function issueInvitation() {
    working = true;
    error = '';
    issuedInvitation = null;
    try {
      const result = await requestJson<{ invitation: NonNullable<typeof issuedInvitation> }>('/api/v1/invitations', {
        method: 'POST',
        body: JSON.stringify({
          role: invitedRole,
          invitedEmail: invitationAuthMode === 'entra' ? invitedEmail.trim() : undefined,
          staffProfileId: invitedProfileId || undefined,
        }),
      });
      issuedInvitation = result.invitation;
      invitedEmail = '';
      invitedProfileId = '';
      notice = 'Invitation created. The token is shown once here and expires in ten minutes.';
      await refreshTicData();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'The staff invitation could not be created.';
    } finally {
      working = false;
    }
  }

  function setConcernScopeAvailable(scope: ConcernScope, enabled: boolean) {
    const scopes = new Set(concernPolicy.availableScopes);
    if (enabled) scopes.add(scope);
    else scopes.delete(scope);
    if (!scopes.size) return;
    const availableScopes = (['tic', 'all-staff', 'selected'] as const).filter((item) => scopes.has(item));
    concernPolicy = {
      ...concernPolicy,
      availableScopes,
      defaultScope: availableScopes.includes(concernPolicy.defaultScope)
        ? concernPolicy.defaultScope
        : availableScopes[0],
    };
  }

  async function saveConcernPolicy() {
    working = true;
    error = '';
    notice = '';
    try {
      concernPolicy = await requestJson<ConcernPolicy>('/api/v1/concerns/settings', {
        method: 'PUT',
        body: JSON.stringify({
          availableScopes: concernPolicy.availableScopes,
          defaultScope: concernPolicy.defaultScope,
        }),
      });
      notice = 'Concern routing policy saved to the Hub Host.';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Concern routing policy could not be saved.';
    } finally {
      working = false;
    }
  }

  function selectExistingProfile(event: Event) {
    invitedProfileId = (event.currentTarget as HTMLSelectElement).value;
    const profile = staffProfiles.find((candidate) => candidate.id === invitedProfileId);
    if (profile?.role) invitedRole = profile.role;
  }

  function formatDate(value: string | null | undefined) {
    if (!value) return 'No record yet';
    return new Date(value).toLocaleString();
  }

  function formatLag(value: number | null | undefined) {
    if (value === null || value === undefined) return 'Pending or unavailable';
    if (value < 1000) return 'Under 1 second';
    if (value < 60_000) return `${Math.round(value / 1000)} seconds`;
    return `${(value / 60_000).toFixed(1)} minutes`;
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('signIn') === 'complete') notice = 'Microsoft Entra sign-in completed.';
    if (params.get('signIn') === 'failed') error = 'Microsoft Entra sign-in was cancelled or not completed.';
    void refreshAll();
    const timer = window.setInterval(() => void refreshAll(), 30_000);
    return () => window.clearInterval(timer);
  });
</script>

<svelte:head>
  <title>Hub Host | Happy Hallways</title>
  <meta name="description" content="Staff sign-in and Hub Host backup health." />
</svelte:head>

<main class="host-page">
  <header class="host-head">
    <a class="brand" href="/" aria-label="Happy Hallways home"><BrandMark />Happy Hallways</a>
    <div>
      <p class="eyebrow">Local Hub Host</p>
      <h1>Staff access and recovery</h1>
      <p class="muted">Sign in to manage Host backups and staff invitations.</p>
    </div>
  </header>

  {#if error}<p class="alert error" role="alert">{error}</p>{/if}
  {#if notice}<p class="alert notice" role="status">{notice}</p>{/if}

  <section class="card host-status" aria-labelledby="host-status-heading">
    <div class="card-title">
      <div><p class="eyebrow">Connection</p><h2 id="host-status-heading">Hub Host status</h2></div>
      <button class="btn" onclick={refreshAll} disabled={loading || working}>Refresh</button>
    </div>
    {#if loading}
      <p class="muted">Checking the local Host…</p>
    {:else if health}
      <div class="status-grid">
        <div><span>Host</span><strong class="status-ok">Connected</strong></div>
        <div><span>Listener</span><strong>{health.network.mode === 'loopback_only' ? 'This computer only' : 'HTTPS LAN configured'}</strong></div>
        <div><span>School LAN test</span><strong class="status-warn">{health.network.schoolLanTest.replaceAll('_', ' ')}</strong></div>
        <div><span>Application</span><strong>{health.application === 'served_from_host' ? 'Served locally' : 'API only'}</strong></div>
        <div><span>Saved revision</span><strong>{health.revision}</strong></div>
        <div><span>Last saved</span><strong>{formatDate(health.lastSavedAt)}</strong></div>
      </div>
      <p class="muted small">A connected local page does not mean school LAN access has been tested. Hub account changes are stored by the Host after it acknowledges each save.</p>
    {:else}
      <p class="status-warn">Hub Host unavailable. Actions on this page are not saved.</p>
    {/if}
  </section>

  {#if !session}
    <section class="card" aria-labelledby="sign-in-heading">
      <p class="eyebrow">Staff account</p>
      <h2 id="sign-in-heading">Sign in to the Host</h2>
      {#if hubRuntimeDirty()}<p class="alert error">This browser has unsaved changes from the previous Host session. They remain in memory in this tab. Download them before signing in again.</p><button class="btn" onclick={downloadUnsavedCopy}>Download unsaved changes</button>{/if}
      {#if entraEnabled}
        <div class="sign-in-block">
          <p>Use your school Microsoft account. Your TIC can give you a one-time invitation when this is your first sign-in.</p>
          <label for="entra-invitation">First sign-in invitation <span class="muted">(leave blank if your account is already linked)</span></label>
          <input id="entra-invitation" type="password" autocomplete="off" bind:value={entraInviteToken} />
          <button class="btn btn-primary" onclick={signInWithEntra}><Icon name="key" size={16} />Continue with Microsoft Entra</button>
        </div>
      {:else}
        <p class="notice-text">Microsoft Entra is not ready. ICT needs to approve the app registration, MFA policy, and Host certificate settings.</p>
        {#if !fallbackEnabled}<p class="status-warn">The named-profile fallback is disabled in Host configuration.</p>{/if}
      {/if}

      {#if fallbackEnabled}
        <details class="fallback">
          <summary>Named-profile sign-in</summary>
          <p class="status-warn">{fallbackRealDataApproved ? 'ICT has approved this named-profile sign-in as a compensating control for real data on this Host. It does not verify staff identity and is not MFA.' : 'This sign-in is enabled for fictional development only. It does not verify staff identity and is not MFA.'}</p>
          <label for="fallback-token">One-time TIC invitation</label>
          <input id="fallback-token" type="password" autocomplete="off" bind:value={invitationToken} />
          <label for="fallback-name">Display name</label>
          <input id="fallback-name" autocomplete="name" bind:value={displayName} />
          <button class="btn" onclick={enrollFallback} disabled={working || !invitationToken.trim() || !displayName.trim()}>Sign in with named profile</button>
        </details>
      {/if}
    </section>
  {:else}
    <section class="card staff-session" aria-label="Signed-in staff account">
      <div><p class="eyebrow">Signed in</p><h2>{session.displayName}</h2><p class="muted">{session.role === 'tic' ? 'Teacher-in-Charge' : 'EA staff'} · {session.authMethod === 'microsoft-entra-oidc' ? 'Microsoft Entra' : 'Named profile'}</p></div>
      <div class="session-actions">{#if hubRuntimeDirty()}<button class="btn" onclick={downloadUnsavedCopy}>Download unsaved changes</button>{/if}<button class="btn" onclick={signOut} disabled={working}>Sign out</button></div>
    </section>

    {#if session.role === 'tic' && hostState?.snapshot === null}
      <section class="card" aria-labelledby="initialise-heading">
        <p class="eyebrow">One-time setup</p>
        <h2 id="initialise-heading">Copy this browser account to the Host</h2>
        <p class="muted">The Host is empty. This makes a downloadable Happy Hallways backup first, then copies the current account, student IDs, PINs, pass history, class settings, and timestamps into the Host database. The browser copy is kept unchanged.</p>
        <p class="muted small">This browser currently has {account.roster.length} students, {account.classes.length} classes, and {account.passes.length} pass records. If the browser data is not the account you intend to use, cancel and open the correct browser profile before continuing.</p>
        {#if unreadable.raw !== null}<p class="alert error">This browser's saved data could not be read. The Host will not be initialised from it. Recover the browser backup first.</p>{/if}
        <label class="acknowledge"><input type="checkbox" bind:checked={confirmLocalImport} />I downloaded a backup and confirm this is the account to initialise on the Host.</label>
        <button class="btn btn-primary" onclick={initialiseHostAccount} disabled={!confirmLocalImport || working || localImportWorking || unreadable.raw !== null}>
          {localImportWorking ? 'Copying account to Host…' : 'Download backup and copy to Host'}
        </button>
      </section>
    {:else if hostState?.snapshot}
      <section class="card" aria-labelledby="shared-account-heading">
        <p class="eyebrow">Shared account</p>
        <h2 id="shared-account-heading">Connected to the Host account</h2>
        <p class="muted">Revision {hostState.revision}. The Host is the durable record for connected staff screens.</p>
      </section>
    {/if}

    {#if hostState?.snapshot}
      <section class="card" aria-labelledby="hub-prompt-override-heading">
        <p class="eyebrow">Student support</p>
        <h2 id="hub-prompt-override-heading">Temporarily waive a required Hub question</h2>
        <p class="muted small">Use only when a student cannot answer a required question. The Host records the staff member, reason, and use in the audit history. The override applies once to the selected student, destination, and stage, expires after ten minutes, and never reveals its reason on the kiosk.</p>
        <div class="prompt-override-form">
          <label for="prompt-override-student">Student</label>
          <select id="prompt-override-student" bind:value={promptOverrideStudentId} disabled={working}>
            <option value="">Choose a student</option>
            {#each currentPromptOverrideStudents() as student (student.id)}
              <option value={student.id}>{student.label}</option>
            {/each}
          </select>
          <label for="prompt-override-stage">Prompt stage</label>
          <select
            id="prompt-override-stage"
            bind:value={promptOverrideStage}
            onchange={() => (promptOverrideDestinationId = '')}
            disabled={working}
          >
            <option value="arrival">Arrival</option>
            <option value="departure">Departure / reflection</option>
          </select>
          <label for="prompt-override-destination">Destination</label>
          <select id="prompt-override-destination" bind:value={promptOverrideDestinationId} disabled={working}>
            <option value="">Choose a destination</option>
            {#each currentPromptOverrideDestinations() as destination (destination.id)}
              <option value={destination.id}>{destination.label}</option>
            {/each}
          </select>
          <label for="prompt-override-reason">Reason (3–300 characters)</label>
          <textarea id="prompt-override-reason" rows="3" maxlength="300" bind:value={promptOverrideReason} disabled={working}></textarea>
          <button
            class="btn btn-primary"
            onclick={issuePromptOverride}
            disabled={working || !promptOverrideStudentId || !promptOverrideDestinationId || promptOverrideReason.trim().length < 3 || promptOverrideReason.trim().length > 300 || hubRuntimeDirty()}
          >Issue one-use override</button>
        </div>
      </section>
    {/if}

    {#if session.role === 'tic' && hostState?.snapshot}
      <section class="card" aria-labelledby="student-kiosk-heading">
        <p class="eyebrow">Student-facing screen</p>
        <h2 id="student-kiosk-heading">Hub kiosk</h2>
        <p class="muted small">Create a one-use activation link and open it in a separate browser profile on the kiosk. It expires after ten minutes. The kiosk receives only shortened student names and open Hub movement status; it cannot read the staff account or private concern notes.</p>
        <div class="session-actions">
          <button class="btn btn-primary" onclick={startStudentKiosk} disabled={working || hubRuntimeDirty()}>Create kiosk activation link</button>
          <button class="btn" onclick={stopStudentKiosk} disabled={working}>Stop active kiosk sessions</button>
        </div>
        {#if kioskActivation}
          <label class="kiosk-activation-label" for="kiosk-activation-link">One-use link · expires {formatDate(kioskActivation.expiresAt)}</label>
          <div class="session-actions">
            <input id="kiosk-activation-link" class="kiosk-activation-link" type="text" readonly value={kioskActivation.url} />
            <button class="btn" onclick={copyKioskActivation} disabled={working}>Copy link</button>
          </div>
        {/if}
      </section>
    {/if}

    {#if session.role === 'tic' && hostState?.snapshot}
      <section class="card" aria-labelledby="hub-kiosk-sounds-heading">
        <p class="eyebrow">Hub kiosk</p>
        <h2 id="hub-kiosk-sounds-heading">Movement sounds</h2>
        <p class="muted small">These settings apply only to Hub movements. Sounds play after the Host saves an action; muting does not disable or delay movement recording.</p>
        <label class="field">
          <span><input type="checkbox" checked={hubSoundSettings.muted} onchange={(event) => void updateHubKioskSoundSettings({ muted: event.currentTarget.checked })} disabled={working || hubRuntime.status !== 'ready' || hubRuntimeDirty()} /> Mute all Hub kiosk sounds</span>
        </label>
        <label class="field" for="hub-kiosk-volume">
          Volume · {hubSoundSettings.volume}%
          <input id="hub-kiosk-volume" type="range" min="0" max="100" step="1" value={hubSoundSettings.volume} onchange={(event) => void updateHubKioskSoundSettings({ volume: Number(event.currentTarget.value) })} disabled={working || hubRuntime.status !== 'ready' || hubRuntimeDirty()} />
        </label>
        <label class="field" for="hub-kiosk-return-chime">
          Common departure / return chime
          <select
            id="hub-kiosk-return-chime"
            value={hubSoundSettings.commonChime}
            onchange={(event) => {
              const value = event.currentTarget.value;
              if (isHubKioskChime(value)) void updateHubKioskSoundSettings({ commonChime: value });
            }}
            disabled={working || hubRuntime.status !== 'ready' || hubRuntimeDirty()}
          >
            {#each hubChimeOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <button
          class="btn"
          onclick={() => playHubChime(hubSoundSettings.commonChime, hubSoundSettings.volume)}
          disabled={hubSoundSettings.muted || hubSoundSettings.volume === 0 || hubSoundSettings.commonChime === 'none'}
        >Preview common chime</button>
      </section>
    {/if}

    {#if session.role === 'tic'}
      <section class="card" aria-labelledby="concern-routing-heading">
        <p class="eyebrow">Concern privacy</p>
        <h2 id="concern-routing-heading">Inform the Hub routing policy</h2>
        <p class="muted small">Choose which concern routes classroom staff may use and set the suggested default. The sender and TIC can always read a concern; other staff can read it only when selected as recipients.</p>
        <fieldset class="routing-options">
          <legend>Available routes</legend>
          <label><input type="checkbox" checked={concernPolicy.availableScopes.includes('tic')} onchange={(event) => setConcernScopeAvailable('tic', event.currentTarget.checked)} /> TIC only</label>
          <label><input type="checkbox" checked={concernPolicy.availableScopes.includes('all-staff')} onchange={(event) => setConcernScopeAvailable('all-staff', event.currentTarget.checked)} /> All staff</label>
          <label><input type="checkbox" checked={concernPolicy.availableScopes.includes('selected')} onchange={(event) => setConcernScopeAvailable('selected', event.currentTarget.checked)} /> Choose staff</label>
        </fieldset>
        <label class="field" for="concern-default-route">
          Default route
          <select id="concern-default-route" bind:value={concernPolicy.defaultScope}>
            {#if concernPolicy.availableScopes.includes('tic')}<option value="tic">TIC only</option>{/if}
            {#if concernPolicy.availableScopes.includes('all-staff')}<option value="all-staff">All staff</option>{/if}
            {#if concernPolicy.availableScopes.includes('selected')}<option value="selected">Choose staff</option>{/if}
          </select>
        </label>
        <button class="btn btn-primary" onclick={saveConcernPolicy} disabled={working || !concernPolicy.availableScopes.length}>Save routing policy</button>
      </section>

      <section class="card" aria-labelledby="backup-heading">
        <div class="card-title">
          <div><p class="eyebrow">Automatic recovery</p><h2 id="backup-heading">Backup health</h2></div>
          <button class="btn btn-primary" onclick={runBackup} disabled={working}>Run backup cycle</button>
        </div>
        {#if backupHealth}
          <div class="status-grid">
            <div><span>Backup encryption</span><strong class:status-ok={backupHealth.encryption.status === 'enabled'} class:status-warn={backupHealth.encryption.status !== 'enabled'}>{backupHealth.encryption.status.replaceAll('_', ' ')}</strong><small>{backupHealth.encryption.status === 'enabled' ? `Key ${backupHealth.encryption.keyId} · ${backupHealth.encryption.legacyUnencryptedBackups} unencrypted legacy backups` : backupHealth.encryption.status === 'disabled' ? 'Set a protected Host key before using real student data.' : `${backupHealth.encryption.unavailableEncryptedBackups} encrypted backups cannot be restored with the current key.`}</small></div>
            <div><span>Local snapshots</span><strong class:status-ok={backupHealth.local.status === 'healthy'} class:status-warn={backupHealth.local.status !== 'healthy'}>{backupHealth.local.status}</strong><small>Every {backupHealth.localSnapshotIntervalMinutes} minutes · latest {formatDate(backupHealth.local.latestSnapshotAt)}</small>{#if backupHealth.local.error}<p class="alert error">{backupHealth.local.error}</p>{/if}</div>
            <div><span>Off-host copy</span><strong class:status-ok={backupHealth.offHost.status === 'healthy'} class:status-warn={backupHealth.offHost.status !== 'healthy'}>{backupHealth.offHost.status.replaceAll('_', ' ')}</strong><small>{backupHealth.offHost.pendingCopies} pending · latest {formatDate(backupHealth.offHost.latestCopyAt)} · save-to-copy lag {formatLag(backupHealth.offHost.latestCopyLagMs)}</small>{#if backupHealth.offHost.error}<p class="alert error">{backupHealth.offHost.error}</p>{/if}</div>
            <div><span>Isolated restore test</span><strong class:status-ok={backupHealth.restoreTest.status === 'healthy'} class:status-warn={backupHealth.restoreTest.status !== 'healthy'}>{backupHealth.restoreTest.status.replaceAll('_', ' ')}</strong><small>Last test {formatDate(backupHealth.restoreTest.lastTestAt)}</small>{#if backupHealth.restoreTest.error}<p class="alert error">{backupHealth.restoreTest.error}</p>{/if}</div>
            <div><span>Retention</span><strong>{backupHealth.retention}</strong><small>No automatic deletion</small></div>
          </div>
          <p class="muted small">Independent storage is not verified by the Host. ICT must approve the actual destination and records retention rule.</p>
          <ul class="destination-list">
            {#each backupHealth.offHost.destinations as destination (destination.role)}
              <li><div><strong>{destination.role === 'preferred' ? 'Preferred destination' : 'Fallback destination'}</strong><code>{destination.path ?? 'Not configured'}</code>{#if destination.error}<small class="status-warn">{destination.error}</small>{/if}</div><span>{destination.status.replaceAll('_', ' ')} · {destination.pendingCopies} pending · lag {formatLag(destination.latestCopyLagMs)}</span></li>
            {/each}
          </ul>
        {:else}
          <p class="muted">Backup health is loading or unavailable.</p>
        {/if}
      </section>

      {#if session.role === 'tic'}
        <section class="card" aria-labelledby="ea-password-heading">
          <p class="eyebrow">Staff authentication</p>
          <h2 id="ea-password-heading">Shared EA Password</h2>
          <p class="muted small">Set a shared password that all EAs and staff will use for sign-in. This eliminates the need for time-limited invitation codes.</p>
          <div class="setting-row">
            <label>Shared EA Password
              <input type="password" id="ea-password-input" bind:value={eaPassword} style="max-width:200px" />
            </label>
          </div>
          <div class="setting-row">
            <label></label>
            <button class="btn btn-primary" onclick={setEAPassword} disabled={working}>Set EA Password</button>
          </div>
          {#if eaPasswordSet}
            <p class="muted small">EA Password configured. All staff can now sign in using this password.</p>
          {/if}
        </section>
      {/if}

      <section class="card" aria-labelledby="restore-heading">
        <p class="eyebrow">Recovery</p><h2 id="restore-heading">Restore points</h2>
        <p class="muted small">A restore is staged and checked before promotion. The live snapshot is replaced only after a separate TIC confirmation.</p>
        {#if restorePoints.length}
          <div class="restore-list">
            {#each restorePoints.slice().reverse() as point (point.backupId)}
              <article class="restore-point">
                <div><strong>{formatDate(point.createdAt)}</strong><span>Revision {point.revision} · schema {point.schemaVersion} · {point.kind.replaceAll('_', ' ')}</span><small>{point.staffName ? `Saved by ${point.staffName}${point.staffRole ? ` · ${point.staffRole.toUpperCase()}` : ''} · ` : ''}{Object.entries(point.recordCounts).map(([key, value]) => `${key}: ${value}`).join(' · ')}</small>{#if point.error}<small class="status-warn">{point.error}</small>{/if}</div>
                <button class="btn" onclick={() => stageBackup(point.backupId)} disabled={working || !point.restorable || !point.checksumValid}>Preview restore</button>
              </article>
            {/each}
          </div>
        {:else}
          <p class="muted">No local restore points are available yet.</p>
        {/if}
        {#if stagedRestore}
          <div class="restore-preview">
            <h3>Restore preview</h3>
            <p>Backup from {formatDate(stagedRestore.preview.backupCreatedAt)}, revision {stagedRestore.preview.snapshotRevision}. Integrity and account checksum passed.</p>
            <p class="status-warn">Promoting this restore replaces the current Hub account snapshot. The Host will first create a pre-restore copy and audit record.</p>
            <label class="acknowledge"><input type="checkbox" bind:checked={confirmRestore} />I have reviewed this restore point and want to replace the current Host snapshot.</label>
            <div class="actions"><button class="btn" onclick={() => { stagedRestore = null; confirmRestore = false; }}>Cancel</button><button class="btn btn-danger solid" onclick={promoteRestore} disabled={working || !confirmRestore}>Promote restore</button></div>
          </div>
        {/if}
      </section>

      <section class="card" aria-labelledby="invite-heading">
        <p class="eyebrow">Staff access</p><h2 id="invite-heading">Create a staff invitation</h2>
        <p class="muted small">Entra invitations are linked to the staff member's school email. Named-profile invitations use a one-time code and a TIC-assigned role. This sign-in does not verify staff identity or provide MFA.</p>
        <div class="invite-form">
          <label for="invite-role">Role</label>
          <select id="invite-role" bind:value={invitedRole}><option value="ea">EA staff</option><option value="tic">Teacher-in-Charge</option></select>
          <label for="invite-profile">Link existing profile <span class="muted">(optional)</span></label>
          <select id="invite-profile" value={invitedProfileId} onchange={selectExistingProfile}><option value="">Create a new profile</option>{#each staffProfiles.filter((profile) => !profile.authMethod.includes('entra')) as profile (profile.id)}<option value={profile.id}>{profile.displayName} · {profile.role === 'tic' ? 'TIC' : 'EA'} · {profile.authMethod.includes('fallback') ? 'fallback' : 'staff profile'}</option>{/each}</select>
          <label for="invite-method">Sign-in method</label>
          <select id="invite-method" bind:value={invitationAuthMode}><option value="entra">Microsoft Entra</option>{#if fallbackEnabled}<option value="fallback">Named profile</option>{/if}</select>
          {#if invitationAuthMode === 'entra'}
            <label for="invite-email">School email for Entra sign-in</label>
            <input id="invite-email" type="email" autocomplete="off" bind:value={invitedEmail} />
          {:else}
            <span class="muted small">No email is stored. This invitation does not provide identity verification or MFA.</span>
          {/if}
          <button class="btn btn-primary" onclick={issueInvitation} disabled={working || (invitationAuthMode === 'entra' && !invitedEmail.trim())}>Create {invitationAuthMode === 'entra' ? 'Entra' : 'named-profile'} invitation</button>
        </div>
        {#if issuedInvitation}
          <div class="invitation-result" role="status">
            <strong>One-time invitation for {issuedInvitation.invitedEmail}</strong>
            <p>Expires {formatDate(issuedInvitation.expiresAt)}. Share this token only through an ICT-approved channel. Named-profile sign-in does not verify staff identity or provide MFA.</p>
            <code>{issuedInvitation.token}</code>
          </div>
        {/if}
      </section>
    {:else}
      <section class="card"><p class="eyebrow">Limited access</p><h2>Staff session active</h2><p class="muted">TIC access is required to view backup health, restore points, or issue invitations.</p></section>
    {/if}
  {/if}

  <footer><a href="/">Return to Happy Hallways</a></footer>
</main>

<style>
  .host-page { width: min(920px, calc(100% - 32px)); margin: 28px auto 64px; display: grid; gap: 18px; }
  .host-head { display: grid; gap: 24px; padding: 10px 4px 4px; }
  .brand { display: inline-flex; align-items: center; gap: 8px; width: fit-content; color: var(--text); font-size: 16px; font-weight: 800; text-decoration: none; }
  .host-head h1 { margin: 3px 0 5px; }
  .card { display: grid; gap: 14px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
  .card-title, .staff-session { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .card-title h2, .staff-session h2 { margin-top: 3px; }
  .status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .status-grid > div { display: grid; gap: 2px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
  .status-grid span, .restore-point span, .restore-point small, .status-grid small { color: var(--muted); font-size: 13px; }
  .status-grid strong { text-transform: capitalize; }
  .status-ok { color: var(--accent); }
  .status-warn { color: var(--warn); }
  .sign-in-block, .fallback { display: grid; gap: 10px; }
  .sign-in-block label, .fallback label, .invite-form label { font-size: 13px; font-weight: 700; }
  input, select { min-height: 40px; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface); }
  .fallback { margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--border); }
  .fallback summary { width: fit-content; color: var(--accent); font-weight: 700; cursor: pointer; }
  .alert { padding: 12px 14px; border-radius: 8px; }
  .error { color: var(--danger); background: var(--danger-wash); }
  .notice { color: var(--accent); background: var(--accent-wash); }
  .notice-text { padding: 10px; border-radius: 8px; background: var(--warn-wash); }
  .destination-list, .restore-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .destination-list li, .restore-point { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 0; border-top: 1px solid var(--border); }
  .destination-list span { color: var(--muted); font-size: 13px; }
  .destination-list code { overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }
  .restore-point > div { display: grid; gap: 2px; min-width: 0; }
  .restore-point small { overflow-wrap: anywhere; }
  .restore-preview, .invitation-result { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface-sunk); }
  .prompt-override-form { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); align-items: center; gap: 10px 14px; }
  .prompt-override-form select, .prompt-override-form textarea { box-sizing: border-box; width: 100%; padding: 9px; border: 1px solid var(--border-strong); border-radius: 8px; font: inherit; }
  .prompt-override-form button { grid-column: 2; justify-self: start; }
  .session-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .kiosk-activation-label { font-size: 13px; font-weight: 700; }
  .kiosk-activation-link { flex: 1 1 320px; min-width: 0; }
  .acknowledge { display: flex; align-items: flex-start; gap: 8px; font-weight: 700; }
  .acknowledge input { width: 18px; height: 18px; min-height: 18px; accent-color: var(--accent); }
  .routing-options { display: grid; gap: 8px; margin: 0 0 14px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
  .routing-options label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .routing-options input { width: 18px; height: 18px; min-height: 18px; accent-color: var(--accent); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .invite-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; gap: 8px; }
  .invite-form button { grid-column: 1 / -1; }
  .invitation-result code { padding: 10px; overflow-wrap: anywhere; border-radius: 6px; background: var(--surface); user-select: all; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; width: fit-content; min-height: 38px; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--surface); color: var(--text); font-weight: 700; text-decoration: none; cursor: pointer; }
  .btn:disabled { opacity: .55; cursor: not-allowed; }
  .btn-primary { border-color: var(--accent); background: var(--accent); color: white; }
  .btn-danger { border-color: var(--danger); color: var(--danger); }
  .btn-danger.solid { background: var(--danger); color: white; }
  footer { padding: 4px; }
  @media (max-width: 650px) { .status-grid { grid-template-columns: 1fr; } .card-title, .staff-session, .restore-point { align-items: stretch; flex-direction: column; } .invite-form, .prompt-override-form { grid-template-columns: 1fr; } .invite-form button, .prompt-override-form button { grid-column: auto; margin-top: 4px; } }
</style>
