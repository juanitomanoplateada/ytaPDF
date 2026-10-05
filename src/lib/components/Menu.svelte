<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    trigger: Snippet;
    children: Snippet<[close: () => void]>;
    triggerClass?: string;
    active?: boolean;
    align?: "start" | "end";
  }

  let { label, trigger, children, triggerClass = "icon", active = false, align = "start" }: Props = $props();

  let open = $state(false);
  let button: HTMLButtonElement;
  let menu = $state<HTMLDivElement>();
  let position = $state({ top: 0, left: 0, right: 0 });

  function toggle() {
    if (open) {
      close();
      return;
    }
    // Fixed positioning keeps the menu visible inside scrollable toolbars.
    const rect = button.getBoundingClientRect();
    position = { top: rect.bottom + 6, left: rect.left, right: window.innerWidth - rect.right };
    open = true;
  }

  function close() {
    open = false;
  }

  $effect(() => {
    if (!open || !menu) return;
    menu.querySelector<HTMLElement>("[role^='menuitem']")?.focus();

    const onPointer = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node) && !button.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        button.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...(menu?.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)") ?? [])];
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? current + 1 : current - 1;
      items[(next + items.length) % items.length]?.focus();
    };
    const onScroll = () => close();
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
    };
  });
</script>

<button
  bind:this={button}
  class={triggerClass}
  class:active
  title={label}
  aria-label={label}
  aria-haspopup="menu"
  aria-expanded={open}
  onclick={toggle}
>
  {@render trigger()}
</button>

{#if open}
  <div
    bind:this={menu}
    class="menu"
    role="menu"
    aria-label={label}
    style:top="{position.top}px"
    style:left={align === "start" ? `${position.left}px` : undefined}
    style:right={align === "end" ? `${position.right}px` : undefined}
  >
    {@render children(close)}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    min-width: 220px;
    max-width: calc(100vw - 16px);
    padding: 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-lg);
    animation: menu-in 0.12s ease-out;
  }
  .menu :global([role^="menuitem"]) {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .menu :global([role^="menuitem"]:hover),
  .menu :global([role^="menuitem"]:focus-visible) {
    background: var(--color-surface-muted);
    outline: none;
  }
  .menu :global([role^="menuitem"][aria-checked="true"]),
  .menu :global([role^="menuitem"].current) {
    color: var(--color-primary);
    font-weight: 500;
  }
  .menu :global(.menu-separator) {
    height: 1px;
    margin: 6px 4px;
    background: var(--color-border);
  }
  .menu :global(.menu-note) {
    margin: 2px 10px 6px 38px;
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1.35;
  }
  .menu :global(.switch) {
    position: relative;
    flex-shrink: 0;
    width: 30px;
    height: 18px;
    margin-left: auto;
    border-radius: 999px;
    background: #c9ced6;
    transition: background 0.15s;
  }
  .menu :global(.switch)::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s;
  }
  .menu :global([aria-checked="true"] .switch) {
    background: var(--color-primary);
  }
  .menu :global([aria-checked="true"] .switch)::after {
    transform: translateX(12px);
  }
  .menu :global(.shortcut) {
    margin-left: auto;
    color: var(--color-text-muted);
    font-size: 12px;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
