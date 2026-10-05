<script lang="ts">
  import {
    Bold,
    Download,
    FlipHorizontal2,
    FlipVertical2,
    Image as ImageIcon,
    Italic,
    LayoutGrid,
    Menu,
    MousePointer2,
    Redo2,
    RotateCcw,
    RotateCw,
    Trash2,
    Type,
    Underline,
    Undo2,
    X,
    ZoomIn,
    ZoomOut,
  } from "lucide-svelte";
  import { editor, type TextStyle } from "../editor.svelte";
  import { FONT_FAMILIES, familyFromCss } from "../fonts";
  import ConfirmModal from "./ConfirmModal.svelte";

  let { onopenfiles }: { onopenfiles: () => void } = $props();

  const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96];
  const SWATCHES = [
    { color: "#000000", name: "Negro" },
    { color: "#ffffff", name: "Blanco" },
    { color: "#d32f2f", name: "Rojo" },
    { color: "#1976d2", name: "Azul" },
    { color: "#2e7d32", name: "Verde" },
  ];

  let imageInput = $state<HTMLInputElement>();
  let confirmClose = $state(false);

  const inEditor = $derived(editor.hasDocument && editor.view === "editor");
  const selection = $derived(editor.selection);
  /** Text controls edit the selected text, or the style of the next text. */
  const showTextControls = $derived(inEditor && (selection?.text != null || editor.tool === "text"));
  const textStyle = $derived<TextStyle>(selection?.text ?? editor.textStyle);
  // The properties row is always present in the editor so the page never jumps
  // when a tool is picked or something gets selected.
  const showContextBar = $derived(inEditor);

  function setStyle(style: Partial<TextStyle>) {
    editor.applyTextStyle(style);
  }

  function onFontSize(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 4 && value <= 400) setStyle({ fontSize: value });
  }

  async function onImageChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    for (const file of files) await editor.addImage(file);
  }

  function requestClose() {
    if (editor.isDirty) confirmClose = true;
    else editor.closeDocument();
  }
</script>

{#snippet zoomControls(placement: string)}
  <div class="group {placement}" aria-label="Zoom">
    <button class="icon" title="Alejar (Ctrl -)" aria-label="Alejar" onclick={() => editor.zoomOut()}>
      <ZoomOut size={18} />
    </button>
    <button class="zoom-value" title="Ajustar al ancho" onclick={() => editor.fitWidth()}>
      {Math.round(editor.zoom * 100)}%
    </button>
    <button class="icon" title="Acercar (Ctrl +)" aria-label="Acercar" onclick={() => editor.zoomIn()}>
      <ZoomIn size={18} />
    </button>
  </div>
{/snippet}

<header class="toolbar">
  <div class="row">
    <div class="brand">
      {#if inEditor}
        <button class="icon menu" aria-label="Mostrar páginas" onclick={() => (editor.sidebarOpen = true)}>
          <Menu size={20} />
        </button>
      {/if}
      <img src="/paty.png" alt="" class="logo" />
      <span class="title"><span class="yta">yta</span><span class="p">P</span><span class="df">DF</span></span>
      {#if editor.hasDocument}
        <span class="doc-name" title={editor.documentName}>{editor.documentName}</span>
      {/if}
    </div>

    {#if inEditor}
      <div class="group" role="toolbar" aria-label="Herramientas">
        <button
          class="icon"
          class:active={editor.tool === "select"}
          aria-pressed={editor.tool === "select"}
          title="Seleccionar (V)"
          aria-label="Seleccionar"
          onclick={() => (editor.tool = "select")}
        >
          <MousePointer2 size={18} />
        </button>
        <button
          class="icon labeled"
          class:active={editor.tool === "text"}
          aria-pressed={editor.tool === "text"}
          title="Añadir texto: haz clic en la página (T)"
          aria-label="Añadir texto"
          onclick={() => (editor.tool = editor.tool === "text" ? "select" : "text")}
        >
          <Type size={18} />
          <span class="hide-mobile">Texto</span>
        </button>
        <button class="icon labeled" title="Añadir imagen" aria-label="Añadir imagen" onclick={() => imageInput?.click()}>
          <ImageIcon size={18} />
          <span class="hide-mobile">Imagen</span>
        </button>
        <input
          bind:this={imageInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onchange={onImageChosen}
        />
      </div>
    {/if}

    {#if editor.hasDocument}
      <div class="spacer"></div>

      {#if inEditor}
        {@render zoomControls("zoom")}
      {:else}
        <button class="icon labeled" aria-label="Volver al editor" onclick={() => (editor.view = "editor")}>
          <LayoutGrid size={18} />
          <span class="hide-mobile">Editor</span>
        </button>
      {/if}

      <div class="group">
        <button
          class="icon"
          title="Deshacer (Ctrl Z)"
          aria-label="Deshacer"
          disabled={!editor.canUndo}
          onclick={() => editor.undo()}
        >
          <Undo2 size={18} />
        </button>
        <button
          class="icon"
          title="Rehacer (Ctrl Y)"
          aria-label="Rehacer"
          disabled={!editor.canRedo}
          onclick={() => editor.redo()}
        >
          <Redo2 size={18} />
        </button>
      </div>

      <button
        class="primary"
        disabled={editor.busy !== null}
        onclick={() => editor.exportPdf()}
        title="Descargar el PDF editado (Ctrl S)"
        aria-label="Exportar PDF"
      >
        <Download size={18} />
        <span class="hide-mobile">Exportar PDF</span>
      </button>
      <button class="icon" title="Cerrar documento" aria-label="Cerrar documento" onclick={requestClose}>
        <X size={20} />
      </button>
    {:else}
      <div class="spacer"></div>
      <button class="primary" onclick={onopenfiles}>Abrir PDF</button>
    {/if}
  </div>

  {#if showContextBar}
    <div class="row context" role="toolbar" aria-label="Propiedades">
      {@render zoomControls("zoom-compact")}
      {#if showTextControls}
        <div class="group">
          <select
            class="font"
            aria-label="Fuente"
            value={familyFromCss(textStyle.fontFamily).css}
            onchange={(event) => setStyle({ fontFamily: event.currentTarget.value })}
          >
            {#each FONT_FAMILIES as family (family.id)}
              <option value={family.css}>{family.label}</option>
            {/each}
          </select>
          <input
            class="size"
            type="number"
            min="4"
            max="400"
            step="1"
            list="font-sizes"
            aria-label="Tamaño de fuente"
            value={textStyle.fontSize}
            onchange={onFontSize}
          />
          <datalist id="font-sizes">
            {#each FONT_SIZES as size (size)}
              <option value={size}></option>
            {/each}
          </datalist>
        </div>

        <div class="group">
          <input
            class="color"
            type="color"
            aria-label="Color del texto"
            title="Color del texto"
            value={textStyle.fill}
            oninput={(event) => setStyle({ fill: event.currentTarget.value })}
          />
          {#each SWATCHES as swatch (swatch.color)}
            <button
              class="swatch"
              class:selected={textStyle.fill === swatch.color}
              style:background-color={swatch.color}
              title={swatch.name}
              aria-label="Color {swatch.name.toLowerCase()}"
              onclick={() => setStyle({ fill: swatch.color })}
            ></button>
          {/each}
        </div>

        <div class="group">
          <button
            class="icon"
            class:active={textStyle.fontWeight === "bold"}
            aria-pressed={textStyle.fontWeight === "bold"}
            title="Negrita"
            aria-label="Negrita"
            onclick={() => setStyle({ fontWeight: textStyle.fontWeight === "bold" ? "normal" : "bold" })}
          >
            <Bold size={16} />
          </button>
          <button
            class="icon"
            class:active={textStyle.fontStyle === "italic"}
            aria-pressed={textStyle.fontStyle === "italic"}
            title="Cursiva"
            aria-label="Cursiva"
            onclick={() => setStyle({ fontStyle: textStyle.fontStyle === "italic" ? "normal" : "italic" })}
          >
            <Italic size={16} />
          </button>
          <button
            class="icon"
            class:active={textStyle.underline}
            aria-pressed={textStyle.underline}
            title="Subrayado"
            aria-label="Subrayado"
            onclick={() => setStyle({ underline: !textStyle.underline })}
          >
            <Underline size={16} />
          </button>
        </div>
      {/if}

      {#if selection}
        <div class="group">
          <button class="icon" title="Girar a la izquierda" aria-label="Girar a la izquierda" onclick={() => editor.rotateSelection(-90)}>
            <RotateCcw size={16} />
          </button>
          <button class="icon" title="Girar a la derecha" aria-label="Girar a la derecha" onclick={() => editor.rotateSelection(90)}>
            <RotateCw size={16} />
          </button>
          <button
            class="icon"
            class:active={selection.flipX}
            aria-pressed={selection.flipX}
            title="Voltear horizontalmente"
            aria-label="Voltear horizontalmente"
            onclick={() => editor.flipSelection("x")}
          >
            <FlipHorizontal2 size={16} />
          </button>
          <button
            class="icon"
            class:active={selection.flipY}
            aria-pressed={selection.flipY}
            title="Voltear verticalmente"
            aria-label="Voltear verticalmente"
            onclick={() => editor.flipSelection("y")}
          >
            <FlipVertical2 size={16} />
          </button>
        </div>

        <label class="group opacity">
          <span>Opacidad</span>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={selection.opacity}
            oninput={(event) => editor.setSelectionOpacity(Number(event.currentTarget.value))}
          />
          <span class="value">{Math.round(selection.opacity * 100)}%</span>
        </label>

        <button class="icon danger" title="Eliminar (Supr)" aria-label="Eliminar selección" onclick={() => editor.deleteSelection()}>
          <Trash2 size={16} />
        </button>
      {:else if editor.tool === "text"}
        <span class="hint">Haz clic en la página donde quieras escribir.</span>
      {:else}
        <span class="hint">Selecciona un texto o una imagen para editarlo, o añade contenido con Texto e Imagen.</span>
      {/if}
    </div>
  {/if}
</header>

{#if confirmClose}
  <ConfirmModal
    title="¿Cerrar el documento?"
    message="Hay cambios que todavía no has exportado. Si cierras el documento, se perderán."
    confirmText="Cerrar sin exportar"
    danger
    onconfirm={() => {
      confirmClose = false;
      editor.closeDocument();
    }}
    oncancel={() => (confirmClose = false)}
  />
{/if}

<style>
  .toolbar {
    position: relative;
    z-index: 100;
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    box-shadow: var(--shadow-sm);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 0 12px 0 16px;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .row.context {
    min-height: 48px;
    gap: 16px;
    border-top: 1px solid var(--color-border);
    background: #fbfbfc;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex-shrink: 0;
    margin-right: 12px;
  }
  .logo {
    height: 28px;
    width: auto;
  }
  .title {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.5px;
    white-space: nowrap;
  }
  .yta {
    color: #2b2b2b;
  }
  .p {
    background: linear-gradient(to right, #2b2b2b 50%, var(--color-primary) 50%);
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
  }
  .df {
    color: var(--color-primary);
  }
  .doc-name {
    max-width: 240px;
    overflow: hidden;
    padding-left: 12px;
    border-left: 1px solid var(--color-border);
    color: var(--color-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .spacer {
    flex: 1;
  }
  button {
    border: none;
    background: transparent;
    cursor: pointer;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 36px;
    height: 36px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    color: #4a4f57;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .icon:hover:not(:disabled) {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }
  .icon.active {
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .icon:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .icon.danger {
    color: var(--color-danger);
  }
  .icon.danger:hover {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }
  .menu,
  .zoom-compact {
    display: none;
  }
  .zoom-value {
    min-width: 56px;
    height: 32px;
    border-radius: var(--radius-sm);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    color: #4a4f57;
  }
  .zoom-value:hover {
    background: var(--color-surface-muted);
  }
  .primary {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 16px;
    border-radius: var(--radius-sm);
    background: var(--color-primary);
    color: white;
    font-weight: 500;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .font,
  .size {
    height: 32px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    padding: 0 8px;
  }
  .size {
    width: 72px;
  }
  .color {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: none;
    cursor: pointer;
  }
  .color::-webkit-color-swatch-wrapper {
    padding: 2px;
  }
  .color::-webkit-color-swatch {
    border: none;
    border-radius: 4px;
  }
  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.2);
    flex-shrink: 0;
  }
  .swatch.selected {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .opacity {
    gap: 8px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .opacity input {
    width: 96px;
    accent-color: var(--color-primary);
  }
  .opacity .value {
    min-width: 38px;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    flex: 1;
    min-width: 160px;
    color: var(--color-text-muted);
    font-size: 13px;
    line-height: 1.3;
  }

  @media (max-width: 768px) {
    .row {
      gap: 6px;
      padding: 0 8px;
    }
    .title,
    .doc-name,
    .hide-mobile,
    .zoom {
      display: none;
    }
    .zoom-compact {
      display: flex;
      padding-right: 6px;
      border-right: 1px solid var(--color-border);
    }
    .menu {
      display: inline-flex;
    }
    .brand {
      margin-right: 4px;
    }
    .primary {
      padding: 0 12px;
    }
    .row.context {
      gap: 10px;
    }
  }
  @media (max-width: 480px) {
    .brand:has(.menu) .logo {
      display: none;
    }
  }
</style>
