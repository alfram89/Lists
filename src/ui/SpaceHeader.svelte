<script lang="ts">
  import { tick } from 'svelte';
  import { MAX_LIST_NAME_LENGTH } from '../core/space';
  import type { AppState } from './app-state.svelte';
  import Icon from './Icon.svelte';
  import ShareDialog from './ShareDialog.svelte';

  let { app }: { app: AppState } = $props();

  let menuOpen = $state(false);
  let renaming = $state(false);
  let nameDraft = $state('');
  let shareLink = $state<string | null>(null);
  let menuWrap: HTMLElement | undefined = $state();
  let nameInput: HTMLInputElement | undefined = $state();

  const status = $derived.by(() => {
    if (!app.sync) return 'Only on this device';
    const { devices } = app.sync;
    const relay = app.relay;
    const others =
      devices > 0 ? ` · ${devices} other ${devices === 1 ? 'device' : 'devices'} online` : '';
    if (relay && !relay.ready) return `Shared · syncing…${others}`;
    if (relay && relay.relays === 0 && devices === 0) {
      return relay.pending
        ? 'Shared · offline, changes will be sent later'
        : 'Shared · offline, will sync when back online';
    }
    if (relay?.pending) return `Shared · saving…${others}`;
    return `Shared · up to date${others}`;
  });

  const connected = $derived((app.sync?.devices ?? 0) > 0 || (app.relay?.relays ?? 0) > 0);
  const relayDetails = $derived(
    app.relay ? `${app.relay.relays} of ${app.relay.totalRelays} relays connected` : undefined,
  );

  async function share() {
    menuOpen = false;
    shareLink = await app.shareLink();
  }

  async function startRename() {
    menuOpen = false;
    nameDraft = app.spaceName;
    renaming = true;
    await tick();
    nameInput?.select();
  }

  function saveRename(event?: SubmitEvent) {
    event?.preventDefault();
    app.renameSpace(nameDraft);
    renaming = false;
  }

  async function switchTo(id: string) {
    menuOpen = false;
    if (id !== app.spaceId) await app.switchTo(id);
  }

  async function create() {
    menuOpen = false;
    await app.createSpace();
  }

  async function remove() {
    menuOpen = false;
    const message = app.isShared
      ? `Leave “${app.spaceName}”? Its lists are removed from this device. Others who have the link keep their copy.`
      : `Delete “${app.spaceName}” and all its lists from this device?`;
    if (confirm(message)) await app.removeCurrent();
  }

  function closeMenuOnOutsideClick(event: MouseEvent) {
    if (menuOpen && !menuWrap?.contains(event.target as Node)) menuOpen = false;
  }
</script>

<svelte:window
  onclick={closeMenuOnOutsideClick}
  onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)}
/>

<header>
  <div class="title-row">
    {#if renaming}
      <form class="rename" onsubmit={saveRename}>
        <label class="visually-hidden" for="space-name">Space name</label>
        <input
          id="space-name"
          class="text-input"
          maxlength={MAX_LIST_NAME_LENGTH}
          bind:value={nameDraft}
          bind:this={nameInput}
          onkeydown={(e) => e.key === 'Escape' && (renaming = false)}
          onblur={() => saveRename()}
        />
      </form>
    {:else}
      <div class="menu-wrap" bind:this={menuWrap}>
        <h1>
          <button
            class="space-btn"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls="space-menu"
            onclick={() => (menuOpen = !menuOpen)}
          >
            <span class="space-name">{app.spaceName}</span>
            <Icon name="caret" />
          </button>
        </h1>
        {#if menuOpen}
          <div class="menu" id="space-menu">
            <p class="menu-label">Spaces</p>
            {#each app.spaces as space (space.id)}
              <button
                class="space-option"
                aria-current={space.id === app.spaceId}
                onclick={() => switchTo(space.id)}
              >
                <span>{space.name}</span>
                {#if space.shared}<span class="tag">Shared</span>{/if}
              </button>
            {/each}
            <hr />
            <button onclick={create}>New space</button>
            <button onclick={startRename}>Rename this space</button>
            <button class="danger" onclick={remove}>
              {app.isShared ? 'Leave this space' : 'Delete this space'}
            </button>
          </div>
        {/if}
      </div>
    {/if}
    <button class="icon-btn share" aria-label="Share this space" onclick={share}>
      <Icon name="share" />
    </button>
  </div>
  <p class="status" class:live={connected} role="status" title={relayDetails}>{status}</p>
</header>

{#if shareLink}
  <ShareDialog link={shareLink} spaceName={app.spaceName} onClose={() => (shareLink = null)} />
{/if}

<style>
  header {
    padding: 0.25rem 0 0.75rem;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .menu-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .space-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    max-width: 100%;
    min-height: 44px;
    padding: 0 0.25rem 0 0;
    border: 0;
    background: transparent;
    text-align: left;
  }

  .space-btn :global(svg) {
    flex: none;
    width: 22px;
    height: 22px;
    color: var(--muted);
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
  }

  .space-btn {
    font-weight: inherit;
  }

  .space-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename {
    flex: 1;
  }

  .share {
    color: var(--accent);
  }

  .status {
    margin: 0;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .status.live::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 0.4rem;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: 1px;
  }

  .menu {
    position: absolute;
    left: 0;
    top: 100%;
    z-index: 10;
    display: grid;
    min-width: 15rem;
    max-width: calc(100vw - 2rem);
    padding: 0.35rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  }

  .menu-label {
    margin: 0.25rem 0.75rem;
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
  }

  .menu button:hover {
    background: var(--surface-2);
  }

  .space-option[aria-current='true'] {
    font-weight: 600;
    background: var(--accent-soft);
  }

  .space-option span:first-child {
    overflow-wrap: anywhere;
  }

  .tag {
    flex: none;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  hr {
    width: 100%;
    margin: 0.35rem 0;
    border: 0;
    border-top: 1px solid var(--border);
  }

  .danger {
    color: var(--danger);
  }
</style>
