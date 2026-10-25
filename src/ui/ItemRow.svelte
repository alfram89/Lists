<script lang="ts">
  import { tick } from 'svelte';
  import { MAX_ITEM_TEXT_LENGTH, type Item } from '../core/space';
  import Icon from './Icon.svelte';

  let {
    item,
    canMoveUp,
    canMoveDown,
    onToggle,
    onSave,
    onDelete,
    onMove,
  }: {
    item: Item;
    canMoveUp: boolean;
    canMoveDown: boolean;
    onToggle: (checked: boolean) => void;
    onSave: (text: string) => void;
    onDelete: () => void;
    onMove: (delta: -1 | 1) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let input: HTMLInputElement | undefined = $state();

  async function startEdit() {
    draft = item.text;
    editing = true;
    await tick();
    input?.focus();
  }

  function save(event?: SubmitEvent) {
    event?.preventDefault();
    if (draft.trim() && draft !== item.text) onSave(draft);
    editing = false;
  }
</script>

<li class:checked={item.checked} class:editing>
  {#if editing}
    <form class="edit" onsubmit={save}>
      <label class="visually-hidden" for="edit-{item.id}">Item text</label>
      <input
        id="edit-{item.id}"
        class="text-input"
        maxlength={MAX_ITEM_TEXT_LENGTH}
        bind:value={draft}
        bind:this={input}
        onkeydown={(e) => e.key === 'Escape' && (editing = false)}
      />
      <div class="edit-actions">
        <button
          type="button"
          class="icon-btn"
          aria-label="Move up"
          disabled={!canMoveUp}
          onclick={() => onMove(-1)}
        >
          <Icon name="up" />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label="Move down"
          disabled={!canMoveDown}
          onclick={() => onMove(1)}
        >
          <Icon name="down" />
        </button>
        <button type="button" class="icon-btn danger" aria-label="Delete item" onclick={onDelete}>
          <Icon name="trash" />
        </button>
        <span class="spacer"></span>
        <button class="btn btn-primary">Done</button>
      </div>
    </form>
  {:else}
    <label class="row">
      <input
        type="checkbox"
        checked={item.checked}
        onchange={(e) => onToggle(e.currentTarget.checked)}
      />
      <span class="box" aria-hidden="true"><Icon name="check" /></span>
      <span class="text">{item.text}</span>
    </label>
    <button class="icon-btn" aria-label="Edit “{item.text}”" onclick={startEdit}>
      <Icon name="edit" />
    </button>
  {/if}
</li>

<style>
  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding-right: 0.25rem;
    border-top: 1px solid var(--border);
  }

  li:first-child {
    border-top: 0;
  }

  .row {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 52px;
    padding: 0.5rem 0.25rem 0.5rem 0.9rem;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  /* Native checkbox stays focusable and accessible; the box is drawn on top. */
  input[type='checkbox'] {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }

  .box {
    display: grid;
    place-items: center;
    flex: none;
    width: 26px;
    height: 26px;
    border: 2px solid var(--muted);
    border-radius: 8px;
    color: transparent;
    transition:
      background 0.12s,
      border-color 0.12s;
  }

  .box :global(svg) {
    width: 18px;
    height: 18px;
    stroke-width: 3;
  }

  input[type='checkbox']:checked + .box {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }

  input[type='checkbox']:focus-visible + .box {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }

  .text {
    overflow-wrap: anywhere;
  }

  .checked .text {
    color: var(--muted);
    text-decoration: line-through;
  }

  .editing {
    background: var(--accent-soft);
  }

  .edit {
    flex: 1;
    padding: 0.6rem 0.5rem 0.4rem 0.75rem;
  }

  .edit-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    margin-top: 0.35rem;
  }

  .spacer {
    flex: 1;
  }

  .danger {
    color: var(--danger);
  }
</style>
