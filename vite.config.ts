import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Content Security Policy for production builds.
 *
 * GitHub Pages cannot send HTTP headers, so the policy is delivered in a <meta> tag.
 * It is only injected into builds because the Vite dev server relies on inline
 * scripts and styles for hot reloading.
 *
 * `connect-src 'self'` means the prototype cannot talk to any other host. Phase 2
 * and 3 will extend it with the chosen signalling and relay endpoints (wss:).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'lists:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

export default defineConfig({
  // Relative base so the same build works on GitHub Pages (/lists/), forks and any
  // other static host or sub-path.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    svelte(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registers the service worker from an external file, which keeps the CSP
      // free of 'unsafe-inline'.
      injectRegister: 'script',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Lists',
        short_name: 'Lists',
        description: 'Private shopping lists and checklists.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f7f7f5',
        theme_color: '#2f6f4f',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // Never cache anything that is not part of the app itself.
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
