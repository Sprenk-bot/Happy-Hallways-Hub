<script lang="ts">
  import { page } from '$app/state';
  import { account, classStudents, findClass, savePinCardDesign } from '#lib/account.svelte.ts';
  import Icon from '#lib/Icon.svelte';
  import { displayName } from '#lib/roster.ts';

  /**
   * A sheet of PIN cards to print and cut out, one for each student, so each
   * child can be handed only their own. Printing hides everything else.
   */
  const cls = $derived(findClass(page.params.id ?? '')!);
  const cards = $derived(
    classStudents(cls)
      .filter((student) => student.status === 'current' && student.pin)
      .map((student) => ({ id: student.id, name: displayName(student), pin: student.pin! }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  const template = { fontSize: 18, pinFontSize: 30, align: 'center' as const, color: '#ffffff', label: 'Your kiosk PIN', showPin: true };
  let design = $state(account.pinCardDesign ?? { defaults: template, overrides: {} });
  let selected = $state<string[]>([]);
  let currentId = $state('');
  let scope = $state<'all' | 'selection' | 'card'>('all');
  let style = $state({ ...(account.pinCardDesign?.defaults ?? template) });
  $effect(() => {
    const saved = account.pinCardDesign;
    if (saved && saved !== design) {
      design = saved;
      style = { ...saved.defaults };
    }
  });
  function currentStyle(id: string) { return { ...design.defaults, ...design.overrides[id] }; }
  function applyStyle() {
    style.fontSize = Math.min(36, Math.max(12, Number(style.fontSize) || 18));
    style.pinFontSize = Math.min(48, Math.max(16, Number(style.pinFontSize) || 30));
    const ids = scope === 'all' ? cards.map((card) => card.id) : scope === 'selection' ? selected : currentId ? [currentId] : [];
    if (!ids.length) return;
    if (scope === 'all') design = { defaults: { ...style }, overrides: {} };
    else {
      const overrides = { ...design.overrides };
      for (const id of ids) overrides[id] = { ...style };
      design = { ...design, overrides };
    }
    savePinCardDesign(design);
  }
  function resetDesign() {
    design = { defaults: { ...template }, overrides: {} };
    style = { ...template };
    savePinCardDesign(design);
  }
</script>

<svelte:head>
  <title>PIN cards · {cls.name}</title>
</svelte:head>

<section class="card no-print">
  <div>
    <p class="eyebrow">Kiosk PINs</p>
    <h2>Print PIN cards</h2>
  </div>
  {#if !account.studentPins}
    <p class="muted">PINs are off. Turn them on on the <a href="/roster">Roster</a> first.</p>
  {:else}
    <p class="muted small">
      One card per student. Cut them apart and hand each student only their own. A student who forgets theirs can still
      go: you type your teacher PIN instead.
    </p>
    <div class="designer">
      <h3>Card design</h3>
      <p class="muted small">Choose one or more cards below, edit the preview, then apply it to a scope. A PIN is printed only when Show PIN is on.</p>
      <div class="design-controls">
        <label>Card text size <input type="number" min="12" max="36" bind:value={style.fontSize} /></label>
        <label>PIN size <input type="number" min="16" max="48" bind:value={style.pinFontSize} /></label>
        <label>Text placement <select bind:value={style.align}><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label>
        <label>Card colour <input type="color" bind:value={style.color} /></label>
        <label>PIN label <input maxlength="40" bind:value={style.label} /></label>
        <label class="show-pin"><input type="checkbox" bind:checked={style.showPin} />Show PIN on cards</label>
        <label>Apply scope <select bind:value={scope}><option value="all">Apply to all</option><option value="selection" disabled={selected.length < 2}>Apply to selection ({selected.length})</option><option value="card" disabled={!currentId}>Apply to this PIN card</option></select></label>
        <label>Card being edited <select bind:value={currentId} onchange={() => { if (scope === 'card') style = currentStyle(currentId); }}><option value="">Choose a card</option>{#each cards as card (card.id)}<option value={card.id}>{card.name}</option>{/each}</select></label>
      </div>
      <div class="design-preview" style={`--card-color:${style.color};--card-align:${style.align};--card-font:${style.fontSize}px;--pin-font:${style.pinFontSize}px`} aria-label="PIN card preview"><span>{cls.name}</span><strong>{currentId ? cards.find((card) => card.id === currentId)?.name : 'Student name'}</strong>{#if style.label}<span>{style.label}</span>{/if}<b>{style.showPin ? '1234' : 'PIN hidden'}</b></div>
      <div class="row"><button class="btn btn-primary" onclick={applyStyle} disabled={scope === 'selection' ? selected.length < 2 : scope === 'card' && !currentId}>Apply design</button><button class="btn" onclick={resetDesign}>Reset to template</button></div>
    </div>
    <div class="row">
      <button class="btn btn-primary" onclick={() => window.print()} disabled={!cards.length}>
        <Icon name="printer" size={16} />Print
      </button>
    </div>
  {/if}
</section>

{#if account.studentPins}
  <div class="pin-cards" aria-label="PIN cards">
    {#each cards as card (card.id)}
      {@const cardStyle = currentStyle(card.id)}
      <div class="pin-card" style={`--card-color:${cardStyle.color};--card-align:${cardStyle.align};--card-font:${cardStyle.fontSize}px;--pin-font:${cardStyle.pinFontSize}px`}>
        <label class="card-select no-print"><input type="checkbox" checked={selected.includes(card.id)} onchange={(event) => selected = event.currentTarget.checked ? [...selected, card.id] : selected.filter((id) => id !== card.id)} />Select for batch design</label>
        <span class="card-class">{cls.name}</span>
        <strong class="card-name">{card.name}</strong>
        {#if cardStyle.label}<span class="card-label">{cardStyle.label}</span>{/if}
        {#if cardStyle.showPin}<span class="card-pin">{card.pin}</span>{:else}<span class="card-pin muted">PIN hidden</span>{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .pin-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0;
  }

  /* Dashed edges are where the scissors go. */
  .pin-card {
    display: grid;
    gap: 2px;
    justify-items: center;
    padding: 18px 12px;
    border: 1px dashed var(--border-strong);
    background: var(--card-color, #fff);
    text-align: var(--card-align, center);
    break-inside: avoid;
  }

  .card-class {
    color: var(--muted);
    font-size: calc(var(--card-font, 18px) * .67);
  }

  .card-name {
    font-size: var(--card-font, 18px);
  }

  .card-label {
    margin-top: 6px;
    color: var(--muted);
    font-size: calc(var(--card-font, 18px) * .67);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .card-pin {
    font: 800 var(--pin-font, 30px)/1.1 ui-monospace, 'SF Mono', Menlo, monospace;
    letter-spacing: 0.18em;
  }

  .designer { margin: 16px 0; padding: 16px; border: 1px solid var(--border); border-radius: 12px; }
  .design-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 14px 0; }
  .design-controls label { display: grid; gap: 5px; font-size: 13px; font-weight: 700; }
  .design-controls .show-pin { display: flex; align-items: center; }
  .design-controls input, .design-controls select { min-height: 38px; }
  .card-select { font-size: 11px; }
  .card-select input { width: 16px; height: 16px; }
  .design-preview { display: grid; gap: 5px; justify-items: var(--preview-align, center); padding: 16px; border: 1px dashed var(--border-strong); background: var(--card-color); text-align: var(--card-align); }
  .design-preview strong { font-size: var(--card-font); }
  .design-preview span { font-size: calc(var(--card-font) * .67); }
  .design-preview b { font: 800 var(--pin-font)/1.1 ui-monospace, 'SF Mono', Menlo, monospace; }

  /* On paper: just the cards, with the app around them left off. */
  @media print {
    :global(.sidebar, .corner, .checklist-spot, .site-footer, .class-head, .page-tabs, .no-print) {
      display: none !important;
    }

    :global(.shell) {
      display: block !important;
    }

    :global(.main) {
      padding: 0 !important;
    }

    :global(html, body) {
      background: #fff !important;
    }

    .pin-cards {
      grid-template-columns: repeat(3, 1fr);
    }

    .pin-card {
      border-color: #999;
    }
  }
</style>
