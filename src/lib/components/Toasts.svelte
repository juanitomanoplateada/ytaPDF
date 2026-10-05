<script lang="ts">
  import { fly } from "svelte/transition";
  import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-svelte";
  import { notifications, type NoticeKind } from "../notifications.svelte";

  const ICONS = {
    info: Info,
    success: CircleCheck,
    warning: TriangleAlert,
    error: CircleAlert,
  } satisfies Record<NoticeKind, unknown>;
</script>

<div class="toasts" aria-live="polite">
  {#each notifications.items as notice (notice.id)}
    {@const Icon = ICONS[notice.kind]}
    <div
      class="toast {notice.kind}"
      role={notice.kind === "error" ? "alert" : "status"}
      transition:fly={{ y: 16, duration: 180 }}
    >
      <Icon size={18} />
      <p>{notice.message}</p>
      {#if notice.action}
        <button
          class="action"
          onclick={() => {
            notice.action?.run();
            notifications.dismiss(notice.id);
          }}
        >
          {notice.action.label}
        </button>
      {/if}
      <button class="close" aria-label="Cerrar aviso" onclick={() => notifications.dismiss(notice.id)}>
        <X size={16} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 20px;
    z-index: 3000;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: min(560px, calc(100vw - 24px));
    transform: translateX(-50%);
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 10px 10px 14px;
    border-radius: var(--radius-md);
    background: #1f2933;
    color: #f5f7fa;
    box-shadow: var(--shadow-lg);
    pointer-events: auto;
  }
  .toast > :global(svg) {
    flex-shrink: 0;
  }
  .toast.success > :global(svg) {
    color: #6fcf97;
  }
  .toast.warning > :global(svg) {
    color: #f2c94c;
  }
  .toast.error > :global(svg) {
    color: #ff8a80;
  }
  .toast.info > :global(svg) {
    color: #90caf9;
  }
  p {
    flex: 1;
    margin: 0;
    font-size: 13.5px;
    overflow-wrap: anywhere;
  }
  button {
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .action {
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    color: #90caf9;
    font-weight: 600;
    white-space: nowrap;
  }
  .action:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    opacity: 0.7;
  }
  .close:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.08);
  }
</style>
