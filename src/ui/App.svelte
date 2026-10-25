<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Space } from '../core/space';
  import { currentSpaceId, openSpace, type OpenSpace } from '../storage/local';
  import Overview from './Overview.svelte';
  import ListView from './ListView.svelte';

  let opened = $state.raw<OpenSpace | null>(null);
  let loadError = $state<string | null>(null);
  // Bumped on every document change; the derived views below re-read the space.
  let version = $state(0);
  let openListId = $state<string | null>(null);
  let unsubscribe: (() => void) | undefined;

  const lists = $derived.by(() => {
    void version;
    return opened ? opened.space.getLists() : [];
  });
  const currentList = $derived(lists.find((l) => l.id === openListId));

  // Navigation uses history state rather than the URL, so the phone's back button
  // works without putting list ids in the address. The URL fragment is reserved
  // for share keys (phase 2).
  function openList(id: string) {
    openListId = id;
    history.pushState({ list: id }, '');
    window.scrollTo(0, 0);
  }

  function closeList() {
    if (history.state?.list) history.back();
    else openListId = null;
  }

  function onPopState(event: PopStateEvent) {
    const id = (event.state as { list?: unknown } | null)?.list;
    openListId = typeof id === 'string' ? id : null;
  }

  onMount(() => {
    // Reopen the same list after a reload; otherwise start on the overview.
    const restored = (history.state as { list?: unknown } | null)?.list;
    if (typeof restored === 'string') openListId = restored;
    else history.replaceState({ list: null }, '');
    openSpace(currentSpaceId())
      .then((result) => {
        opened = result;
        unsubscribe = result.space.onChange(() => version++);
      })
      .catch((error: unknown) => {
        console.error(error);
        loadError =
          'Could not open local storage. Private browsing or blocked site data can cause this.';
      });
  });

  onDestroy(() => {
    unsubscribe?.();
    void opened?.close();
  });

  function space(): Space {
    return opened!.space;
  }
</script>

<svelte:window onpopstate={onPopState} />

<main>
  {#if loadError}
    <p class="status" role="alert">{loadError}</p>
  {:else if !opened}
    <p class="status">Loading…</p>
  {:else if currentList}
    <ListView list={currentList} space={space()} onBack={closeList} />
  {:else}
    <Overview {lists} space={space()} onOpen={openList} />
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
</style>
