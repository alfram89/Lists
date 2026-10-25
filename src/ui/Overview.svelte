<script lang="ts">
  import { MAX_LIST_NAME_LENGTH, type List, type Space } from '../core/space';
  import { requestPersistentStorage } from '../storage/local';
  import type { AppState } from './app-state.svelte';
  import Icon from './Icon.svelte';
  import SpaceHeader from './SpaceHeader.svelte';

  let {
    app,
    lists,
    space,
    onOpen,
  }: { app: AppState; lists: List[]; space: Space; onOpen: (id: string) => void } = $props();

  let newName = $state('');

  function create(event: SubmitEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    const id = space.createList(newName);
    newName = '';
    void requestPersistentStorage();
    onOpen(id);
  }

  function summary(list: List): string {
    if (list.items.length === 0) return 'Empty';
    if (list.openCount === 0) return `All ${list.doneCount} done`;
    return `${list.openCount} left` + (list.doneCount ? ` · ${list.doneCount} done` : '');
  }
</script>

<SpaceHeader {app} />

<form class="new-list" onsubmit={create}>
  <label class="visually-hidden" for="new-list">New list name</label>
  <input
    id="new-list"
    class="text-input"
    placeholder="New list, e.g. Groceries"
    maxlength={MAX_LIST_NAME_LENGTH}
    autocomplete="off"
    enterkeyhint="done"
    bind:value={newName}
  />
  <button class="btn btn-primary" disabled={!newName.trim()}>Create</button>
</form>

{#if lists.length === 0}
  <div class="empty">
    {#if app.sync}
      <p>No lists here yet.</p>
      <p class="muted">
        If you just opened a share link, the lists appear as soon as someone who has them opens the
        app. Keep this page open.
      </p>
    {:else}
      <p>No lists yet.</p>
      <p class="muted">
        Everything is stored only on this device until you share it. Shared lists are end-to-end
        encrypted.
      </p>
    {/if}
  </div>
{:else}
  <ul class="lists">
    {#each lists as list (list.id)}
      <li>
        <button class="list-card" onclick={() => onOpen(list.id)}>
          <span class="name">{list.name}</span>
          <span class="meta">{summary(list)}</span>
          <Icon name="chevron" />
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .new-list {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  .lists {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .list-card {
    display: grid;
    grid-template-columns: 1fr auto 22px;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-height: 60px;
    padding: 0.75rem 0.75rem 0.75rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
    text-align: left;
  }

  .list-card :global(svg) {
    width: 22px;
    height: 22px;
    color: var(--muted);
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .meta {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .empty {
    margin-top: 2rem;
    text-align: center;
  }

  .muted {
    color: var(--muted);
    font-size: 0.95rem;
  }
</style>
