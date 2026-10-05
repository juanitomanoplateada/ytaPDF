<script lang="ts">
  import { Canvas, PencilBrush, type Path } from "fabric";
  import { Eraser, Trash2 } from "lucide-svelte";
  import { editor, type SignatureData } from "../editor.svelte";
  import {
    combineStrokes,
    deleteSavedSignature,
    loadSavedSignatures,
    saveSignature,
    type SavedSignature,
  } from "../signatures";
  import Modal from "./Modal.svelte";

  const COLORS = [
    { color: "#111111", name: "Negro" },
    { color: "#1a3a8f", name: "Azul" },
  ];
  const WIDTHS = [
    { width: 2, name: "Fina" },
    { width: 3.5, name: "Media" },
    { width: 5, name: "Gruesa" },
  ];

  let padElement: HTMLCanvasElement;
  let padBox: HTMLDivElement;
  let pad: Canvas | null = null;
  let strokes = $state(0);
  let color = $state(COLORS[1].color);
  let width = $state(WIDTHS[1].width);
  let remember = $state(false);
  let saved = $state<SavedSignature[]>(loadSavedSignatures());

  $effect(() => {
    const instance = new Canvas(padElement, {
      width: padBox.clientWidth,
      height: 200,
      isDrawingMode: true,
      backgroundColor: "#ffffff",
    });
    const brush = new PencilBrush(instance);
    brush.decimate = 1.5;
    instance.freeDrawingBrush = brush;
    instance.on("path:created", () => (strokes = instance.getObjects().length));
    pad = instance;
    return () => {
      pad = null;
      void instance.dispose();
    };
  });

  // Pen settings apply to new strokes and, for a consistent signature, to the existing ones.
  $effect(() => {
    const brushColor = color;
    const brushWidth = width;
    if (!pad?.freeDrawingBrush) return;
    pad.freeDrawingBrush.color = brushColor;
    pad.freeDrawingBrush.width = brushWidth;
    for (const path of pad.getObjects()) path.set({ stroke: brushColor, strokeWidth: brushWidth });
    pad.requestRenderAll();
  });

  function clear() {
    pad?.remove(...(pad?.getObjects() ?? []));
    strokes = 0;
  }

  function build(): SignatureData | null {
    if (!pad) return null;
    const paths = pad.getObjects() as Path[];
    if (paths.length === 0) return null;
    const boxes = paths.map((path) => path.getBoundingRect());
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    const right = Math.max(...boxes.map((b) => b.left + b.width));
    const bottom = Math.max(...boxes.map((b) => b.top + b.height));
    const combined = combineStrokes(
      paths.map((path) => path.path as unknown as [string, ...number[]][]),
      { left, top, width: right - left, height: bottom - top },
      width,
    );
    return { ...combined, color, strokeWidth: width };
  }

  function insert() {
    const signature = build();
    if (!signature) return;
    if (remember) saved = saveSignature(signature);
    editor.insertSignature(signature);
  }
</script>

<Modal title="Añadir firma" onclose={() => (editor.signatureOpen = false)} wide>
  {#if saved.length > 0}
    <section class="saved" aria-label="Firmas guardadas">
      <h3>Firmas guardadas</h3>
      <div class="saved-list">
        {#each saved as signature (signature.id)}
          <div class="saved-item">
            <button class="use" title="Usar esta firma" onclick={() => editor.insertSignature(signature)}>
              <svg viewBox="0 0 {signature.width} {signature.height}" aria-hidden="true">
                <path
                  d={signature.path}
                  fill="none"
                  stroke={signature.color}
                  stroke-width={signature.strokeWidth}
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span class="visually-hidden">Usar esta firma</span>
            </button>
            <button
              class="forget"
              title="Olvidar esta firma"
              aria-label="Olvidar esta firma"
              onclick={() => (saved = deleteSavedSignature(signature.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <p class="intro">Dibuja tu firma con el ratón, el dedo o un lápiz digital. Se insertará como trazo vectorial.</p>
  <div class="pad" bind:this={padBox}>
    <canvas bind:this={padElement}></canvas>
    {#if strokes === 0}
      <span class="placeholder" aria-hidden="true">Firma aquí</span>
    {/if}
    <span class="baseline" aria-hidden="true"></span>
  </div>

  <div class="options">
    <div class="option" role="radiogroup" aria-label="Color">
      {#each COLORS as option (option.color)}
        <button
          class="color"
          role="radio"
          aria-checked={color === option.color}
          aria-label={option.name}
          title={option.name}
          style:background-color={option.color}
          onclick={() => (color = option.color)}
        ></button>
      {/each}
    </div>
    <div class="option" role="radiogroup" aria-label="Grosor">
      {#each WIDTHS as option (option.width)}
        <button
          class="width"
          role="radio"
          aria-checked={width === option.width}
          onclick={() => (width = option.width)}
        >
          {option.name}
        </button>
      {/each}
    </div>
    <button class="clear" onclick={clear} disabled={strokes === 0}>
      <Eraser size={16} />
      Borrar
    </button>
  </div>

  <label class="remember">
    <input type="checkbox" bind:checked={remember} />
    Guardar esta firma en este navegador para reutilizarla
  </label>

  <div class="actions">
    <button class="secondary" onclick={() => (editor.signatureOpen = false)}>Cancelar</button>
    <button class="primary" onclick={insert} disabled={strokes === 0}>Insertar firma</button>
  </div>
</Modal>

<style>
  h3 {
    margin: 4px 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-muted);
  }
  .saved {
    margin-bottom: 16px;
  }
  .saved-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .saved-item {
    position: relative;
  }
  .use {
    display: grid;
    place-items: center;
    width: 132px;
    height: 64px;
    padding: 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: #fff;
    cursor: pointer;
  }
  .use:hover {
    border-color: var(--color-primary);
  }
  .use svg {
    width: 100%;
    height: 100%;
  }
  .forget {
    position: absolute;
    top: -8px;
    right: -8px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--color-border);
    border-radius: 50%;
    background: #fff;
    color: var(--color-danger);
    cursor: pointer;
  }
  .intro {
    margin: 0 0 10px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .pad {
    position: relative;
    height: 200px;
    border: 1px dashed #b8c0cc;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: #fff;
    touch-action: none;
  }
  .pad :global(.canvas-container) {
    margin: 0 !important;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #c2c8d0;
    font-size: 22px;
    pointer-events: none;
  }
  .baseline {
    position: absolute;
    left: 24px;
    right: 24px;
    bottom: 48px;
    border-bottom: 1px solid #e3e6ea;
    pointer-events: none;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    margin: 12px 0;
  }
  .option {
    display: flex;
    gap: 6px;
  }
  .color {
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }
  .color[aria-checked="true"] {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .width,
  .clear {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font-size: 13px;
    cursor: pointer;
  }
  .width[aria-checked="true"] {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .clear {
    margin-left: auto;
  }
  .clear:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .remember {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 20px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    padding: 9px 16px;
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .secondary {
    background: var(--color-surface-muted);
    border: 1px solid var(--color-border) !important;
  }
  .primary {
    background: var(--color-primary);
    color: white;
  }
  .primary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
</style>
