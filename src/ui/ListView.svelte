<script lang="ts">
  import { tick } from 'svelte';
  import { MAX_ITEM_TEXT_LENGTH, MAX_LIST_NAME_LENGTH, type List, type Space } from '../core/space';
  import Icon from './Icon.svelte';
  import ItemRow from './ItemRow.svelte';

  let { list, space, onBack }: { list: List; space: Space; onBack: () => void } = $props();

  let newText = $state('');
  let menuOpen = $state(false);
  let renaming = $state(false);
  let nameDraft = $state('');
  let showDone = $state(true);
  let addInput: HTMLInputElement | undefined = $state();
  let nameInput: HTMLInputElement | undefined = $state();

  const open = $derived(list.items.filter((i) => !i.checked));
  const done = $derived(list.items.filter((i) => i.checked));

  function add(event: SubmitEvent) {
    event.preventDefault();
    space.addItem(list.id, newText);
    newText = '';
    addInput?.focus();
  }

  async function startRename() {
    menuOpen = false;
    nameDraft = list.name;
    renaming = true;
    await tick();
    nameInput?.select();
  }

  function saveRename(event?: SubmitEvent) {
    event?.preventDefault();
    space.renameList(list.id, nameDraft);
    renaming = false;
  }

  function deleteList() {
    menuOpen = false;
    if (confirm(`Delete "${list.name}" and all its items?`)) {
      space.deleteList(list.id);
      onBack();
    }
  }

  let menuWrap: HTMLElement | undefined = $state();

  function closeMenuOnOutsideClick(event: MouseEvent) {
    if (menuOpen && !menuWrap?.contains(event.target as Node)) menuOpen = false;
  }

  function uncheckAll() {
    menuOpen = false;
    space.uncheckAll(list.id);
  }
</script>

<svelte:window
  onclick={closeMenuOnOutsideClick}
  onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)}
/>

<header>
  <button class="icon-btn" onclick={onBack} aria-label="Back to all lists">
    <Icon name="back" />
  </button>

  {#if renaming}
    <form class="rename" onsubmit={saveRename}>
      <label class="visually-hidden" for="list-name">List name</label>
      <input
        id="list-name"
        class="text-input"
        maxlength={MAX_LIST_NAME_LENGTH}
        bind:value={nameDraft}
        bind:this={nameInput}
        onkeydown={(e) => e.key === 'Escape' && (renaming = false)}
        onblur={() => saveRename()}
      />
    </form>
  {:else}
    <h1>{list.name}</h1>
  {/if}

  <div class="menu-wrap" bind:this={menuWrap}>
    <button
      class="icon-btn"
      aria-label="List options"
      aria-expanded={menuOpen}
      aria-controls="list-menu"
      onclick={() => (menuOpen = !menuOpen)}
    >
      <Icon name="more" />
    </button>
    {#if menuOpen}
      <div class="menu" id="list-menu">
        <button onclick={startRename}>Rename list</button>
        <button onclick={uncheckAll} disabled={done.length === 0}>Uncheck all</button>
        <button class="danger" onclick={deleteList}>Delete list</button>
      </div>
    {/if}
  </div>
</header>

<form class="add" onsubmit={add}>
  <label class="visually-hidden" for="new-item">Add an item</label>
  <input
    id="new-item"
    class="text-input"
    placeholder="Add an item"
    maxlength={MAX_ITEM_TEXT_LENGTH}
    autocomplete="off"
    enterkeyhint="enter"
    bind:value={newText}
    bind:this={addInput}
  />
  <button class="btn btn-primary" disabled={!newText.trim()} aria-label="Add item">
    <Icon name="plus" />
  </button>
</form>

{#if list.items.length === 0}
  <p class="empty">Nothing here yet. Add the first item above.</p>
{/if}

{#if open.length > 0}
  <ul class="items">
    {#each open as item, index (item.id)}
      <ItemRow
        {item}
        canMoveUp={index > 0}
        canMoveDown={index < open.length - 1}
        onToggle={(checked) => space.setChecked(list.id, item.id, checked)}
        onSave={(text) => space.setItemText(list.id, item.id, text)}
        onDelete={() => space.deleteItem(list.id, item.id)}
        onMove={(delta) => space.moveItem(list.id, item.id, index + delta)}
      />
    {/each}
  </ul>
{:else if done.length > 0}
  <p class="empty">All done! 🎉</p>
{/if}

{#if done.length > 0}
  <section class="done">
    <div class="done-header">
      <button
        class="toggle"
        aria-expanded={showDone}
        aria-controls="done-items"
        onclick={() => (showDone = !showDone)}
      >
        <span class="chev" class:open={showDone}><Icon name="chevron" /></span>
        Completed ({done.length})
      </button>
      <button class="btn btn-danger" onclick={() => space.clearChecked(list.id)}>
        Clear completed
      </button>
    </div>
    {#if showDone}
      <ul class="items" id="done-items">
        {#each done as item, index (item.id)}
          <ItemRow
            {item}
            canMoveUp={index > 0}
            canMoveDown={index < done.length - 1}
            onToggle={(checked) => space.setChecked(list.id, item.id, checked)}
            onSave={(text) => space.setItemText(list.id, item.id, text)}
            onDelete={() => space.deleteItem(list.id, item.id)}
            onMove={(delta) => space.moveItem(list.id, item.id, index + delta)}
          />
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0 -0.5rem 0.75rem;
  }

  h1 {
    flex: 1;
    margin: 0;
    font-size: 1.4rem;
    overflow-wrap: anywhere;
  }

  .rename {
    flex: 1;
  }

  .menu-wrap {
    position: relative;
  }

  .menu {
    position: absolute;
    right: 0;
    top: 100%;
    z-index: 10;
    display: grid;
    min-width: 12rem;
    padding: 0.35rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  }

  .menu button {
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
  }

  .menu button:hover:not(:disabled) {
    background: var(--surface-2);
  }

  .menu button:disabled {
    color: var(--muted);
    cursor: default;
  }

  .menu .danger {
    color: var(--danger);
  }

  .add {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0;
    margin-bottom: 0.5rem;
    background: var(--bg);
  }

  .add .btn {
    display: grid;
    place-items: center;
    width: 52px;
    padding: 0;
  }

  .add .btn :global(svg) {
    width: 22px;
    height: 22px;
  }

  .items {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .empty {
    color: var(--muted);
    text-align: center;
    margin: 2rem 0;
  }

  .done {
    margin-top: 1.5rem;
  }

  .done-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 44px;
    padding: 0 0.25rem;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-weight: 600;
  }

  .chev {
    display: inline-grid;
    transition: transform 0.15s;
  }

  .chev :global(svg) {
    width: 18px;
    height: 18px;
  }

  .chev.open {
    transform: rotate(90deg);
  }

  .done .btn {
    background: transparent;
  }
</style>
