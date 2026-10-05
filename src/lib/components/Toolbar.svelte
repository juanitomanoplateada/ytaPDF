<script lang="ts">
  import {
    ArrowDown,
    ArrowUp,
    Bold,
    BringToFront,
    Circle,
    CopyPlus,
    Download,
    EllipsisVertical,
    EyeOff,
    FlipHorizontal2,
    FlipVertical2,
    Highlighter,
    History,
    Image as ImageIcon,
    Italic,
    Keyboard,
    LayoutGrid,
    Lock,
    LockOpen,
    Menu as MenuIcon,
    Minus,
    MonitorDown,
    MousePointer2,
    MoveUpRight,
    Redo2,
    RotateCcw,
    RotateCw,
    SendToBack,
    Shapes,
    Signature,
    Square,
    Trash2,
    Type,
    Underline,
    Undo2,
    X,
    ZoomIn,
    ZoomOut,
  } from "lucide-svelte";
  import { editor, type DrawTool, type ShapeStyle, type TextStyle } from "../editor.svelte";
  import { ensureFamilyLoaded } from "../embeddedFonts";
  import { FONT_FAMILIES, familyFromCss, type EmbeddedFamilyId } from "../fonts";
  import { notifications } from "../notifications.svelte";
  import { pwa } from "../pwa.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import Menu from "./Menu.svelte";

  let { onopenfiles }: { onopenfiles: () => void } = $props();

  const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96];
  const STROKE_WIDTHS = [1, 2, 3, 4, 6, 8, 12];
  const SWATCHES = [
    { color: "#000000", name: "Negro" },
    { color: "#ffffff", name: "Blanco" },
    { color: "#d32f2f", name: "Rojo" },
    { color: "#1976d2", name: "Azul" },
    { color: "#2e7d32", name: "Verde" },
  ];
  const HIGHLIGHTS = [
    { color: "#ffe14d", name: "Amarillo" },
    { color: "#7ee081", name: "Verde" },
    { color: "#ff9ec7", name: "Rosa" },
    { color: "#7fc8ff", name: "Azul" },
  ];
  const SHAPE_TOOLS: { tool: DrawTool; label: string; icon: typeof Square; hint: string }[] = [
    { tool: "rect", label: "Rectángulo", icon: Square, hint: "Arrastra sobre la página para dibujar un rectángulo. Con Mayús, un cuadrado." },
    { tool: "ellipse", label: "Elipse", icon: Circle, hint: "Arrastra sobre la página para dibujar una elipse. Con Mayús, un círculo." },
    { tool: "line", label: "Línea", icon: Minus, hint: "Arrastra para trazar una línea. Con Mayús, en ángulos de 45°." },
    { tool: "arrow", label: "Flecha", icon: MoveUpRight, hint: "Arrastra desde el origen hasta donde debe apuntar la flecha." },
    { tool: "highlight", label: "Resaltador", icon: Highlighter, hint: "Arrastra sobre el texto que quieras resaltar." },
    {
      tool: "redact",
      label: "Censurar",
      icon: EyeOff,
      hint: "Arrastra sobre lo que quieras ocultar. Al exportar, la página se convierte en imagen y el contenido tapado se elimina de verdad.",
    },
  ];

  let imageInput = $state<HTMLInputElement>();
  let confirmClose = $state(false);

  const inEditor = $derived(editor.hasDocument && editor.view === "editor");
  const selection = $derived(editor.selection);
  const locked = $derived(selection?.locked ?? false);
  const activeShape = $derived(SHAPE_TOOLS.find((s) => s.tool === editor.tool));
  const ShapeIcon = $derived(activeShape?.icon ?? Shapes);

  /** Text controls edit the selected text, or the style of the next text. */
  const showTextControls = $derived(selection ? selection.text !== null && !locked : editor.tool === "text");
  const textStyle = $derived<TextStyle>(selection?.text ?? editor.textStyle);

  const showShapeControls = $derived(
    selection ? selection.shape !== null && !locked : ["rect", "ellipse", "line", "arrow"].includes(editor.tool),
  );
  const shapeStyle = $derived<ShapeStyle>(selection?.shape ?? editor.shapeStyle);
  const showFill = $derived(
    selection ? ["rect", "ellipse", "multiple"].includes(selection.kind) : editor.tool === "rect" || editor.tool === "ellipse",
  );
  const showHighlight = $derived(selection ? selection.highlight !== null && !locked : editor.tool === "highlight");
  const highlightColor = $derived(selection?.highlight ?? editor.highlightColor);

  function setStyle(style: Partial<TextStyle>) {
    editor.applyTextStyle(style);
  }

  async function setFont(css: string) {
    const option = familyFromCss(css);
    if (option.embedded) {
      try {
        await ensureFamilyLoaded(option.id as EmbeddedFamilyId);
      } catch {
        notifications.error(`No se pudo cargar la fuente ${option.label}.`);
        return;
      }
    }
    setStyle({ fontFamily: css });
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

  function pickTool(tool: DrawTool) {
    editor.tool = editor.tool === tool ? "select" : tool;
  }

  const hint = $derived(
    activeShape?.hint ??
      (editor.tool === "text"
        ? "Haz clic en la página donde quieras escribir."
        : "Selecciona un elemento para editarlo, o añade texto, imágenes, firmas y formas."),
  );
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

{#snippet historyControls(placement: string)}
  <div class="group {placement}">
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
{/snippet}

{#snippet colorPicker(label: string, value: string, onpick: (color: string) => void)}
  <input
    class="color"
    type="color"
    aria-label={label}
    title={label}
    {value}
    oninput={(event) => onpick(event.currentTarget.value)}
  />
  {#each SWATCHES as swatch (swatch.color)}
    <button
      class="swatch"
      class:selected={value === swatch.color}
      style:background-color={swatch.color}
      title="{label}: {swatch.name.toLowerCase()}"
      aria-label="{label}: {swatch.name.toLowerCase()}"
      onclick={() => onpick(swatch.color)}
    ></button>
  {/each}
{/snippet}

<header class="toolbar">
  <div class="row">
    <div class="brand">
      {#if inEditor}
        <button class="icon menu" aria-label="Mostrar páginas" onclick={() => (editor.sidebarOpen = true)}>
          <MenuIcon size={20} />
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
        <button
          class="icon labeled"
          title="Añadir una firma manuscrita"
          aria-label="Añadir firma"
          onclick={() => (editor.signatureOpen = true)}
        >
          <Signature size={18} />
          <span class="hide-mobile">Firma</span>
        </button>
        <Menu label="Formas y marcas" triggerClass="icon labeled" active={activeShape !== undefined}>
          {#snippet trigger()}
            <ShapeIcon size={18} />
            <span class="hide-mobile">{activeShape?.label ?? "Formas"}</span>
          {/snippet}
          {#snippet children(close)}
            {#each SHAPE_TOOLS as shape (shape.tool)}
              <button
                role="menuitemradio"
                aria-checked={editor.tool === shape.tool}
                onclick={() => {
                  pickTool(shape.tool);
                  close();
                }}
              >
                <shape.icon size={18} />
                {shape.label}
              </button>
              {#if shape.tool === "arrow"}
                <div class="menu-separator" role="separator"></div>
              {/if}
            {/each}
            <p class="menu-note">La censura elimina el contenido tapado al exportar.</p>
          {/snippet}
        </Menu>
        <input bind:this={imageInput} type="file" accept="image/*" multiple hidden onchange={onImageChosen} />
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

      {@render historyControls("history")}

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
    {:else}
      <div class="spacer"></div>
      <button class="primary" onclick={onopenfiles}>Abrir PDF</button>
    {/if}

    <Menu label="Más opciones" align="end">
      {#snippet trigger()}
        <EllipsisVertical size={20} />
      {/snippet}
      {#snippet children(close)}
        <button
          role="menuitemcheckbox"
          aria-checked={editor.recoveryEnabled}
          onclick={() => {
            editor.setRecovery(!editor.recoveryEnabled);
            close();
          }}
        >
          <History size={18} />
          Recuperar el trabajo al volver
          <span class="switch" aria-hidden="true"></span>
        </button>
        <p class="menu-note">
          Guarda una copia del documento en este navegador mientras trabajas. No se envía a ningún sitio.
        </p>
        <button
          role="menuitem"
          onclick={() => {
            editor.shortcutsOpen = true;
            close();
          }}
        >
          <Keyboard size={18} />
          Atajos de teclado
          <span class="shortcut">?</span>
        </button>
        {#if pwa.canInstall}
          <button
            role="menuitem"
            onclick={() => {
              close();
              void pwa.install();
            }}
          >
            <MonitorDown size={18} />
            Instalar la aplicación
          </button>
        {/if}
        {#if editor.hasDocument}
          <div class="menu-separator" role="separator"></div>
          <button
            role="menuitem"
            onclick={() => {
              close();
              requestClose();
            }}
          >
            <X size={18} />
            Cerrar documento
          </button>
        {/if}
      {/snippet}
    </Menu>

    {#if editor.hasDocument}
      <button class="icon close-doc" title="Cerrar documento" aria-label="Cerrar documento" onclick={requestClose}>
        <X size={20} />
      </button>
    {/if}
  </div>

  {#if inEditor}
    <div class="row context" role="toolbar" aria-label="Propiedades">
      {@render zoomControls("zoom-compact")}
      {@render historyControls("history-compact")}

      {#if showTextControls}
        <div class="group">
          <select
            class="font"
            aria-label="Fuente"
            value={familyFromCss(textStyle.fontFamily).css}
            onchange={(event) => void setFont(event.currentTarget.value)}
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
          {@render colorPicker("Color del texto", textStyle.fill, (fill) => setStyle({ fill }))}
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

      {#if showShapeControls}
        <div class="group">
          <span class="label">Trazo</span>
          {@render colorPicker("Color del trazo", shapeStyle.stroke, (stroke) => editor.applyShapeStyle({ stroke }))}
          <select
            class="stroke-width"
            aria-label="Grosor del trazo"
            value={STROKE_WIDTHS.includes(shapeStyle.strokeWidth) ? shapeStyle.strokeWidth : 3}
            onchange={(event) => editor.applyShapeStyle({ strokeWidth: Number(event.currentTarget.value) })}
          >
            {#each STROKE_WIDTHS as width (width)}
              <option value={width}>{width} pt</option>
            {/each}
          </select>
        </div>
        {#if showFill}
          <div class="group">
            <span class="label">Relleno</span>
            <button
              class="swatch none"
              class:selected={shapeStyle.fill === null}
              title="Sin relleno"
              aria-label="Sin relleno"
              onclick={() => editor.applyShapeStyle({ fill: null })}
            ></button>
            <input
              class="color"
              type="color"
              aria-label="Color de relleno"
              title="Color de relleno"
              value={shapeStyle.fill ?? "#ffffff"}
              oninput={(event) => editor.applyShapeStyle({ fill: event.currentTarget.value })}
            />
          </div>
        {/if}
      {/if}

      {#if showHighlight}
        <div class="group">
          <span class="label">Resaltado</span>
          {#each HIGHLIGHTS as swatch (swatch.color)}
            <button
              class="swatch"
              class:selected={highlightColor === swatch.color}
              style:background-color={swatch.color}
              title={swatch.name}
              aria-label="Resaltado {swatch.name.toLowerCase()}"
              onclick={() => editor.setHighlightColor(swatch.color)}
            ></button>
          {/each}
        </div>
      {/if}

      {#if selection}
        {#if !locked}
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
        {/if}

        <div class="group" role="group" aria-label="Orden de capas">
          <button
            class="icon"
            title="Traer al frente (Ctrl Mayús ])"
            aria-label="Traer al frente"
            disabled={!selection.canRaise}
            onclick={() => editor.arrangeSelection("front")}
          >
            <BringToFront size={16} />
          </button>
          <button
            class="icon"
            title="Traer adelante (Ctrl ])"
            aria-label="Traer adelante"
            disabled={!selection.canRaise}
            onclick={() => editor.arrangeSelection("forward")}
          >
            <ArrowUp size={16} />
          </button>
          <button
            class="icon"
            title="Enviar atrás (Ctrl [)"
            aria-label="Enviar atrás"
            disabled={!selection.canLower}
            onclick={() => editor.arrangeSelection("backward")}
          >
            <ArrowDown size={16} />
          </button>
          <button
            class="icon"
            title="Enviar al fondo (Ctrl Mayús [)"
            aria-label="Enviar al fondo"
            disabled={!selection.canLower}
            onclick={() => editor.arrangeSelection("back")}
          >
            <SendToBack size={16} />
          </button>
        </div>

        {#if !locked}
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
        {/if}

        <div class="group">
          <button class="icon" title="Duplicar (Ctrl D)" aria-label="Duplicar" onclick={() => void editor.duplicateSelection()}>
            <CopyPlus size={16} />
          </button>
          <button
            class="icon"
            class:active={locked}
            aria-pressed={locked}
            title={locked ? "Desbloquear (Ctrl L)" : "Bloquear para que no se mueva (Ctrl L)"}
            aria-label={locked ? "Desbloquear" : "Bloquear"}
            onclick={() => editor.toggleLockSelection()}
          >
            {#if locked}<Lock size={16} />{:else}<LockOpen size={16} />{/if}
          </button>
          <button
            class="icon danger"
            title="Eliminar (Supr)"
            aria-label="Eliminar selección"
            disabled={locked}
            onclick={() => editor.deleteSelection()}
          >
            <Trash2 size={16} />
          </button>
        </div>
        {#if locked}
          <span class="hint">Bloqueado: no se puede mover ni editar hasta desbloquearlo.</span>
        {/if}
      {:else}
        <span class="hint">{hint}</span>
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
  .label {
    margin-right: 2px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .toolbar :global(button) {
    border: none;
    background: transparent;
    cursor: pointer;
  }
  .toolbar :global(.icon) {
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
  .toolbar :global(.icon:hover:not(:disabled)) {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }
  .toolbar :global(.icon.active) {
    background: var(--color-primary-soft);
    color: var(--color-primary);
  }
  .toolbar :global(.icon:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .icon.danger {
    color: var(--color-danger);
  }
  .icon.danger:hover:not(:disabled) {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }
  .menu,
  .zoom-compact,
  .history-compact {
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
    background: var(--color-primary) !important;
    color: white;
    font-weight: 500;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .primary:hover:not(:disabled) {
    background: var(--color-primary-hover) !important;
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .font,
  .size,
  .stroke-width {
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
  .swatch.none {
    background:
      linear-gradient(135deg, transparent 45%, var(--color-danger) 45%, var(--color-danger) 55%, transparent 55%),
      #fff !important;
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
    .zoom,
    .history,
    .close-doc {
      display: none !important;
    }
    .zoom-compact,
    .history-compact {
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
