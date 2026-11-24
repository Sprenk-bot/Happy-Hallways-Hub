<script lang="ts">
  import Modal from './Modal.svelte';
  import { account, deleteDestination, saveDestination } from './account.svelte';
  import { destinationColors, iconMatchesSearch, type DestinationColor, type DestinationIcon } from './destinations';
  import { destinationIconGroups } from './icons';
  import Icon from './Icon.svelte';
  import { newId } from './passes';
  import { hubChimeOptions, playHubChime } from './sound';
  import {
    isHubKioskChime,
    type Destination,
    type HubKioskChime,
    type HubPromptResponseType,
    type HubPromptStage,
    type HubVisitPrompt,
  } from './types';

  /** Edits one destination, or creates one when `destination` is null. */
  let { destination, onClose }: { destination: Destination | null; onClose: () => void } = $props();

  // The dialog edits a copy; nothing changes until Save.
  // svelte-ignore state_referenced_locally
  let label = $state(destination?.label ?? '');
  // A number field hands back a number, or null while it's empty.
  // svelte-ignore state_referenced_locally
  let minutes = $state<number | null>(destination?.minutes ?? null);
  // svelte-ignore state_referenced_locally
  let color = $state<DestinationColor>(destination?.color ?? 'green');
  // svelte-ignore state_referenced_locally
  let icon = $state<DestinationIcon>(destination?.icon ?? 'map-pin');
  // svelte-ignore state_referenced_locally
  let counts = $state(destination?.countsTowardAllowance !== false);
  // A new destination starts at one at a time; the teacher opens it up for places like the Nurse.
  // svelte-ignore state_referenced_locally
  let studentLimit = $state<number | null>(destination ? destination.limit : 1);
  // svelte-ignore state_referenced_locally
  let countsTowardClass = $state(destination?.countsTowardClassLimit !== false);
  // svelte-ignore state_referenced_locally
  let informHubAvailable = $state(destination?.informHubAvailable === true);
  // svelte-ignore state_referenced_locally
  let kioskAvailable = $state(destination?.kioskAvailable !== false);
  // svelte-ignore state_referenced_locally
  let temporaryTripAvailable = $state(destination?.temporaryTripAvailable === true);
  // svelte-ignore state_referenced_locally
  let kioskLabel = $state(destination?.kioskLabel ?? '');
  // svelte-ignore state_referenced_locally
  let kioskConfirmation = $state(destination?.kioskConfirmation ?? '');
  // svelte-ignore state_referenced_locally
  let hubArrivalChime = $state<HubKioskChime>(destination?.hubArrivalChime ?? 'soft');
  // svelte-ignore state_referenced_locally
  let hubTimerMinutes = $state<number | null>(destination?.hubTimerMinutes ?? null);
  // svelte-ignore state_referenced_locally
  let hubTimerWarningMinutes = $state<number | null>(destination?.hubTimerWarningMinutes ?? 2);
  // svelte-ignore state_referenced_locally
  let hubTimerStartsAfterArrivalPrompts = $state(destination?.hubTimerStartsAfterArrivalPrompts === true);
  // svelte-ignore state_referenced_locally
  let hubOverdueCountsUp = $state(destination?.hubOverdueCountsUp === true);
  // svelte-ignore state_referenced_locally
  let arrivalPrompts = $state<HubVisitPrompt[]>(destination?.hubArrivalPrompts?.map((prompt) => ({ ...prompt })) ?? []);
  // svelte-ignore state_referenced_locally
  let departurePrompts = $state<HubVisitPrompt[]>(destination?.hubDeparturePrompts?.map((prompt) => ({ ...prompt })) ?? []);
  // svelte-ignore state_referenced_locally
  let isPrivate = $state(!!destination?.private);
  /** Only the way limits work now is shown; the other way's setting is kept for if the teacher switches back. */
  const hasClassLimit = $derived(account.limitMode === 'class');
  const limitChoices = $derived([...new Set([1, 2, 3, 4, 5, 6, ...(studentLimit ? [studentLimit] : [])])].sort((a, b) => a - b));
  let error = $state('');

  const colorNames = Object.keys(destinationColors) as DestinationColor[];
  const promptStages: { stage: HubPromptStage; label: string }[] = [
    { stage: 'arrival', label: 'Arrival prompts' },
    { stage: 'departure', label: 'Departure / reflection prompts' },
  ];

  let iconSearch = $state('');
  const iconGroups = $derived(
    Object.entries(destinationIconGroups)
      .map(([group, names]) => ({ group, names: names.filter((name) => iconMatchesSearch(name, iconSearch)) }))
      .filter((entry) => entry.names.length),
  );

  function promptsFor(stage: HubPromptStage) {
    return stage === 'arrival' ? arrivalPrompts : departurePrompts;
  }

  function replacePrompts(stage: HubPromptStage, prompts: HubVisitPrompt[]) {
    if (stage === 'arrival') arrivalPrompts = prompts;
    else departurePrompts = prompts;
  }

  function updatePrompt(
    stage: HubPromptStage,
    id: string,
    changes: Partial<HubVisitPrompt>,
  ) {
    replacePrompts(
      stage,
      promptsFor(stage).map((prompt) =>
        prompt.id === id ? { ...prompt, ...changes } : prompt,
      ),
    );
  }

  function addPrompt(stage: HubPromptStage) {
    const prompts = promptsFor(stage);
    if (prompts.length >= 8) return;
    replacePrompts(stage, [
      ...prompts,
      {
        id: newId(),
        question: '',
        responseType: 'written',
        required: false,
      },
    ]);
  }

  function removePrompt(stage: HubPromptStage, id: string) {
    replacePrompts(stage, promptsFor(stage).filter((prompt) => prompt.id !== id));
  }

  function movePrompt(stage: HubPromptStage, index: number, direction: -1 | 1) {
    const prompts = [...promptsFor(stage)];
    const destinationIndex = index + direction;
    if (destinationIndex < 0 || destinationIndex >= prompts.length) return;
    [prompts[index], prompts[destinationIndex]] = [
      prompts[destinationIndex],
      prompts[index],
    ];
    replacePrompts(stage, prompts);
  }

  function setPromptResponseType(
    stage: HubPromptStage,
    id: string,
    value: string,
  ) {
    if (value !== 'written' && value !== 'rating') return;
    const responseType: HubPromptResponseType = value;
    updatePrompt(stage, id, {
      responseType,
      ...(responseType === 'rating'
        ? { scaleMax: 5, ratingStyle: 'numbers' }
        : {}),
    });
  }

  function normalizePrompts(prompts: HubVisitPrompt[]) {
    return prompts.map((prompt) => ({
      id: prompt.id,
      question: prompt.question.trim(),
      ...(prompt.guidance?.trim()
        ? { guidance: prompt.guidance.trim() }
        : {}),
      responseType: prompt.responseType,
      required: prompt.required,
      ...(prompt.responseType === 'rating'
        ? {
            scaleMax: prompt.scaleMax ?? 5,
            ratingStyle: prompt.ratingStyle ?? 'numbers',
            ...(prompt.minLabel?.trim()
              ? { minLabel: prompt.minLabel.trim() }
              : {}),
            ...(prompt.maxLabel?.trim()
              ? { maxLabel: prompt.maxLabel.trim() }
              : {}),
          }
        : {}),
    })) satisfies HubVisitPrompt[];
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const name = label.trim();
    const limit = typeof minutes === 'number' && !Number.isNaN(minutes) ? Math.round(minutes) : null;
    if (!name) {
      error = 'Give the destination a name.';
      return;
    }
    if (account.destinations.some((each) => each.id !== destination?.id && each.label.toLowerCase() === name.toLowerCase())) {
      error = `There's already a destination called ${name}.`;
      return;
    }
    if (limit !== null && !(limit >= 1 && limit <= 120)) {
      error = 'Minutes should be between 1 and 120, or left empty for no time limit.';
      return;
    }
    if (kioskLabel.trim().length > 60) {
      error = 'The student-facing label must be 60 characters or fewer.';
      return;
    }
    if (kioskConfirmation.trim().length > 160) {
      error = 'The Hub kiosk confirmation must be 160 characters or fewer.';
      return;
    }
    const timerMinutes = typeof hubTimerMinutes === 'number' && !Number.isNaN(hubTimerMinutes) ? Math.round(hubTimerMinutes) : null;
    if (timerMinutes !== null && (timerMinutes < 1 || timerMinutes > 240)) {
      error = 'The Hub timer must be between 1 and 240 minutes, or left empty for no timer.';
      return;
    }
    for (const prompt of [...arrivalPrompts, ...departurePrompts]) {
      if (!prompt.question.trim() || prompt.question.trim().length > 240) {
        error = 'Each Hub prompt needs a question of 1–240 characters.';
        return;
      }
      if ((prompt.guidance?.trim().length ?? 0) > 240) {
        error = 'Prompt guidance must be 240 characters or fewer.';
        return;
      }
      if (
        prompt.responseType === 'rating' &&
        prompt.scaleMax !== undefined &&
        prompt.scaleMax !== 5 &&
        prompt.scaleMax !== 10
      ) {
        error = 'A rating scale must use 1–5 or 1–10.';
        return;
      }
      if (
        (prompt.minLabel?.trim().length ?? 0) > 60 ||
        (prompt.maxLabel?.trim().length ?? 0) > 60
      ) {
        error = 'Rating labels must be 60 characters or fewer.';
        return;
      }
    }
    // A Private destination never has a limit or a line (docs/adr/0021).
    const saved: Destination = { id: destination?.id ?? newId(), label: name, minutes: limit, color, icon, limit: isPrivate ? null : studentLimit };
    const savedArrivalPrompts = normalizePrompts(arrivalPrompts);
    const savedDeparturePrompts = normalizePrompts(departurePrompts);
    const promptsChanged =
      JSON.stringify(savedArrivalPrompts) !==
        JSON.stringify(destination?.hubArrivalPrompts ?? []) ||
      JSON.stringify(savedDeparturePrompts) !==
        JSON.stringify(destination?.hubDeparturePrompts ?? []);
    const hasPromptConfiguration =
      savedArrivalPrompts.length > 0 ||
      savedDeparturePrompts.length > 0 ||
      destination?.hubPromptVersion !== undefined;
    if (hasPromptConfiguration) {
      saved.hubPromptVersion = destination
        ? (destination.hubPromptVersion ?? 1) + (promptsChanged ? 1 : 0)
        : 1;
    }
    if (savedArrivalPrompts.length) {
      saved.hubArrivalPrompts = savedArrivalPrompts;
    } else {
      delete saved.hubArrivalPrompts;
    }
    if (savedDeparturePrompts.length) {
      saved.hubDeparturePrompts = savedDeparturePrompts;
    } else {
      delete saved.hubDeparturePrompts;
    }
    if (!counts) saved.countsTowardAllowance = false;
    if (!countsTowardClass || isPrivate) saved.countsTowardClassLimit = false;
    if (isPrivate) saved.private = true;
    if (informHubAvailable) saved.informHubAvailable = true;
    else delete saved.informHubAvailable;
    if (!kioskAvailable) saved.kioskAvailable = false;
    else delete saved.kioskAvailable;
    if (kioskAvailable && temporaryTripAvailable) saved.temporaryTripAvailable = true;
    else delete saved.temporaryTripAvailable;
    const safeKioskLabel = kioskLabel.trim();
    if (isPrivate && safeKioskLabel) saved.kioskLabel = safeKioskLabel;
    else delete saved.kioskLabel;
    const safeKioskConfirmation = kioskConfirmation.trim();
    if (safeKioskConfirmation) saved.kioskConfirmation = safeKioskConfirmation;
    else delete saved.kioskConfirmation;
    if (hubArrivalChime !== 'soft') saved.hubArrivalChime = hubArrivalChime;
    else delete saved.hubArrivalChime;
    if (timerMinutes !== null) saved.hubTimerMinutes = timerMinutes;
    const warningMinutes = typeof hubTimerWarningMinutes === 'number' && !Number.isNaN(hubTimerWarningMinutes) ? Math.round(hubTimerWarningMinutes) : null;
    if (timerMinutes !== null && warningMinutes !== null) saved.hubTimerWarningMinutes = Math.min(timerMinutes, Math.max(0, warningMinutes));
    if (timerMinutes !== null && hubTimerStartsAfterArrivalPrompts) saved.hubTimerStartsAfterArrivalPrompts = true;
    if (timerMinutes !== null && hubOverdueCountsUp) saved.hubOverdueCountsUp = true;
    saveDestination(saved);
    onClose();
  }

  function remove() {
    if (destination) deleteDestination(destination.id);
    onClose();
  }
</script>

<Modal onClose={onClose} labelledby="destination-title">
  <form class="dialog destination-dialog" style="width:min(880px,100%)" onsubmit={save}>
    <div class="dialog-head">
      <h2 id="destination-title">{destination ? `Edit ${destination.label}` : 'New destination'}</h2>
      <span
        class="destination-icon"
        style:width="44px"
        style:height="44px"
        style:background={destinationColors[color].soft}
        style:color={destinationColors[color].strong}
        aria-hidden="true"
      >
        <Icon name={icon} size={24} />
      </span>
    </div>

    <div class="dest-cols">
      <div class="dest-look">
        <label class="field">Name <input bind:value={label} placeholder="Library" /></label>
        <div class="field">
          <span>Color</span>
          <div class="swatches" role="group" aria-label="Color">
            {#each colorNames as name (name)}
              <button
                type="button"
                class="swatch"
                style:background={destinationColors[name].strong}
                aria-label={name}
                aria-pressed={color === name}
                onclick={() => (color = name)}
              ></button>
            {/each}
          </div>
        </div>
        <fieldset class="hub-timer-settings">
          <legend>Hub visit timer</legend>
          <label class="field">Expected minutes at the Hub (optional)
            <input type="number" min="1" max="240" bind:value={hubTimerMinutes} placeholder="No timer" style="max-width:160px" />
          </label>
          {#if hubTimerMinutes}
            <label class="field">Warning chime minutes before time is up
              <input type="number" min="0" max="240" bind:value={hubTimerWarningMinutes} style="max-width:160px" />
            </label>
            <label class="check"><input type="checkbox" bind:checked={hubTimerStartsAfterArrivalPrompts} /><span>Start after arrival questions are answered</span></label>
            <label class="check"><input type="checkbox" bind:checked={hubOverdueCountsUp} /><span>When overdue, count upward (otherwise show a negative countdown)</span></label>
          {/if}
        </fieldset>
        <div class="field icon-field">
          <span>Icon</span>
          <input type="search" placeholder="Search icons, e.g. water, book, bus" bind:value={iconSearch} aria-label="Search icons" />
          <div class="icon-groups">
            {#each iconGroups as entry (entry.group)}
              <p class="eyebrow">{entry.group}</p>
              <div class="icon-choices" role="group" aria-label={entry.group}>
                {#each entry.names as name (name)}
                  <button
                    type="button"
                    class="icon-choice"
                    style:color={icon === name ? destinationColors[color].strong : ''}
                    title={name.replaceAll('-', ' ')}
                    aria-label={name.replaceAll('-', ' ')}
                    aria-pressed={icon === name}
                    onclick={() => (icon = name)}
                  >
                    <Icon {name} size={20} />
                  </button>
                {/each}
              </div>
            {:else}
              <p class="muted small">No icons match "{iconSearch}".</p>
            {/each}
          </div>
        </div>
      </div>
      <div class="dest-rules">
        <label class="field">
          Minutes the trip should take (optional)
          <input type="number" min="1" max="120" bind:value={minutes} placeholder="No time limit" style="max-width:160px" />
          <span class="muted small" style="font-weight:500">Leave it empty if this trip has no time limit. It'll never show as overdue.</span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={counts} />
          <span>
            Counts toward the Pass Allowance
            <span class="muted small">Untick for trips that shouldn't use up a student's passes, like the Nurse.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={isPrivate} />
          <span>
            Private
            <span class="muted small">
              Students see someone is out, not where. No limit or line.
            </span>
          </span>
        </label>
        {#if isPrivate}
          <label class="field">
            Student-facing private label (optional)
            <input bind:value={kioskLabel} maxlength="60" placeholder="Private destination" />
            <span class="muted small">Use a label students may safely see. If blank, the Hub kiosk shows “Private destination”.</span>
          </label>
        {/if}
        <label class="check">
          <input
            type="checkbox"
            checked={kioskAvailable}
            onchange={(event) => {
              kioskAvailable = event.currentTarget.checked;
              if (!kioskAvailable) temporaryTripAvailable = false;
            }}
          />
          <span>
            Available on the Hub kiosk
            <span class="muted small">This is separate from availability in classroom Inform the Hub.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={temporaryTripAvailable} disabled={!kioskAvailable} />
          <span>
            Available as a Temporary Trip
            <span class="muted small">Students can choose this while already signed in at the Hub.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={informHubAvailable} />
          <span>
            Available in Inform the Hub
            <span class="muted small">Only enabled destinations can be selected for a classroom Hub notification.</span>
          </span>
        </label>
        {#if isPrivate}
          <!-- No limit or line to set: a line would show the room who's going here. -->
        {:else if hasClassLimit}
          <label class="check">
            <input type="checkbox" bind:checked={countsTowardClass} />
            <span>
              Counts toward the class limit
              <span class="muted small">
                Untick for places like the Nurse or the Counselor, so students going there never wait, however many are out.
              </span>
            </span>
          </label>
        {:else}
          <label class="field">
            Students here at once
            <select
              value={studentLimit === null ? '' : String(studentLimit)}
              onchange={(event) => (studentLimit = event.currentTarget.value ? Number(event.currentTarget.value) : null)}
              style="max-width:160px"
            >
              <option value="">No limit</option>
              {#each limitChoices as option (option)}<option value={String(option)}>{option} at a time</option>{/each}
            </select>
            <span class="muted small" style="font-weight:500">
              Once it's full, the next student waits, or joins this destination's line if lines are on in Pass Options.
              Choose “No limit” for places like the Nurse, so nobody has to wait.
            </span>
          </label>
        {/if}
        <label class="field">
          Hub kiosk confirmation message (optional)
          <textarea
            bind:value={kioskConfirmation}
            maxlength="160"
            rows="3"
            placeholder="Your arrival was saved. Take a moment to settle in."
          ></textarea>
          <span class="muted small">Shown after the Hub Host saves an arrival. Keep this message safe for a shared student screen.</span>
        </label>
        <div class="field">
          <label for="hub-arrival-chime">Hub kiosk arrival chime</label>
          <div class="row">
            <select
              id="hub-arrival-chime"
              value={hubArrivalChime}
              onchange={(event) => {
                const value = event.currentTarget.value;
                if (isHubKioskChime(value)) hubArrivalChime = value;
              }}
            >
              {#each hubChimeOptions as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <button
              type="button"
              class="btn"
              disabled={hubArrivalChime === 'none' || account.hubKioskSoundSettings?.muted === true}
              onclick={() => playHubChime(hubArrivalChime, account.hubKioskSoundSettings?.volume ?? 70)}
            >Preview</button>
          </div>
          <span class="muted small">Played on the Hub kiosk only after the Host accepts an arrival.</span>
        </div>
        {#each promptStages as group (group.stage)}
          <details class="hub-prompt-section">
            <summary>{group.label} ({promptsFor(group.stage).length})</summary>
            <p class="muted small">Questions are saved with a version so future edits won't change earlier answers. Each stage supports up to eight prompts.</p>
            {#each promptsFor(group.stage) as prompt, index (prompt.id)}
              <fieldset class="hub-prompt-editor">
                <legend>Prompt {index + 1}</legend>
                <label class="field">
                  Question
                  <input
                    value={prompt.question}
                    maxlength="240"
                    oninput={(event) => updatePrompt(group.stage, prompt.id, { question: event.currentTarget.value })}
                  />
                </label>
                <label class="field">
                  Guidance (optional)
                  <textarea
                    value={prompt.guidance ?? ''}
                    maxlength="240"
                    rows="2"
                    oninput={(event) => updatePrompt(group.stage, prompt.id, { guidance: event.currentTarget.value })}
                  ></textarea>
                </label>
                <label class="field">
                  Response type
                  <select
                    value={prompt.responseType}
                    onchange={(event) => setPromptResponseType(group.stage, prompt.id, event.currentTarget.value)}
                  >
                    <option value="written">Written response</option>
                    <option value="rating">Visual rating</option>
                  </select>
                </label>
                {#if prompt.responseType === 'rating'}
                  <label class="field">
                    Rating scale
                    <select
                      value={prompt.scaleMax ?? 5}
                      onchange={(event) => updatePrompt(group.stage, prompt.id, { scaleMax: Number(event.currentTarget.value) === 10 ? 10 : 5 })}
                    >
                      <option value="5">1–5</option>
                      <option value="10">1–10</option>
                    </select>
                  </label>
                  <label class="field">
                    Rating display
                    <select
                      value={prompt.ratingStyle ?? 'numbers'}
                      onchange={(event) => updatePrompt(group.stage, prompt.id, { ratingStyle: event.currentTarget.value === 'stars' ? 'stars' : 'numbers' })}
                    >
                      <option value="numbers">Numbers</option>
                      <option value="stars">Stars</option>
                    </select>
                  </label>
                  <div class="row">
                    <label class="field">
                      Lowest label
                      <input
                        value={prompt.minLabel ?? ''}
                        maxlength="60"
                        oninput={(event) => updatePrompt(group.stage, prompt.id, { minLabel: event.currentTarget.value })}
                      />
                    </label>
                    <label class="field">
                      Highest label
                      <input
                        value={prompt.maxLabel ?? ''}
                        maxlength="60"
                        oninput={(event) => updatePrompt(group.stage, prompt.id, { maxLabel: event.currentTarget.value })}
                      />
                    </label>
                  </div>
                {/if}
                <label class="check">
                  <input
                    type="checkbox"
                    checked={prompt.required}
                    onchange={(event) => updatePrompt(group.stage, prompt.id, { required: event.currentTarget.checked })}
                  />
                  <span>Response required</span>
                </label>
                <div class="row">
                  <button type="button" class="btn" aria-label={`Move prompt ${index + 1} up`} disabled={index === 0} onclick={() => movePrompt(group.stage, index, -1)}>Move up</button>
                  <button type="button" class="btn" aria-label={`Move prompt ${index + 1} down`} disabled={index === promptsFor(group.stage).length - 1} onclick={() => movePrompt(group.stage, index, 1)}>Move down</button>
                  <button type="button" class="btn btn-danger" onclick={() => removePrompt(group.stage, prompt.id)}>Remove</button>
                </div>
              </fieldset>
            {:else}
              <p class="muted small">No {group.stage} prompts are configured.</p>
            {/each}
            <button type="button" class="btn" disabled={promptsFor(group.stage).length >= 8} onclick={() => addPrompt(group.stage)}>Add {group.stage} prompt</button>
          </details>
        {/each}
      </div>
    </div>

    {#if error}<p class="form-error" role="alert">{error}</p>{/if}

    <div class="dialog-actions" style="justify-content:space-between">
      {#if destination}
        <button type="button" class="btn btn-danger" onclick={remove}><Icon name="trash" size={15} />Delete</button>
      {:else}
        <span></span>
      {/if}
      <div class="row">
        <button type="button" class="btn" onclick={onClose}>Cancel</button>
        <button class="btn btn-primary">Save</button>
      </div>
    </div>
  </form>
</Modal>

<style>
  /* What it looks like on the left; how passes there work on the right. */
  .dest-cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 28px;
    min-height: 0;
  }

  /* Lets the icon list, not the whole dialog, scroll on a short screen. */
  :global(.destination-dialog) > .dest-cols {
    flex: 0 1 auto;
  }

  .dest-look,
  .dest-rules {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }

  .dest-look > :global(*),
  .dest-rules > :global(*) {
    flex: none;
  }

  .dest-look > :global(.icon-field) {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 220px;
  }

  .dest-rules {
    padding-left: 28px;
    border-left: 1px solid var(--border);
  }

  .hub-prompt-section {
    display: grid;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .hub-prompt-section > summary {
    font-weight: 800;
    cursor: pointer;
  }

  .hub-prompt-section > p {
    margin: 0;
  }

  .hub-prompt-editor {
    display: grid;
    gap: 10px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .hub-prompt-editor legend {
    padding: 0 4px;
    font-weight: 700;
  }

  .hub-prompt-editor .row > .field {
    flex: 1 1 140px;
  }

  @media (max-width: 720px) {
    .dest-cols {
      grid-template-columns: minmax(0, 1fr);
    }

    .dest-rules {
      padding-left: 0;
      border-left: 0;
    }
  }
</style>
