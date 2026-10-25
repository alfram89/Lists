<script lang="ts">
  import { encode } from 'uqr';

  let { text, label }: { text: string; label: string } = $props();

  // Drawn as a single SVG path from the module matrix, so no generated markup
  // is ever injected as HTML.
  const qr = $derived(encode(text, { ecc: 'M', border: 2 }));
  const size = $derived(qr.data.length);
  const path = $derived(
    qr.data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : ''))).join(''),
  );
</script>

<svg viewBox="0 0 {size} {size}" shape-rendering="crispEdges" role="img" aria-label={label}>
  <rect width={size} height={size} fill="#fff" />
  <path d={path} fill="#000" />
</svg>

<style>
  svg {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
