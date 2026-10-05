<script lang="ts">
  import { Lock } from "lucide-svelte";
  import type { PasswordRequest } from "../editor.svelte";
  import Modal from "./Modal.svelte";

  let { request }: { request: PasswordRequest } = $props();

  let password = $state("");

  function submit(event: SubmitEvent) {
    event.preventDefault();
    request.resolve(password);
  }
</script>

<Modal title="Documento protegido" onclose={() => request.resolve(null)}>
  <form onsubmit={submit}>
    <p class="intro">
      <Lock size={16} />
      <span>«{request.fileName}» necesita una contraseña para abrirse.</span>
    </p>
    <label for="pdf-password">Contraseña</label>
    <input
      id="pdf-password"
      type="password"
      autocomplete="off"
      bind:value={password}
      aria-invalid={request.incorrect}
      aria-describedby={request.incorrect ? "pdf-password-error" : undefined}
      data-autofocus
    />
    {#if request.incorrect}
      <p id="pdf-password-error" class="error" role="alert">Contraseña incorrecta. Inténtalo de nuevo.</p>
    {/if}
    <p class="hint">La contraseña solo se usa en este navegador para descifrar el archivo. El PDF exportado no tendrá contraseña.</p>
    <div class="actions">
      <button type="button" class="secondary" onclick={() => request.resolve(null)}>Cancelar</button>
      <button type="submit" class="primary" disabled={password.length === 0}>Abrir</button>
    </div>
  </form>
</Modal>

<style>
  .intro {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 16px;
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
  }
  .intro :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
  }
  label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
  }
  input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }
  input[aria-invalid="true"] {
    border-color: var(--color-danger);
  }
  .error {
    margin: 6px 0 0;
    color: var(--color-danger);
    font-size: 13px;
  }
  .hint {
    margin: 12px 0 20px;
    color: var(--color-text-muted);
    font-size: 12.5px;
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
  .primary {
    background: var(--color-primary);
    color: white;
  }
  .primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .primary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
