<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import QrCode from './QrCode.svelte';

  let { link, spaceName, onClose }: { link: string; spaceName: string; onClose: () => void } =
    $props();

  let dialog: HTMLDialogElement | undefined = $state();
  let copied = $state(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  onMount(() => dialog?.showModal());

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard blocked: select the text so the user can copy it manually.
      document.querySelector<HTMLInputElement>('#share-link')?.select();
    }
  }

  async function shareNative() {
    try {
      await navigator.share({ title: spaceName, url: link });
    } catch {
      // Cancelled by the user.
    }
  }
</script>

<dialog bind:this={dialog} onclose={onClose} aria-labelledby="share-title">
  <div class="head">
    <h2 id="share-title">Share “{spaceName}”</h2>
    <button class="icon-btn" aria-label="Close" onclick={() => dialog?.close()}>
      <Icon name="close" />
    </button>
  </div>

  <p class="warning">
    Anyone with this link can see and edit every list in this space. Send it only to people you
    trust, through a private channel.
  </p>

  <div class="qr">
    <QrCode text={link} label="QR code for the share link" />
  </div>

  <label class="visually-hidden" for="share-link">Share link</label>
  <div class="link-row">
    <input
      id="share-link"
      class="text-input"
      readonly
      value={link}
      onfocus={(e) => e.currentTarget.select()}
    />
    <button class="btn btn-primary" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
  </div>
  {#if canShare}
    <button class="btn share-btn" onclick={shareNative}>
      <Icon name="share" /> Share via…
    </button>
  {/if}

  <p class="note">
    The key is in the part of the link after “#”, which is never sent to any server. Changes sync in
    real time, and reach others the next time they open the app.
  </p>
</dialog>

<style>
  dialog {
    width: min(26rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    padding: 1rem 1.25rem 1.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 16px 48px rgb(0 0 0 / 25%);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 45%);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-right: -0.5rem;
  }

  h2 {
    margin: 0;
    font-size: 1.2rem;
    overflow-wrap: anywhere;
  }

  .warning {
    margin: 0.5rem 0 1rem;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    background: var(--accent-soft);
    font-size: 0.95rem;
  }

  .qr {
    width: min(14rem, 70%);
    margin: 0 auto 1rem;
    border-radius: 8px;
    overflow: hidden;
  }

  .link-row {
    display: flex;
    gap: 0.5rem;
  }

  .link-row input {
    font-size: 0.85rem;
    color: var(--muted);
  }

  .share-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    margin-top: 0.5rem;
  }

  .share-btn :global(svg) {
    width: 20px;
    height: 20px;
  }

  .note {
    margin: 1rem 0 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
