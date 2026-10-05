<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  }

  let {
    title,
    message,
    confirmText = "Confirmar",
    cancelText = "Cancelar",
    danger = false,
    onconfirm,
    oncancel,
  }: Props = $props();
</script>

<Modal {title} onclose={oncancel}>
  <p>{message}</p>
  <div class="actions">
    <button class="secondary" onclick={oncancel} data-autofocus>{cancelText}</button>
    <button class="primary" class:danger onclick={onconfirm}>{confirmText}</button>
  </div>
</Modal>

<style>
  p {
    margin: 0 0 24px;
    color: var(--color-text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  button {
    padding: 9px 16px;
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .secondary {
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border);
  }
  .secondary:hover {
    background: #eceef1;
  }
  .primary {
    background: var(--color-primary);
    color: white;
  }
  .primary:hover {
    background: var(--color-primary-hover);
  }
  .primary.danger {
    background: var(--color-danger);
  }
  .primary.danger:hover {
    background: #c03535;
  }
</style>
