<script lang="ts">
  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher();

  export let title: string = "Confirmación";
  export let message: string = "¿Estás seguro?";
  export let confirmText: string = "Sí, eliminar";
  export let cancelText: string = "Cancelar";

  function handleConfirm() {
    dispatch("confirm");
  }

  function handleCancel() {
    dispatch("cancel");
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      handleCancel();
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" on:click={handleCancel}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-content" on:click|stopPropagation>
    <h3>{title}</h3>
    <p>{message}</p>
    <div class="modal-actions">
      <button class="cancel-btn" on:click={handleCancel}>{cancelText}</button>
      <button class="confirm-btn" on:click={handleConfirm}>{confirmText}</button
      >
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
  }
  .modal-content {
    background: white;
    padding: 24px;
    border-radius: 12px;
    width: 400px;
    max-width: 90%;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    text-align: center;
  }
  .modal-content h3 {
    margin-top: 0;
    font-size: 20px;
    color: #333;
  }
  .modal-content p {
    color: #666;
    margin-bottom: 24px;
    line-height: 1.5;
  }
  .modal-actions {
    display: flex;
    justify-content: center;
    gap: 16px;
  }
  button {
    padding: 10px 20px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  .cancel-btn {
    background: transparent;
    border: 1px solid #ccc;
    color: #555;
  }
  .cancel-btn:hover {
    background: #f5f5f5;
  }
  .confirm-btn {
    background: #ef4444;
    border: 1px solid #ef4444;
    color: white;
  }
  .confirm-btn:hover {
    background: #dc2626;
  }
</style>
