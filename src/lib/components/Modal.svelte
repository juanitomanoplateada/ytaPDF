<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    onclose: () => void;
    children: Snippet;
    wide?: boolean;
  }

  let { title, onclose, children, wide = false }: Props = $props();

  let dialog: HTMLDivElement;
  const titleId = `modal-title-${Math.random().toString(36).slice(2)}`;

  const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

  $effect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initial =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();
    return () => previous?.focus();
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onclose();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep keyboard focus inside the dialog.
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div
  class="backdrop"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div
    class="dialog"
    class:wide
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    bind:this={dialog}
    {onkeydown}
  >
    <h2 id={titleId}>{title}</h2>
    {@render children()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(15, 23, 42, 0.45);
    animation: fade-in 0.15s ease-out;
  }
  .dialog {
    width: min(420px, 100%);
    padding: 24px;
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-lg);
    animation: pop-in 0.18s ease-out;
  }
  .dialog.wide {
    width: min(600px, 100%);
  }
  .dialog:focus {
    outline: none;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 600;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
  @keyframes pop-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
</style>
