<script lang="ts">
  import { editorStore } from "../store";
  import {
    ZoomIn,
    ZoomOut,
    Type,
    MousePointer2,
    Download,
    Bold,
    Italic,
    Underline,
    Undo2,
    Redo2,
    RotateCw,
    RotateCcw,
    FlipHorizontal,
    FlipVertical,
    Image as ImageIcon,
    Menu,
  } from "lucide-svelte";

  const FONT_SIZES = [
    8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96, 120,
  ];

  function getClosestFontSize(currentSize: number): number {
    if (!currentSize) return 24;
    return FONT_SIZES.reduce((prev, curr) =>
      Math.abs(curr - currentSize) < Math.abs(prev - currentSize) ? curr : prev,
    );
  }

  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher();

  function undo() {
    editorStore.update((s) => {
      if (s.historyIndex > 0) {
        return {
          ...s,
          historyIndex: s.historyIndex - 1,
          pagesAnnotations: s.history[s.historyIndex - 1],
        };
      }
      return s;
    });
    window.dispatchEvent(new CustomEvent("force-reload-annotations"));
  }

  function redo() {
    editorStore.update((s) => {
      if (s.historyIndex < s.history.length - 1) {
        return {
          ...s,
          historyIndex: s.historyIndex + 1,
          pagesAnnotations: s.history[s.historyIndex + 1],
        };
      }
      return s;
    });
    window.dispatchEvent(new CustomEvent("force-reload-annotations"));
  }

  function zoomIn() {
    $editorStore.globalZoom = Math.min($editorStore.globalZoom + 0.25, 3.0);
  }

  function zoomOut() {
    $editorStore.globalZoom = Math.max($editorStore.globalZoom - 0.25, 0.5);
  }

  function setTool(tool: "SELECT" | "TEXT") {
    $editorStore.activeTool = tool;
  }

  function handleAddImageUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      window.dispatchEvent(
        new CustomEvent("add-image", { detail: { dataUrl } }),
      );
    };
    reader.readAsDataURL(file);
    (e.target as HTMLInputElement).value = "";
  }

  function updateTextStyle(key: string, value: any) {
    if (!$editorStore.activeTextParams) return;
    $editorStore.activeTextParams = {
      ...$editorStore.activeTextParams,
      [key]: value,
    };
    dispatch("updateTextStyle", { key, value });
  }

  function toggleBold() {
    if (!$editorStore.activeTextParams) return;
    const isBold = $editorStore.activeTextParams.fontWeight === "bold";
    updateTextStyle("fontWeight", isBold ? "normal" : "bold");
  }

  function toggleItalic() {
    if (!$editorStore.activeTextParams) return;
    const isItalic = $editorStore.activeTextParams.fontStyle === "italic";
    updateTextStyle("fontStyle", isItalic ? "normal" : "italic");
  }

  function toggleUnderline() {
    if (!$editorStore.activeTextParams) return;
    const isUnderlined = $editorStore.activeTextParams.underline;
    updateTextStyle("underline", !isUnderlined);
  }

  function triggerExport() {
    dispatch("exportPdf");
  }

  function handleModifyObject(action: string, value?: number) {
    if (!$editorStore.activeObjectParams) return;
    window.dispatchEvent(
      new CustomEvent("modify-object", { detail: { action, value } }),
    );
  }
</script>

<div class="toolbar glass-shadow">
  <div class="tools-group logo-group">
    {#if !$editorStore.isOrganizerMode && $editorStore.originalPdfBytes}
      <button
        class="menu-btn"
        on:click={() => ($editorStore.isMobileSidebarOpen = true)}
        title="Abrir menú"
      >
        <Menu size={20} />
      </button>
    {/if}
    <img src="/paty.png" alt="ytaPDF Logo" class="app-logo" />
    <span class="app-title">
      <span class="yta">yta</span><span class="p-letter">P</span><span
        class="df">DF</span
      >
    </span>
  </div>

  <div class="tools-group">
    <button
      class:active={$editorStore.activeTool === "SELECT"}
      on:click={() => setTool("SELECT")}
      title="Select Object"
    >
      <MousePointer2 size={18} />
    </button>
    <button
      class:active={$editorStore.activeTool === "TEXT"}
      on:click={() => setTool("TEXT")}
      title="Agregar Texto"
    >
      <Type size={18} />
      <span class="hide-mobile">Texto</span>
    </button>
    <button
      title="Añadir Imagen"
      on:click={() => document.getElementById("add-image-input")?.click()}
    >
      <ImageIcon size={18} />
    </button>
    <input
      id="add-image-input"
      type="file"
      accept="image/*"
      style="display: none;"
      on:change={handleAddImageUpload}
    />
  </div>

  {#if $editorStore.activeObjectParams}
    <div class="tools-divider"></div>
    <div class="tools-group">
      <button
        on:click={() => handleModifyObject("rotate", -90)}
        title="Rotar a la izquierda"
      >
        <RotateCcw size={16} />
      </button>
      <button
        on:click={() => handleModifyObject("rotate", 90)}
        title="Rotar a la derecha"
      >
        <RotateCw size={16} />
      </button>
      <div class="tools-divider-small"></div>
      <button
        class:active={$editorStore.activeObjectParams.flipX}
        on:click={() => handleModifyObject("flipX")}
        title="Voltear horizontalmente"
      >
        <FlipHorizontal size={16} />
      </button>
      <button
        class:active={$editorStore.activeObjectParams.flipY}
        on:click={() => handleModifyObject("flipY")}
        title="Voltear verticalmente"
      >
        <FlipVertical size={16} />
      </button>

      <div class="tools-divider-small"></div>

      <div class="opacity-control" title="Opacidad">
        <label for="opacity-slider" class="opacity-label">Opacidad</label>
        <input
          id="opacity-slider"
          type="range"
          min="0.1"
          max="1"
          step="0.05"
          value={$editorStore.activeObjectParams.opacity ?? 1}
          on:input={(e) =>
            handleModifyObject("opacity", parseFloat(e.currentTarget.value))}
        />
        <span class="opacity-value"
          >{Math.round(
            ($editorStore.activeObjectParams.opacity ?? 1) * 100,
          )}%</span
        >
      </div>
    </div>
  {/if}

  {#if $editorStore.activeTextParams}
    <div class="tools-divider"></div>
    <div class="tools-group text-controls">
      <select
        class="font-select"
        value={$editorStore.activeTextParams.fontFamily}
        on:change={(e) => updateTextStyle("fontFamily", e.currentTarget.value)}
      >
        <option value="Helvetica">Helvetica</option>
        <option value="Times New Roman">Times New Roman</option>
        <option value="Courier">Courier</option>
      </select>

      <select
        class="size-select"
        value={getClosestFontSize($editorStore.activeTextParams.fontSize)}
        on:change={(e) =>
          updateTextStyle("fontSize", parseInt(e.currentTarget.value))}
      >
        {#each FONT_SIZES as size}
          <option value={size}>{size}</option>
        {/each}
      </select>

      <input
        type="color"
        class="color-picker"
        value={$editorStore.activeTextParams.fill}
        title="Color manual"
        on:change={(e) => updateTextStyle("fill", e.currentTarget.value)}
      />

      <div class="color-swatches">
        <button
          class="swatch"
          style="background-color: #000000"
          on:click={() => updateTextStyle("fill", "#000000")}
          title="Negro"
        ></button>
        <button
          class="swatch"
          style="background-color: #ffffff"
          on:click={() => updateTextStyle("fill", "#ffffff")}
          title="Blanco"
        ></button>
        <button
          class="swatch"
          style="background-color: #ef4444"
          on:click={() => updateTextStyle("fill", "#ef4444")}
          title="Rojo"
        ></button>
        <button
          class="swatch"
          style="background-color: #3b82f6"
          on:click={() => updateTextStyle("fill", "#3b82f6")}
          title="Azul"
        ></button>
        <button
          class="swatch"
          style="background-color: #22c55e"
          on:click={() => updateTextStyle("fill", "#22c55e")}
          title="Verde"
        ></button>
      </div>

      <div class="tools-divider-small"></div>

      <button
        class:active={$editorStore.activeTextParams.fontWeight === "bold"}
        on:click={toggleBold}
        title="Bold"
      >
        <Bold size={16} />
      </button>
      <button
        class:active={$editorStore.activeTextParams.fontStyle === "italic"}
        on:click={toggleItalic}
        title="Italic"
      >
        <Italic size={16} />
      </button>
      <button
        class:active={$editorStore.activeTextParams.underline}
        on:click={toggleUnderline}
        title="Underline"
      >
        <Underline size={16} />
      </button>
    </div>
  {/if}

  <div class="tools-group right">
    <button on:click={zoomOut} title="Alejar">
      <ZoomOut size={18} />
    </button>
    <span class="zoom-level">{Math.round($editorStore.globalZoom * 100)}%</span>
    <button on:click={zoomIn} title="Acercar">
      <ZoomIn size={18} />
    </button>
  </div>

  <div class="separator"></div>

  <div class="tools-group">
    <button
      title="Deshacer"
      on:click={undo}
      disabled={$editorStore.historyIndex <= 0}
      class:disabled={$editorStore.historyIndex <= 0}
    >
      <Undo2 size={18} />
    </button>
    <button
      title="Rehacer"
      on:click={redo}
      disabled={$editorStore.historyIndex >= $editorStore.history.length - 1}
      class:disabled={$editorStore.historyIndex >=
        $editorStore.history.length - 1}
    >
      <Redo2 size={18} />
    </button>
  </div>

  <div class="separator"></div>

  <div class="tools-group right">
    <button
      class="primary"
      on:click={triggerExport}
      title="Descargar el documento modificado"
      disabled={!$editorStore.originalPdfBytes}
    >
      <Download size={18} />
      <span class="hide-mobile">Exportar PDF</span>
    </button>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 56px;
    background: #ffffff;
    border-bottom: 1px solid #e0e0e0;
    z-index: 100;
  }
  .glass-shadow {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  }
  .tools-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tools-group.logo-group {
    margin-right: 24px;
    gap: 12px;
  }
  .app-logo {
    height: 28px;
    width: auto;
    object-fit: contain;
  }
  .app-title {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.5px;
  }
  .yta {
    color: #2b2b2b;
  }
  .p-letter {
    background: linear-gradient(to right, #2b2b2b 50%, #1976d2 50%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    color: transparent;
  }
  .df {
    color: #1976d2;
  }
  .tools-divider {
    width: 1px;
    height: 24px;
    background: #e0e0e0;
    margin: 0 16px;
  }
  .tools-divider-small {
    width: 1px;
    height: 16px;
    background: #e0e0e0;
    margin: 0 4px;
  }
  .font-select {
    height: 32px;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 0 8px;
    font-family: inherit;
    font-size: 14px;
    color: #333;
    outline: none;
  }
  .size-select {
    height: 32px;
    width: 60px;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 0 4px;
    font-family: inherit;
    font-size: 14px;
    color: #333;
    outline: none;
    cursor: pointer;
  }
  .color-picker {
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    background: transparent;
  }
  .color-picker::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  .color-picker::-webkit-color-swatch {
    border: 1px solid #ddd;
    border-radius: 4px;
  }
  .color-swatches {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: 4px;
  }
  .opacity-control {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 8px;
  }
  .opacity-label {
    font-size: 13px;
    color: #555;
    font-weight: 500;
  }
  .opacity-control input[type="range"] {
    width: 80px;
    accent-color: #1976d2;
    cursor: pointer;
  }
  .opacity-value {
    font-size: 13px;
    color: #555;
    min-width: 35px;
  }
  button.swatch {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    padding: 0;
    border: 1px solid #ccc;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }
  button.swatch:hover {
    transform: scale(1.15);
    border-color: #999;
  }
  .tools-group.right {
    margin-left: auto;
  }
  button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #4a4a4a;
    cursor: pointer;
    transition: all 0.2s;
  }
  button:hover {
    background: #f0f0f0;
    color: #1a1a1a;
  }
  button.active {
    background: #e3f2fd;
    color: #1976d2;
  }
  button.primary {
    width: auto;
    padding: 0 16px;
    background: #1976d2;
    color: white;
    font-weight: 500;
  }
  button.primary:hover {
    background: #1565c0;
    color: white;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .zoom-level {
    font-size: 14px;
    font-weight: 500;
    color: #4a4a4a;
    min-width: 45px;
    text-align: center;
  }
  .menu-btn {
    display: none;
  }

  @media (max-width: 768px) {
    .toolbar {
      overflow-x: auto;
      padding: 0 8px;
    }
    .toolbar::-webkit-scrollbar {
      height: 4px;
    }
    .toolbar::-webkit-scrollbar-thumb {
      background: #ccc;
      border-radius: 4px;
    }
    .app-title {
      display: none;
    }
    .app-logo {
      height: 24px;
    }
    .hide-mobile {
      display: none;
    }
    .menu-btn {
      display: flex;
    }
    .zoom-level {
      display: none;
    }
    button.primary {
      padding: 0 10px;
    }
  }
</style>
