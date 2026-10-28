<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { AppState } from './app-state.svelte';
  import Overview from './Overview.svelte';
  import ListView from './ListView.svelte';
  import JoinPrompts from './JoinPrompts.svelte';

  interface OpenList {
    space: string;
    list: string;
  }

  const app = new AppState();
  let openList = $state<OpenList | null>(null);

  const lists = $derived.by(() => {
    void app.version;
    return app.space ? app.space.getLists() : [];
  });
  // A list only shows while its own space is open, so switching spaces returns
  // to the overview.
  const currentList = $derived(
    openList?.space === app.spaceId ? lists.find((l) => l.id === openList?.list) : undefined,
  );

  function readState(state: unknown): OpenList | null {
    const s = state as Partial<OpenList> | null;
    return typeof s?.space === 'string' && typeof s.list === 'string'
      ? { space: s.space, list: s.list }
      : null;
  }

  // Navigation uses history state rather than the URL, so the phone's back button
  // works without putting list ids in the address. The URL fragment is reserved
  // for share links.
  function showList(id: string) {
    if (!app.spaceId) return;
    // A plain object: history state is structured-cloned, which proxies cannot be.
    const entry = { space: app.spaceId, list: id };
    history.pushState(entry, '');
    openList = entry;
    window.scrollTo(0, 0);
  }

  function closeList() {
    if (readState(history.state)) history.back();
    else openList = null;
  }

  function onPopState(event: PopStateEvent) {
    openList = readState(event.state);
  }

  onMount(() => {
    // After a reload, history.state still names the list that was open.
    openList = readState(history.state);
    if (!openList) history.replaceState(null, '');
    void app.start();
  });

  onDestroy(() => app.destroy());
</script>

<svelte:window onpopstate={onPopState} />

<main>
  {#if app.notice}
    <div class="notice" role="alert">
      <span>{app.notice}</span>
      <button class="btn" onclick={() => (app.notice = null)}>OK</button>
    </div>
  {/if}

  <JoinPrompts {app} />

  {#if app.error}
    <p class="status" role="alert">{app.error}</p>
  {:else if !app.space}
    <p class="status">Loading…</p>
  {:else if currentList}
    <ListView list={currentList} space={app.space} onBack={closeList} />
  {:else}
    <Overview {app} {lists} space={app.space} onOpen={showList} />
  {/if}
</main>

<style>
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 0.75rem 1rem 4rem;
  }

  .status {
    margin-top: 3rem;
    text-align: center;
    color: var(--muted);
  }

  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    padding: 0.5rem 0.5rem 0.5rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--accent-soft);
  }
</style>
