<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import BrandMark from '#lib/BrandMark.svelte';
  import { playHubChime, playHubNotificationChime, prepareHubAudio } from '../../lib/sound';
  import {
    isHubKioskChime,
    type HubKioskSoundSettings,
    type HubPromptStage,
    type HubVisitPrompt,
  } from '../../lib/types';

  type HubKioskStudent = {
    id: string;
    studentName: string;
    status:
      | 'in-class'
      | 'on-the-way'
      | 'at-hub'
      | 'on-temporary-trip'
      | 'left-hub-awaiting-class'
      | 'needs-staff';
    pinRequired: boolean;
    visitId?: string;
    destinationLabel?: string;
    temporaryTripId?: string;
    temporaryTripLabel?: string;
    promptVersion?: number;
    arrivalPrompts?: HubVisitPrompt[];
    departurePrompts?: HubVisitPrompt[];
  };

  type HubKioskDestination = {
    id: string;
    label: string;
    promptVersion: number;
    arrivalPrompts: HubVisitPrompt[];
  };

  type HubKioskState = {
    revision: number;
    savedAt: string | null;
    students: HubKioskStudent[];
    destinations: HubKioskDestination[];
    temporaryDestinations: HubKioskDestination[];
    soundSettings: HubKioskSoundSettings;
    promptOverrides: {
      studentId: string;
      destinationId: string;
      stage: HubPromptStage;
    }[];
  };

  type HubKioskMovement =
    | { action: 'arrive' | 'leave' | 'temporary-return'; visitId: string }
    | { action: 'direct-arrive'; studentId: string; destinationId: string }
    | { action: 'temporary-start'; visitId: string; destinationId: string };

  let students = $state<HubKioskStudent[]>([]);
  let destinations = $state<HubKioskDestination[]>([]);
  let temporaryDestinations = $state<HubKioskDestination[]>([]);
  let revision = $state(0);
  let loading = $state(true);
  let connected = $state(false);
  let soundSettings = $state<HubKioskSoundSettings>({
    muted: false,
    volume: 70,
    commonChime: 'soft',
  });
  let promptOverrides = $state<HubKioskState['promptOverrides']>([]);
  let hasLoadedState = false;
  let activationRequired = $state(false);
  let error = $state('');
  let notice = $state('');
  let search = $state('');
  let selectedStudentId = $state('');
  let selectedDestinationId = $state('');
  let workingStudentId = $state('');
  let pins = $state<Record<string, string>>({});
  let promptMovement = $state<HubKioskMovement | null>(null);
  let promptStage = $state<HubPromptStage | null>(null);
  let promptVersion = $state<number | undefined>(undefined);
  let promptList = $state<HubVisitPrompt[]>([]);
  let promptAnswers = $state<Record<string, string | number>>({});
  const selectedDestination = $derived(
    destinations.find((destination) => destination.id === selectedDestinationId) ?? null,
  );
  const visibleStudents = $derived(
    students.filter((student) =>
      student.studentName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    ),
  );
  const selectedStudent = $derived(
    students.find((student) => student.id === selectedStudentId) ?? null,
  );

  async function loadState() {
    try {
      const response = await fetch('/api/v1/kiosk/state', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 401) {
        connected = false;
        activationRequired = true;
        error = '';
        return;
      }
      const result = await response.json();
      if (!response.ok) {
        throw new Error('The Hub Host could not load kiosk status.');
      }
      const state = result as HubKioskState;
      const newClassroomNotification =
        hasLoadedState &&
        !state.soundSettings.muted &&
        state.soundSettings.volume > 0 &&
        state.students.some(
          (student) =>
            student.status === 'on-the-way' &&
            !students.some(
              (previous) =>
                previous.status === 'on-the-way' &&
                previous.visitId === student.visitId,
            ),
        );
      students = state.students;
      destinations = state.destinations;
      temporaryDestinations = state.temporaryDestinations;
      soundSettings = state.soundSettings;
      promptOverrides = state.promptOverrides;
      revision = state.revision;
      connected = true;
      activationRequired = false;
      error = '';
      if (newClassroomNotification) {
        playHubNotificationChime(state.soundSettings.volume);
      }
      hasLoadedState = true;
    } catch (problem) {
      connected = false;
      error =
        problem instanceof Error
          ? problem.message
          : 'The Hub Host could not be reached. Ask staff for help.';
    } finally {
      loading = false;
    }
  }

  async function recordAction(
    student: HubKioskStudent,
    movement: HubKioskMovement,
    version?: number,
    answers?: Record<string, string | number>,
  ) {
    if (!connected || workingStudentId) return;
    if (student.pinRequired && !/^\d{3,6}$/.test(pins[student.id] ?? '')) {
      error = 'Enter your PIN to continue.';
      return;
    }
    workingStudentId = student.id;
    error = '';
    notice = '';
    try {
      const response = await fetch('/api/v1/kiosk/movements', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          ...movement,
          ...(['arrive', 'leave', 'direct-arrive'].includes(movement.action)
            ? {
                ...(version !== undefined ? { promptVersion: version } : {}),
                ...(answers !== undefined ? { promptAnswers: answers } : {}),
              }
            : {}),
          ...(student.pinRequired ? { pin: pins[student.id] } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (result.error === 'invalid_student_pin') {
          error = 'That PIN did not match. Check it and try again.';
        } else if (result.error === 'required_hub_prompt_missing') {
          promptMovement = null;
          promptAnswers = {};
          await loadState();
          error = 'The Host requires an answer to each required question. Review the current questions and try again.';
        } else if (result.error === 'hub_prompt_configuration_changed') {
          promptMovement = null;
          promptAnswers = {};
          await loadState();
          error = 'The Hub questions changed. Review the updated questions and try again.';
        } else if (result.error === 'invalid_hub_prompt_response') {
          error = 'One or more answers could not be accepted. Please review them.';
        } else if (response.status === 401) {
          connected = false;
          activationRequired = true;
          error = 'This kiosk session has expired. Ask staff to restart the kiosk.';
        } else {
          error = 'The action was not accepted. Ask Hub staff for help.';
        }
        return;
      }
      if (result.accepted !== true || !Number.isSafeInteger(result.revision)) {
        throw new Error('The Hub Host did not confirm this action.');
      }
      revision = result.revision;
      promptMovement = null;
      promptAnswers = {};
      promptList = [];
      promptStage = null;
      promptVersion = undefined;
      if (
        isHubKioskChime(result.chime) &&
        !soundSettings.muted &&
        soundSettings.volume > 0
      ) {
        playHubChime(result.chime, soundSettings.volume);
      }
      const defaultNotice = {
        arrive: 'Your arrival was saved by the Hub Host.',
        'direct-arrive': 'Your Hub sign-in was saved by the Hub Host.',
        'temporary-start': 'Your Temporary Trip was saved by the Hub Host.',
        'temporary-return': 'Your return to the Hub was saved by the Hub Host.',
        leave: 'Leaving the Hub was saved. Your class return is not confirmed here.',
      }[movement.action];
      notice =
        (movement.action === 'arrive' || movement.action === 'direct-arrive') &&
        typeof result.confirmationMessage === 'string'
          ? result.confirmationMessage
          : defaultNotice;
      pins[student.id] = '';
      await loadState();
    } catch (problem) {
      error =
        problem instanceof Error
          ? problem.message
          : 'The Hub Host did not confirm this action.';
    } finally {
      workingStudentId = '';
    }
  }

  function displayStatus(student: HubKioskStudent) {
    switch (student.status) {
      case 'in-class':
        return 'In class';
      case 'on-the-way':
        return `On the way to the Hub${student.destinationLabel ? ` · ${student.destinationLabel}` : ''}`;
      case 'at-hub':
        return `At the Hub${student.destinationLabel ? ` · ${student.destinationLabel}` : ''}`;
      case 'on-temporary-trip':
        return `On a Temporary Trip${student.temporaryTripLabel ? ` · ${student.temporaryTripLabel}` : ''}`;
      case 'left-hub-awaiting-class':
        return 'Left the Hub · awaiting class return';
      case 'needs-staff':
        return 'Ask staff for help';
    }
  }

  function selectStudent(student: HubKioskStudent) {
    selectedStudentId = student.id;
    selectedDestinationId = '';
    error = '';
    notice = '';
    promptMovement = null;
    promptAnswers = {};
    pins[student.id] = '';
  }

  function beginPromptAction(
    student: HubKioskStudent,
    movement: HubKioskMovement,
    stage: HubPromptStage,
    prompts: HubVisitPrompt[],
    version?: number,
  ) {
    error = '';
    notice = '';
    if (!prompts.length) {
      void recordAction(student, movement, version, {});
      return;
    }
    promptMovement = movement;
    promptStage = stage;
    promptVersion = version;
    promptList = prompts;
    promptAnswers = {};
  }

  function promptsForStudent(
    student: HubKioskStudent,
    destinationId: string,
    stage: HubPromptStage,
    prompts: HubVisitPrompt[],
  ) {
    const overridden = promptOverrides.some(
      (override) =>
        override.studentId === student.id &&
        override.destinationId === destinationId &&
        override.stage === stage,
    );
    return overridden
      ? prompts.map((prompt) => ({ ...prompt, required: false }))
      : prompts;
  }

  function setRatingAnswer(promptId: string, value: number) {
    promptAnswers = { ...promptAnswers, [promptId]: value };
  }

  function submitPromptAction(student: HubKioskStudent) {
    if (!promptMovement) return;
    const missing = promptList.some((prompt) => {
      if (!prompt.required) return false;
      const answer = promptAnswers[prompt.id];
      return (
        answer === undefined ||
        (typeof answer === 'string' && !answer.trim())
      );
    });
    if (missing) {
      error = 'Answer each required question before continuing.';
      return;
    }
    void recordAction(
      student,
      promptMovement,
      promptVersion,
      promptAnswers,
    );
  }

  function cancelPromptAction() {
    promptMovement = null;
    promptStage = null;
    promptVersion = undefined;
    promptList = [];
    promptAnswers = {};
    error = '';
  }

  async function activateFromLink() {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('activate');
    if (!token) {
      await loadState();
      return;
    }

    await goto('/hub-kiosk', {
      replace: true,
      shallow: true,
      state: page.state,
    });
    try {
      const response = await fetch('/api/v1/kiosk/activate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ token }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 409) {
        activationRequired = true;
        error = 'Open this link in a separate kiosk browser profile, not a signed-in staff browser.';
        return;
      }
      if (!response.ok) {
        activationRequired = true;
        error = response.status === 401
          ? 'This activation link is expired or has already been used. Ask a TIC to create a new link.'
          : 'The Hub Host did not activate this kiosk. Ask staff for help.';
        return;
      }
      if (typeof result.expiresAt !== 'string') {
        throw new Error('The Hub Host did not confirm kiosk activation.');
      }
      await loadState();
    } catch (problem) {
      activationRequired = true;
      error = problem instanceof Error
        ? problem.message
        : 'The Hub Host did not confirm kiosk activation.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void activateFromLink();
    const timer = window.setInterval(() => {
      if (!activationRequired) void loadState();
    }, 2500);
    return () => window.clearInterval(timer);
  });
</script>

<svelte:head>
  <title>Hub Kiosk | Happy Hallways</title>
  <meta name="description" content="Student Hub arrival and departure kiosk." />
</svelte:head>

<main class="kiosk" onpointerdown={prepareHubAudio}>
  <header class="kiosk-head">
    <a class="brand" href="/" aria-label="Happy Hallways"><BrandMark />Happy Hallways</a>
    <div>
      <p class="eyebrow">Learning Support Hub</p>
      <h1>Tap your name</h1>
      <p class="muted">Sign in, choose a Temporary Destination, or leave the Hub.</p>
    </div>
    <p class="connection" class:offline={!connected} role="status">
      <span aria-hidden="true"></span>{connected ? 'Connected to Hub Host' : 'Not connected'}
    </p>
  </header>

  {#if error}<p class="message error" role="alert">{error}</p>{/if}
  {#if notice}<p class="message success" role="status">{notice}</p>{/if}

  {#if loading}
    <section class="empty" aria-live="polite"><p>Connecting to the Hub Host…</p></section>
  {:else if activationRequired}
    <section class="empty">
      <h2>Hub kiosk needs activation</h2>
      <p>Ask a Teacher-in-Charge to create an activation link and open it in this kiosk browser profile.</p>
    </section>
  {:else}
    <section class="student-board" aria-label="Student sign-in">
      <label class="student-search">
        Find your name
        <input type="search" bind:value={search} autocomplete="off" />
      </label>
      {#if visibleStudents.length}
        <div class="student-grid">
          {#each visibleStudents as student (student.id)}
            <button
              type="button"
              class="student-card"
              class:selected={selectedStudentId === student.id}
              data-status={student.status}
              aria-pressed={selectedStudentId === student.id}
              onclick={() => selectStudent(student)}
            >
              <strong>{student.studentName}</strong>
              <span>{displayStatus(student)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty">
          <h2>{students.length ? 'No names match your search' : 'No students are available'}</h2>
          <p>Ask Hub staff for help if you cannot find your name.</p>
        </div>
      {/if}
    </section>

    {#if selectedStudent}
      <section class="action-panel" aria-labelledby="selected-student">
        <div class="action-head">
          <div>
            <p class="eyebrow">Your Hub status</p>
            <h2 id="selected-student">{selectedStudent.studentName}</h2>
            <p class="muted">{displayStatus(selectedStudent)}</p>
          </div>
          <button type="button" class="btn" onclick={() => (selectedStudentId = '')}>Choose another name</button>
        </div>

        {#if selectedStudent.pinRequired && ['in-class', 'on-the-way', 'at-hub', 'on-temporary-trip'].includes(selectedStudent.status)}
          <label class="pin-entry" for={`pin-${selectedStudent.id}`}>
            Student PIN
            <input
              id={`pin-${selectedStudent.id}`}
              type="password"
              inputmode="numeric"
              autocomplete="off"
              maxlength="6"
              aria-label={`Student PIN for ${selectedStudent.studentName}`}
              bind:value={pins[selectedStudent.id]}
              disabled={!connected || !!workingStudentId}
            />
          </label>
        {/if}

        {#if selectedStudent.status === 'in-class'}
          <div class="destination-choice">
            <h3>Choose your Hub destination</h3>
            {#if destinations.length}
              <div class="destination-grid">
                {#each destinations as destination (destination.id)}
                  <button
                    type="button"
                    class="destination-button"
                    aria-pressed={selectedDestinationId === destination.id}
                    disabled={!connected || !!workingStudentId}
                    onclick={() => (selectedDestinationId = destination.id)}
                  >{destination.label}</button>
                {/each}
              </div>
              <button
                type="button"
                class="btn primary"
                disabled={!connected || !!workingStudentId || !!promptMovement || !selectedDestinationId}
                onclick={() => {
                  if (selectedDestination) {
                    beginPromptAction(
                      selectedStudent,
                      {
                        action: 'direct-arrive',
                        studentId: selectedStudent.id,
                        destinationId: selectedDestination.id,
                      },
                      'arrival',
                      promptsForStudent(
                        selectedStudent,
                        selectedDestination.id,
                        'arrival',
                        selectedDestination.arrivalPrompts,
                      ),
                      selectedDestination.promptVersion,
                    );
                  }
                }}
              >{workingStudentId === selectedStudent.id ? 'Saving…' : 'Sign in at the Hub'}</button>
            {:else}
              <p class="muted">No Hub destinations are enabled. Ask Hub staff for help.</p>
            {/if}
          </div>
        {:else if selectedStudent.status === 'on-the-way' && selectedStudent.visitId}
          <button
            type="button"
            class="btn primary"
            disabled={!connected || !!workingStudentId || !!promptMovement}
            onclick={() => beginPromptAction(
              selectedStudent,
              { action: 'arrive', visitId: selectedStudent.visitId! },
              'arrival',
              selectedStudent.arrivalPrompts ?? [],
              selectedStudent.promptVersion,
            )}
          >{workingStudentId === selectedStudent.id ? 'Saving…' : 'Sign in at the Hub'}</button>
        {:else if selectedStudent.status === 'at-hub' && selectedStudent.visitId}
          <div class="visit-options">
            <section class="option-group">
              <h3>Temporary Destination</h3>
              {#if temporaryDestinations.length}
                <div class="destination-grid">
                  {#each temporaryDestinations as destination (destination.id)}
                    <button
                      type="button"
                      class="btn"
                      disabled={!connected || !!workingStudentId || !!promptMovement}
                      onclick={() => void recordAction(selectedStudent, {
                        action: 'temporary-start',
                        visitId: selectedStudent.visitId!,
                        destinationId: destination.id,
                      })}
                    >{workingStudentId === selectedStudent.id ? 'Saving…' : destination.label}</button>
                  {/each}
                </div>
              {:else}
                <p class="muted">No Temporary Destinations are enabled.</p>
              {/if}
            </section>
            <div class="divider" aria-hidden="true"></div>
            <section class="option-group">
              <h3>Leave Hub</h3>
              <p class="muted">Your class return must be confirmed separately by staff.</p>
              <button
                type="button"
                class="btn primary"
                disabled={!connected || !!workingStudentId || !!promptMovement}
                onclick={() => beginPromptAction(
                  selectedStudent,
                  { action: 'leave', visitId: selectedStudent.visitId! },
                  'departure',
                  selectedStudent.departurePrompts ?? [],
                  selectedStudent.promptVersion,
                )}
              >{workingStudentId === selectedStudent.id ? 'Saving…' : 'Leave the Hub'}</button>
            </section>
          </div>
        {:else if selectedStudent.status === 'on-temporary-trip' && selectedStudent.visitId}
          <button
            type="button"
            class="btn primary"
            disabled={!connected || !!workingStudentId || !!promptMovement}
            onclick={() => void recordAction(selectedStudent, {
              action: 'temporary-return',
              visitId: selectedStudent.visitId!,
            })}
          >{workingStudentId === selectedStudent.id ? 'Saving…' : 'I am back at the Hub'}</button>
        {:else if selectedStudent.status === 'left-hub-awaiting-class'}
          <p class="message">Your Hub visit has ended. Ask staff to confirm your return to class.</p>
        {:else if selectedStudent.status === 'needs-staff'}
          <p class="message error">Ask Hub staff for help before continuing.</p>
        {/if}

        {#if promptMovement && promptStage}
          <form
            class="prompt-form"
            aria-labelledby="hub-prompt-title"
            onsubmit={(event) => {
              event.preventDefault();
              submitPromptAction(selectedStudent);
            }}
          >
            <h3 id="hub-prompt-title">
              {promptStage === 'arrival' ? 'Before signing in' : 'Before leaving the Hub'}
            </h3>
            {#each promptList as prompt (prompt.id)}
              <fieldset class="hub-prompt">
                <legend>
                  {prompt.question}
                  <span class="muted">{prompt.required ? 'Required' : 'Optional'}</span>
                </legend>
                {#if prompt.guidance}
                  <p class="muted">{prompt.guidance}</p>
                {/if}
                {#if prompt.responseType === 'written'}
                  <textarea
                    rows="3"
                    maxlength="2000"
                    aria-label={prompt.question}
                    bind:value={promptAnswers[prompt.id]}
                    disabled={!connected || !!workingStudentId}
                  ></textarea>
                {:else}
                  <div class="rating-options" role="group" aria-label={prompt.question}>
                    {#each Array.from({ length: prompt.scaleMax ?? 5 }, (_, index) => index + 1) as rating (rating)}
                      <button
                        type="button"
                        class="rating-choice"
                        aria-pressed={promptAnswers[prompt.id] === rating}
                        aria-label={`${rating} of ${prompt.scaleMax ?? 5}`}
                        disabled={!connected || !!workingStudentId}
                        onclick={() => setRatingAnswer(prompt.id, rating)}
                      >{prompt.ratingStyle === 'stars' ? `★ ${rating}` : rating}</button>
                    {/each}
                  </div>
                  <div class="rating-labels">
                    <span>{prompt.minLabel ?? '1'}</span>
                    <span>{prompt.maxLabel ?? String(prompt.scaleMax ?? 5)}</span>
                  </div>
                {/if}
              </fieldset>
            {/each}
            <div class="prompt-actions">
              <button
                type="submit"
                class="btn primary"
                disabled={!connected || !!workingStudentId}
              >{workingStudentId === selectedStudent.id ? 'Saving…' : 'Continue'}</button>
              <button
                type="button"
                class="btn"
                disabled={!!workingStudentId}
                onclick={cancelPromptAction}
              >Cancel</button>
            </div>
          </form>
        {/if}
      </section>
    {/if}
  {/if}

  <footer>
    <span>Hub Host revision {revision}</span>
    <a href="/hub-admin">Staff access</a>
  </footer>
</main>

<style>
  .kiosk { box-sizing: border-box; width: min(100% - 32px, 1180px); min-height: 100vh; margin: auto; padding: 28px 0; display: grid; align-content: start; gap: 20px; }
  .kiosk-head { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: start; }
  .brand { display: inline-flex; align-items: center; gap: 8px; width: fit-content; color: var(--text); font-size: 15px; font-weight: 800; text-decoration: none; }
  .kiosk-head > div { grid-column: 1 / -1; }
  .eyebrow { margin: 0 0 5px; color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  h1, h2, h3, p { margin-top: 0; }
  h1 { margin-bottom: 6px; font-size: clamp(1.8rem, 5vw, 2.5rem); }
  .muted { color: var(--muted); }
  .connection { display: inline-flex; align-items: center; gap: 7px; margin: 0; font-size: 13px; font-weight: 700; }
  .connection span { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
  .connection.offline span { background: var(--danger); }
  .message { padding: 12px 14px; border-radius: 8px; }
  .error { color: var(--danger); background: var(--danger-wash); }
  .success { color: var(--accent); background: var(--accent-wash); }
  .student-board, .action-panel { display: grid; gap: 14px; }
  .student-search, .pin-entry { display: grid; gap: 6px; max-width: 420px; font-size: 13px; font-weight: 700; }
  .student-search input, .pin-entry input { min-height: 44px; padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); font-size: 16px; }
  .student-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  .student-card { display: grid; gap: 8px; min-height: 88px; padding: 15px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
  .student-card strong { font-size: 19px; }
  .student-card span { color: var(--muted); font-size: 14px; }
  .student-card[data-status="on-the-way"] { border-color: var(--border-strong); background: var(--surface-sunk); }
  .student-card[data-status="at-hub"] { border-color: var(--accent); background: var(--accent-wash); }
  .student-card[data-status="on-temporary-trip"] { border-color: var(--warn); background: var(--warn-wash); }
  .student-card[data-status="left-hub-awaiting-class"], .student-card[data-status="needs-staff"] { border-color: var(--danger); }
  .student-card.selected { outline: 3px solid var(--accent); outline-offset: 1px; }
  .student-card:focus-visible, .btn:focus-visible, .destination-button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .action-panel { padding: 18px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); }
  .action-head { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
  .action-head h2 { margin-bottom: 4px; }
  .action-head p { margin-bottom: 0; }
  .destination-choice { display: grid; gap: 12px; }
  .destination-choice h3, .option-group h3 { margin-bottom: 0; font-size: 17px; }
  .destination-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .destination-button { min-height: 44px; padding: 9px 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-weight: 700; cursor: pointer; }
  .destination-button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-wash); }
  .destination-button:disabled { opacity: .55; cursor: not-allowed; }
  .prompt-form { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface); }
  .prompt-form h3 { margin: 0; font-size: 18px; }
  .hub-prompt { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
  .hub-prompt legend { padding: 0 4px; font-weight: 700; }
  .hub-prompt legend span { margin-left: 8px; font-size: 12px; font-weight: 500; }
  .hub-prompt textarea { box-sizing: border-box; width: 100%; padding: 10px; border: 1px solid var(--border-strong); border-radius: 8px; font: inherit; }
  .rating-options { display: flex; flex-wrap: wrap; gap: 6px; }
  .rating-choice { min-width: 40px; min-height: 40px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-weight: 700; cursor: pointer; }
  .rating-choice[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-wash); }
  .rating-labels, .prompt-actions { display: flex; justify-content: space-between; gap: 8px; }
  .prompt-actions { justify-content: flex-start; }
  .visit-options { display: grid; grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr); align-items: stretch; gap: 20px; }
  .option-group { display: grid; align-content: start; gap: 12px; }
  .option-group p { margin-bottom: 0; }
  .divider { background: var(--border); }
  .btn { min-height: 44px; padding: 9px 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-weight: 800; cursor: pointer; }
  .btn.primary { border-color: var(--accent); background: var(--accent); color: white; }
  .btn:disabled { opacity: .55; cursor: not-allowed; }
  .empty { padding: 36px 20px; border: 1px dashed var(--border-strong); border-radius: var(--radius); text-align: center; }
  .empty p { margin-bottom: 0; color: var(--muted); }
  footer { display: flex; justify-content: space-between; gap: 12px; padding-top: 8px; color: var(--muted); font-size: 12px; }
  footer a { color: var(--accent); font-weight: 700; }
  @media (max-width: 600px) {
    .kiosk-head { grid-template-columns: 1fr; }
    .kiosk-head > div { grid-column: auto; }
    .action-head { align-items: stretch; flex-direction: column; }
    .visit-options { grid-template-columns: 1fr; }
    .divider { height: 1px; }
    .option-group .btn { width: 100%; }
  }
</style>
