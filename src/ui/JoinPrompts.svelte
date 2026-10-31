<script lang="ts">
  import type { AppState } from './app-state.svelte';

  let { app }: { app: AppState } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let passphrase = $state('');
  let unlocking = $state(false);
  let wrong = $state(false);

  // The passphrase dialog is open exactly while a protected link is pending.
  $effect(() => {
    if (app.pendingUnlock && dialog && !dialog.open) dialog.showModal();
  });

  async function unlock(event: SubmitEvent) {
    event.preventDefault();
    unlocking = true;
    wrong = false;
    try {
      const result = await app.unlock(passphrase);
      if (result === 'wrong') {
        wrong = true;
      } else {
        passphrase = '';
        if (dialog?.open) dialog.close();
      }
    } finally {
      unlocking = false;
    }
  }

  function cancel() {
    passphrase = '';
    wrong = false;
    app.cancelUnlock();
  }
</script>

<dialog bind:this={dialog} onclose={cancel} aria-labelledby="unlock-title">
  <form onsubmit={unlock}>
    <h2 id="unlock-title">Enter the passphrase</h2>
    <p>
      This share link is protected. The person who shared it should have told you the passphrase
      separately.
    </p>
    <label class="visually-hidden" for="unlock-passphrase">Passphrase</label>
    <input
      id="unlock-passphrase"
      class="text-input"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      bind:value={passphrase}
      aria-invalid={wrong}
      aria-describedby={wrong ? 'unlock-error' : undefined}
    />
    {#if wrong}
      <p class="error" id="unlock-error" role="alert">That passphrase is not right.</p>
    {/if}
    <div class="actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancel</button>
      <button class="btn btn-primary" disabled={!passphrase.trim() || unlocking}>
        {unlocking ? 'Unlocking…' : 'Open'}
      </button>
    </div>
  </form>
</dialog>

{#if app.pendingRekey}
  <div class="banner" role="alert">
    <p>
      <strong>“{app.pendingRekey.name}” has a new link.</strong> This happens when someone resets the
      share link. Only accept it if you trust the person who sent it: from then on, changes sync with
      whoever has this new link.
    </p>
    <div class="actions">
      <button class="btn" onclick={() => app.dismissRekey()}>Ignore</button>
      <button class="btn btn-primary" onclick={() => app.confirmRekey()}>Use the new link</button>
    </div>
  </div>
{/if}

{#if app.moved}
  <div class="banner" role="note">
    <p>
      <strong>The share link for “{app.spaceName}” was reset.</strong> Your lists are still here, but
      changes no longer sync. Ask the person who reset it for the new link.
    </p>
  </div>
{/if}

<style>
  dialog {
    width: min(24rem, calc(100vw - 2rem));
    padding: 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 16px 48px rgb(0 0 0 / 25%);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 45%);
  }

  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
  }

  dialog p {
    margin: 0 0 1rem;
    color: var(--muted);
    font-size: 0.95rem;
  }

  .error {
    margin: 0.5rem 0 0;
    color: var(--danger);
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .banner {
    margin-bottom: 0.75rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--accent-soft);
  }

  .banner p {
    margin: 0;
  }

  .banner .actions {
    margin-top: 0.75rem;
  }
</style>
