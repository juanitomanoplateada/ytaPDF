<script lang="ts">
  import {
    AlignCenterHorizontal,
    AlignCenterVertical,
    AlignEndHorizontal,
    AlignEndVertical,
    AlignHorizontalDistributeCenter,
    AlignStartHorizontal,
    AlignStartVertical,
    AlignVerticalDistributeCenter,
    ArrowDown,
    ArrowUp,
    Bold,
    BringToFront,
    CalendarDays,
    Check,
    ChevronDown,
    Circle,
    Copy,
    CopyPlus,
    Crop,
    Download,
    FileImage,
    Files,
    EllipsisVertical,
    EyeOff,
    Link as LinkIcon,
    ScanText,
    Sparkles,
    StickyNote,
    FlipHorizontal2,
    FlipVertical2,
    FolderDown,
    Group,
    Hash,
    Highlighter,
    History,
    Image as ImageIcon,
    Italic,
    Keyboard,
    Languages,
    LayoutGrid,
    Link2,
    Lock,
    LockOpen,
    Menu as MenuIcon,
    Minus,
    Monitor,
    MonitorDown,
    Moon,
    MousePointer2,
    MoveUpRight,
    Pencil,
    Printer,
    Redo2,
    RotateCcw,
    RotateCw,
    Save,
    SendToBack,
    Shapes,
    Share2,
    Signature,
    Square,
    Stamp,
    Strikethrough,
    Sun,
    TextAlignCenter,
    TextAlignEnd,
    TextAlignStart,
    TextCursorInput,
    TextSelect,
    UndoDot,
    Ungroup,
    Trash2,
    Type,
    Underline,
    Undo2,
    X,
    ZoomIn,
    ZoomOut,
  } from "lucide-svelte";
  import { MM_PER_POINT, type AlignMode } from "../arrange";
  import { canShareFiles } from "../deliver";
  import { editor, type DrawTool, type LinkTarget, type ShapeStyle, type TextAlign, type TextStyle } from "../editor.svelte";
  import { ensureFamilyLoaded } from "../embeddedFonts";
  import { FONT_FAMILIES, familyFromCss, type EmbeddedFamilyId } from "../fonts";
  import { formatDate, i18n, LOCALES, t } from "../i18n.svelte";
  import { parseLinkInput } from "../links";
  import { originalFontIndex } from "../nativeText";
  import { notifications } from "../notifications.svelte";
  import { pwa } from "../pwa.svelte";
  import { theme, type ThemeChoice } from "../theme.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import Menu from "./Menu.svelte";

  let { onopenfiles }: { onopenfiles: () => void } = $props();

  const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96];
  const STROKE_WIDTHS = [1, 2, 3, 4, 6, 8, 12];
  const SWATCHES = $derived([
    { color: "#000000", name: t("Negro") },
    { color: "#ffffff", name: t("Blanco") },
    { color: "#d32f2f", name: t("Rojo") },
    { color: "#1976d2", name: t("Azul") },
    { color: "#2e7d32", name: t("Verde") },
  ]);
  const HIGHLIGHTS = $derived([
    { color: "#ffe14d", name: t("Amarillo") },
    { color: "#7ee081", name: t("Verde") },
    { color: "#ff9ec7", name: t("Rosa") },
    { color: "#7fc8ff", name: t("Azul") },
  ]);
  const SHAPE_TOOLS = $derived<{ tool: DrawTool; label: string; icon: typeof Square; hint: string }[]>([
    {
      tool: "rect",
      label: t("Rectángulo"),
      icon: Square,
      hint: t("Arrastra sobre la página para dibujar un rectángulo. Con Mayús, un cuadrado."),
    },
    {
      tool: "ellipse",
      label: t("Elipse"),
      icon: Circle,
      hint: t("Arrastra sobre la página para dibujar una elipse. Con Mayús, un círculo."),
    },
    { tool: "line", label: t("Línea"), icon: Minus, hint: t("Arrastra para trazar una línea. Con Mayús, en ángulos de 45°.") },
    {
      tool: "arrow",
      label: t("Flecha"),
      icon: MoveUpRight,
      hint: t("Arrastra desde el origen hasta donde debe apuntar la flecha."),
    },
    {
      tool: "highlight",
      label: t("Resaltador"),
      icon: Highlighter,
      hint: t("Arrastra sobre el texto que quieras resaltar, o usa «Seleccionar texto» para resaltarlo ajustado a las líneas."),
    },
    {
      tool: "redact",
      label: t("Censurar"),
      icon: EyeOff,
      hint: t(
        "Arrastra sobre lo que quieras ocultar. Al exportar, lo que quede debajo se elimina del archivo de verdad.",
      ),
    },
    {
      tool: "note",
      label: t("Nota"),
      icon: StickyNote,
      hint: t("Haz clic donde quieras dejar una nota. En el PDF será una nota de comentario que otros lectores pueden abrir y editar."),
    },
    {
      tool: "link",
      label: t("Enlace"),
      icon: LinkIcon,
      hint: t("Arrastra sobre la zona que debe abrir el enlace; luego escribe la dirección web o el número de página."),
    },
  ]);

  const ALIGNMENTS = $derived<{ value: TextAlign; label: string; icon: typeof Square }[]>([
    { value: "left", label: t("Alinear a la izquierda"), icon: TextAlignStart },
    { value: "center", label: t("Centrar"), icon: TextAlignCenter },
    { value: "right", label: t("Alinear a la derecha"), icon: TextAlignEnd },
  ]);
  const OBJECT_ALIGNMENTS = $derived<{ mode: AlignMode; label: string; icon: typeof Square }[]>([
    { mode: "left", label: t("Alinear a la izquierda"), icon: AlignStartVertical },
    { mode: "center", label: t("Centrar en horizontal"), icon: AlignCenterVertical },
    { mode: "right", label: t("Alinear a la derecha"), icon: AlignEndVertical },
    { mode: "top", label: t("Alinear arriba"), icon: AlignStartHorizontal },
    { mode: "middle", label: t("Centrar en vertical"), icon: AlignCenterHorizontal },
    { mode: "bottom", label: t("Alinear abajo"), icon: AlignEndHorizontal },
  ]);
  const LINE_HEIGHTS = [
    { value: 1, label: "1" },
    { value: 1.16, label: "1,15" },
    { value: 1.5, label: "1,5" },
    { value: 2, label: "2" },
    { value: 2.5, label: "2,5" },
    { value: 3, label: "3" },
  ];
  const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const THEMES = $derived<{ value: ThemeChoice; label: string; icon: typeof Square }[]>([
    { value: "system", label: t("Como el sistema"), icon: Monitor },
    { value: "light", label: t("Claro"), icon: Sun },
    { value: "dark", label: t("Oscuro"), icon: Moon },
  ]);
  const today = $derived(formatDate(new Date(), { day: "2-digit", month: "2-digit", year: "numeric" }));

  let imageInput = $state<HTMLInputElement>();
  let confirmClose = $state(false);
  let renaming = $state(false);
  let keepRatio = $state(true);

  const inEditor = $derived(editor.hasDocument && editor.view === "editor");
  const selection = $derived(editor.selection);
  const locked = $derived(selection?.locked ?? false);
  const activeShape = $derived(SHAPE_TOOLS.find((s) => s.tool === editor.tool));
  const ShapeIcon = $derived(activeShape?.icon ?? Shapes);
  const currentPage = $derived(editor.pages.find((page) => page.id === editor.currentPageId));

  /** Text controls edit the selected text, or the style of the next text. */
  const showTextControls = $derived(selection ? selection.text !== null && !locked : editor.tool === "text");
  const textStyle = $derived<TextStyle>(selection?.text ?? editor.textStyle);
  /** Alignment, spacing and strikethrough are for added text: document text keeps its own layout. */
  const showParagraphControls = $derived(!selection?.native);
  const lineHeight = $derived(
    LINE_HEIGHTS.reduce((best, option) =>
      Math.abs(option.value - textStyle.lineHeight) < Math.abs(best.value - textStyle.lineHeight) ? option : best,
    ).value,
  );
  /** Document text can go back to the fonts it had in the document. */
  const originalFonts = $derived(selection?.originalFonts ?? []);
  const fontValue = $derived(
    originalFontIndex(textStyle.fontFamily) !== undefined ? textStyle.fontFamily : familyFromCss(textStyle.fontFamily).css,
  );

  const showShapeControls = $derived(
    selection ? selection.shape !== null && !locked : ["rect", "ellipse", "line", "arrow", "pen"].includes(editor.tool),
  );
  /** Typed signatures are filled glyphs: they have a colour but no stroke width. */
  const showStrokeWidth = $derived(!(selection?.kind === "signature" && selection.shape?.strokeWidth === 0));
  const shapeStyle = $derived<ShapeStyle>(selection?.shape ?? editor.shapeStyle);
  const showFill = $derived(
    selection ? ["rect", "ellipse", "multiple"].includes(selection.kind) : editor.tool === "rect" || editor.tool === "ellipse",
  );
  const showHighlight = $derived(
    selection ? selection.highlight !== null && !locked : editor.tool === "highlight" || editor.tool === "textselect",
  );
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
        notifications.error(t("No se pudo cargar la fuente {name}.", { name: option.label }));
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

  function toggleTool(tool: "text" | "edit" | "pen" | "textselect" | "crop") {
    editor.tool = editor.tool === tool ? "select" : tool;
  }

  function goToTypedPage(input: HTMLInputElement) {
    const number = Number.parseInt(input.value, 10);
    if (Number.isFinite(number)) editor.goToPageNumber(number);
    input.value = String(editor.currentPageIndex + 1);
  }

  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function finishRename(input: HTMLInputElement, keep: boolean) {
    if (!renaming) return;
    renaming = false;
    if (keep) editor.renameDocument(input.value);
  }

  /** Millimetres shown in the size boxes; the editor works in points. */
  const toMm = (points: number) => Math.round(points * MM_PER_POINT * 10) / 10;

  function setDimension(event: Event, key: "left" | "top" | "width" | "height") {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value.replace(",", "."));
    if (!Number.isFinite(value) || ((key === "width" || key === "height") && value <= 0)) return;
    editor.setSelectionBounds({ [key]: value / MM_PER_POINT }, keepRatio);
  }

  /** A link's destination as the user typed it: the page number, or the address. */
  function linkText(link: LinkTarget): string {
    if (link.pageId) {
      const index = editor.pages.findIndex((page) => page.id === link.pageId);
      return index >= 0 ? String(index + 1) : "";
    }
    return link.url ?? "";
  }

  function setLink(input: HTMLInputElement) {
    const parsed = parseLinkInput(input.value);
    if (parsed.kind === "page") {
      const page = editor.pages[parsed.number - 1];
      if (!page) {
        notifications.error(t("El documento no tiene la página {n}.", { n: parsed.number }));
        return;
      }
      editor.setLinkTarget({ pageId: page.id });
    } else if (parsed.kind === "url") {
      editor.setLinkTarget({ url: parsed.url });
    } else {
      notifications.error(t("Escribe una dirección web (https://…), un correo o un número de página."));
    }
  }

  async function copySelectedText() {
    try {
      await navigator.clipboard.writeText(editor.selectedText);
      notifications.success(t("Texto copiado."));
    } catch {
      notifications.info(t("Usa Ctrl C para copiar el texto seleccionado."));
    }
  }

  const hint = $derived(
    activeShape?.hint ??
      (editor.tool === "text"
        ? t("Haz clic en la página donde quieras escribir.")
        : editor.tool === "edit"
          ? t("Haz clic en un texto del documento para editarlo. Se edita el párrafo entero; con Alt, solo esa línea.")
          : editor.tool === "pen"
            ? t("Dibuja a mano alzada sobre la página. Elige el color y el grosor del trazo aquí; Esc para terminar.")
            : editor.tool === "textselect"
              ? t("Selecciona texto del documento para copiarlo, resaltarlo, subrayarlo o tacharlo.")
              : editor.tool === "crop"
                ? t("Arrastra sobre la página para elegir la zona que quieres conservar.")
                : t("Selecciona un elemento para editarlo, o añade texto, imágenes, firmas y formas.")),
  );
</script>

{#snippet pageNav(placement: string)}
  <div class="group page-nav {placement}" aria-label={t("Página")}>
    <input
      class="page-input"
      type="text"
      inputmode="numeric"
      aria-label={t("Ir a la página")}
      title={t("Ir a la página (Ctrl G)")}
      value={editor.currentPageIndex + 1}
      onfocus={(event) => event.currentTarget.select()}
      onchange={(event) => goToTypedPage(event.currentTarget)}
      onkeydown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          goToTypedPage(event.currentTarget);
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.currentTarget.value = String(editor.currentPageIndex + 1);
          event.currentTarget.blur();
        }
      }}
    />
    <span class="page-total">/ {editor.pages.length}</span>
  </div>
{/snippet}

{#snippet zoomControls(placement: string)}
  <div class="group {placement}" aria-label={t("Zoom")}>
    <button class="icon" title={t("Alejar (Ctrl -)")} aria-label={t("Alejar")} onclick={() => editor.zoomOut()}>
      <ZoomOut size={18} />
    </button>
    <Menu label={t("Zoom y ajuste")} triggerClass="zoom-value">
      {#snippet trigger()}
        {Math.round(editor.zoom * 100)}%
      {/snippet}
      {#snippet children(close)}
        <button
          role="menuitem"
          onclick={() => {
            editor.fitWidth();
            close();
          }}
        >
          {t("Ajustar al ancho")}
        </button>
        <button
          role="menuitem"
          onclick={() => {
            void editor.fitPage();
            close();
          }}
        >
          {t("Página completa")}
        </button>
        <div class="menu-separator" role="separator"></div>
        {#each ZOOM_PRESETS as preset (preset)}
          <button
            role="menuitemradio"
            aria-checked={Math.abs(editor.zoom - preset) < 0.005}
            onclick={() => {
              editor.setZoom(preset);
              close();
            }}
          >
            {Math.round(preset * 100)} %
          </button>
        {/each}
      {/snippet}
    </Menu>
    <button class="icon" title={t("Acercar (Ctrl +)")} aria-label={t("Acercar")} onclick={() => editor.zoomIn()}>
      <ZoomIn size={18} />
    </button>
  </div>
{/snippet}

{#snippet historyControls(placement: string)}
  <div class="group {placement}">
    <button
      class="icon"
      title={t("Deshacer (Ctrl Z)")}
      aria-label={t("Deshacer")}
      disabled={!editor.canUndo}
      onclick={() => editor.undo()}
    >
      <Undo2 size={18} />
    </button>
    <button
      class="icon"
      title={t("Rehacer (Ctrl Y)")}
      aria-label={t("Rehacer")}
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

{#snippet highlightPicker()}
  <div class="group">
    <span class="label">{t("Resaltado")}</span>
    {#each HIGHLIGHTS as swatch (swatch.color)}
      <button
        class="swatch"
        class:selected={highlightColor === swatch.color}
        style:background-color={swatch.color}
        title={swatch.name}
        aria-label={t("Resaltado {color}", { color: swatch.name.toLowerCase() })}
        onclick={() => editor.setHighlightColor(swatch.color)}
      ></button>
    {/each}
  </div>
{/snippet}

<header class="toolbar">
  <div class="row">
    <div class="brand">
      {#if inEditor}
        <button class="icon menu" aria-label={t("Mostrar páginas")} onclick={() => (editor.sidebarOpen = true)}>
          <MenuIcon size={20} />
        </button>
      {/if}
      <img src="/paty.png" alt="" class="logo" />
      <span class="title"><span class="yta">yta</span><span class="p">P</span><span class="df">DF</span></span>
      {#if editor.hasDocument}
        {#if renaming}
          <input
            class="doc-name editing"
            aria-label={t("Nombre del documento")}
            value={editor.documentName}
            maxlength="180"
            use:selectOnMount
            onblur={(event) => finishRename(event.currentTarget, true)}
            onkeydown={(event) => {
              if (event.key === "Enter") finishRename(event.currentTarget, true);
              else if (event.key === "Escape") finishRename(event.currentTarget, false);
            }}
          />
        {:else}
          <button
            class="doc-name"
            title={t("{name}: haz clic para cambiar el nombre", { name: editor.documentName })}
            aria-label={t("Nombre del documento: {name}. Cambiar el nombre", { name: editor.documentName })}
            onclick={() => (renaming = true)}
          >
            {editor.documentName}
          </button>
        {/if}
      {/if}
    </div>

    {#if inEditor}
      <div class="group tools" role="toolbar" aria-label={t("Herramientas")}>
        <button
          class="icon"
          class:active={editor.tool === "select"}
          aria-pressed={editor.tool === "select"}
          title={t("Seleccionar (V)")}
          aria-label={t("Seleccionar")}
          onclick={() => (editor.tool = "select")}
        >
          <MousePointer2 size={18} />
        </button>
        <button
          class="icon labeled"
          class:active={editor.tool === "text"}
          aria-pressed={editor.tool === "text"}
          title={t("Añadir texto: haz clic en la página (T)")}
          aria-label={t("Añadir texto")}
          onclick={() => toggleTool("text")}
        >
          <Type size={18} />
          <span class="hide-mobile">{t("Texto")}</span>
        </button>
        <button
          class="icon labeled"
          class:active={editor.tool === "edit"}
          aria-pressed={editor.tool === "edit"}
          title={t("Editar el texto del documento: haz clic en una línea o un párrafo (E)")}
          aria-label={t("Editar el texto del documento")}
          onclick={() => toggleTool("edit")}
        >
          <TextCursorInput size={18} />
          <span class="hide-mobile label-medium">{t("Editar texto")}</span>
        </button>
        <button
          class="icon"
          class:active={editor.tool === "textselect"}
          aria-pressed={editor.tool === "textselect"}
          title={t("Seleccionar texto del documento para copiarlo o marcarlo (S)")}
          aria-label={t("Seleccionar texto")}
          onclick={() => toggleTool("textselect")}
        >
          <TextSelect size={18} />
        </button>
        <button class="icon labeled" title={t("Añadir imagen")} aria-label={t("Añadir imagen")} onclick={() => imageInput?.click()}>
          <ImageIcon size={18} />
          <span class="hide-mobile label-medium">{t("Imagen")}</span>
        </button>
        <button
          class="icon labeled"
          title={t("Añadir una firma: dibujada, escrita o desde una foto")}
          aria-label={t("Añadir firma")}
          onclick={() => editor.openSignature(false)}
        >
          <Signature size={18} />
          <span class="hide-mobile label-medium">{t("Firma")}</span>
        </button>
        <Menu label={t("Sellos y marcas")} triggerClass="icon labeled">
          {#snippet trigger()}
            <Stamp size={18} />
            <span class="hide-mobile label-wide">{t("Sellos")}</span>
          {/snippet}
          {#snippet children(close)}
            <button
              role="menuitem"
              onclick={() => {
                editor.addMark("check");
                close();
              }}
            >
              <Check size={18} />
              {t("Marca de verificación")}
            </button>
            <button
              role="menuitem"
              onclick={() => {
                editor.addMark("cross");
                close();
              }}
            >
              <X size={18} />
              {t("Cruz")}
            </button>
            <button
              role="menuitem"
              onclick={() => {
                editor.addTodayDate();
                close();
              }}
            >
              <CalendarDays size={18} />
              {t("Fecha de hoy")}
              <span class="shortcut">{today}</span>
            </button>
            <div class="menu-separator" role="separator"></div>
            <button
              role="menuitem"
              onclick={() => {
                editor.openSignature(true);
                close();
              }}
            >
              <Signature size={18} />
              {t("Iniciales…")}
            </button>
            <p class="menu-note">{t("Para repetir un sello en cada página, selecciónalo y usa «Añadir a todas las páginas».")}</p>
          {/snippet}
        </Menu>
        <button
          class="icon labeled"
          class:active={editor.tool === "pen"}
          aria-pressed={editor.tool === "pen"}
          title={t("Lápiz: dibuja a mano alzada (P)")}
          aria-label={t("Lápiz")}
          onclick={() => toggleTool("pen")}
        >
          <Pencil size={18} />
          <span class="hide-mobile label-wide">{t("Lápiz")}</span>
        </button>
        <Menu label={t("Formas y marcas")} triggerClass="icon labeled" active={activeShape !== undefined}>
          {#snippet trigger()}
            <ShapeIcon size={18} />
            <span class="hide-mobile label-wide">{activeShape?.label ?? t("Formas")}</span>
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
              {#if shape.tool === "arrow" || shape.tool === "redact"}
                <div class="menu-separator" role="separator"></div>
              {/if}
            {/each}
            <p class="menu-note">{t("La censura elimina el contenido tapado al exportar. Notas y enlaces se guardan como anotaciones del PDF.")}</p>
          {/snippet}
        </Menu>
        <button
          class="icon"
          class:active={editor.tool === "crop"}
          aria-pressed={editor.tool === "crop"}
          title={t("Recortar la página (C)")}
          aria-label={t("Recortar")}
          onclick={() => toggleTool("crop")}
        >
          <Crop size={18} />
        </button>
        <input bind:this={imageInput} type="file" accept="image/*" multiple hidden onchange={onImageChosen} />
      </div>
    {/if}

    {#if editor.hasDocument}
      <div class="spacer"></div>

      {#if inEditor}
        {@render pageNav("page-wide")}
        {@render zoomControls("zoom")}
      {:else}
        <button class="icon labeled" aria-label={t("Volver al editor")} onclick={() => (editor.view = "editor")}>
          <LayoutGrid size={18} />
          <span class="hide-mobile">{t("Editor")}</span>
        </button>
      {/if}

      {@render historyControls("history")}

      <div class="export">
        <button
          class="primary"
          disabled={editor.busy !== null}
          onclick={() => editor.exportPdf()}
          title={editor.saveTargetName
            ? t("Guardar los cambios en «{name}» (Ctrl S)", { name: editor.saveTargetName })
            : t("Descargar el PDF editado (Ctrl S)")}
          aria-label={editor.saveTargetName ? t("Guardar") : t("Exportar PDF")}
        >
          {#if editor.saveTargetName}
            <Save size={18} />
            <span class="hide-mobile">{t("Guardar")}</span>
          {:else}
            <Download size={18} />
            <span class="hide-mobile">{t("Exportar PDF")}</span>
          {/if}
        </button>
        <Menu label={t("Más opciones para exportar")} align="end" triggerClass="export-more">
          {#snippet trigger()}
            <ChevronDown size={16} />
          {/snippet}
          {#snippet children(close)}
            <button
              role="menuitem"
              onclick={() => {
                editor.exportDialog = "pdf";
                close();
              }}
            >
              <Download size={18} />
              {t("Guardar como…")}
              <span class="shortcut">{t("Ctrl Mayús S")}</span>
            </button>
            <p class="menu-note">{t("Nombre, contraseña, formularios y propiedades del documento.")}</p>
            <button
              role="menuitem"
              onclick={() => {
                editor.exportDialog = "image";
                close();
              }}
            >
              <FileImage size={18} />
              {t("Exportar como imagen…")}
            </button>
            <button
              role="menuitem"
              onclick={() => {
                close();
                void editor.printDocument();
              }}
            >
              <Printer size={18} />
              {t("Imprimir")}
              <span class="shortcut">{t("Ctrl P")}</span>
            </button>
            {#if canShareFiles}
              <button
                role="menuitem"
                onclick={() => {
                  close();
                  void editor.shareDocument();
                }}
              >
                <Share2 size={18} />
                {t("Compartir…")}
              </button>
            {/if}
            <div class="menu-separator" role="separator"></div>
            <button
              role="menuitem"
              onclick={() => {
                close();
                void editor.downloadProject();
              }}
            >
              <FolderDown size={18} />
              {t("Descargar proyecto (.ytapdf)")}
            </button>
            <p class="menu-note">{t("Todo el trabajo en un archivo, para seguir editándolo más tarde.")}</p>
          {/snippet}
        </Menu>
      </div>
    {:else}
      <div class="spacer"></div>
      <button class="primary" onclick={onopenfiles}>{t("Abrir PDF")}</button>
    {/if}

    <Menu label={t("Más opciones")} align="end">
      {#snippet trigger()}
        <EllipsisVertical size={20} />
      {/snippet}
      {#snippet children(close)}
        {#if editor.hasDocument}
          <button
            role="menuitem"
            onclick={() => {
              editor.decorationsOpen = true;
              close();
            }}
          >
            <Hash size={18} />
            {t("Numeración, encabezado y marca de agua…")}
          </button>
          <button
            role="menuitem"
            onclick={() => {
              editor.ocrDialog = true;
              close();
            }}
          >
            <ScanText size={18} />
            {t("Reconocer texto de páginas escaneadas (OCR)…")}
          </button>
          <button
            role="menuitem"
            onclick={() => {
              editor.aiDialog = true;
              close();
            }}
          >
            <Sparkles size={18} />
            {t("Resumir o traducir con IA en el dispositivo…")}
          </button>
          <button
            role="menuitem"
            onclick={() => {
              close();
              void editor.saveWork();
            }}
          >
            <Save size={18} />
            {editor.keptWork ? t("Guardado en este navegador") : t("Guardar el trabajo en este navegador")}
            {#if editor.keptWork}<Check size={16} />{/if}
          </button>
          <div class="menu-separator" role="separator"></div>
        {/if}
        <button
          role="menuitemcheckbox"
          aria-checked={editor.recoveryEnabled}
          onclick={() => {
            editor.setRecovery(!editor.recoveryEnabled);
            close();
          }}
        >
          <History size={18} />
          {t("Recuperar el trabajo al volver")}
          <span class="switch" aria-hidden="true"></span>
        </button>
        <p class="menu-note">
          {t("Guarda una copia del documento en este navegador mientras trabajas. No se envía a ningún sitio.")}
        </p>
        <div class="menu-separator" role="separator"></div>
        <div class="menu-row" role="group" aria-label={t("Tema")}>
          {#each THEMES as option (option.value)}
            <button
              role="menuitemradio"
              class="chip"
              aria-checked={theme.choice === option.value}
              title={option.label}
              onclick={() => theme.set(option.value)}
            >
              <option.icon size={16} />
              <span>{option.label}</span>
            </button>
          {/each}
        </div>
        <div class="menu-row" role="group" aria-label={t("Idioma")}>
          <Languages size={16} />
          {#each LOCALES as option (option.id)}
            <button
              role="menuitemradio"
              class="chip"
              aria-checked={i18n.locale === option.id}
              onclick={() => i18n.set(option.id)}
            >
              {option.label}
            </button>
          {/each}
        </div>
        <div class="menu-separator" role="separator"></div>
        <button
          role="menuitem"
          onclick={() => {
            editor.shortcutsOpen = true;
            close();
          }}
        >
          <Keyboard size={18} />
          {t("Atajos de teclado")}
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
            {t("Instalar la aplicación")}
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
            {t("Cerrar documento")}
          </button>
        {/if}
      {/snippet}
    </Menu>

    {#if editor.hasDocument}
      <button class="icon close-doc" title={t("Cerrar documento")} aria-label={t("Cerrar documento")} onclick={requestClose}>
        <X size={20} />
      </button>
    {/if}
  </div>

  {#if inEditor}
    <div class="row context" role="toolbar" aria-label={t("Propiedades")}>
      {@render pageNav("page-compact")}
      {@render zoomControls("zoom-compact")}
      {@render historyControls("history-compact")}

      {#if editor.tool === "textselect" && !selection}
        {#if editor.selectedText}
          <div class="group">
            <button class="icon labeled" onclick={() => editor.markSelectedText("highlight")}>
              <Highlighter size={16} />
              {t("Resaltar")}
            </button>
            <button class="icon labeled" onclick={() => editor.markSelectedText("underline")}>
              <Underline size={16} />
              {t("Subrayar")}
            </button>
            <button class="icon labeled" onclick={() => editor.markSelectedText("strikeout")}>
              <Strikethrough size={16} />
              {t("Tachar")}
            </button>
            <button class="icon labeled" onclick={() => void copySelectedText()}>
              <Copy size={16} />
              {t("Copiar")}
            </button>
          </div>
          {@render highlightPicker()}
          <div class="group">
            <span class="label">{t("Línea")}</span>
            {@render colorPicker(t("Color de la línea"), shapeStyle.stroke, (stroke) => editor.applyShapeStyle({ stroke }))}
          </div>
        {:else}
          <span class="hint">{hint}</span>
        {/if}
      {:else if editor.tool === "crop" && !selection}
        {#if editor.pendingCrop}
          <div class="group">
            <button class="icon labeled active" onclick={() => void editor.applyCrop("page")}>
              <Crop size={16} />
              {t("Recortar esta página")}
            </button>
            {#if editor.pages.length > 1}
              <button class="icon labeled" onclick={() => void editor.applyCrop("all")}>
                {t("Recortar todas las páginas")}
              </button>
            {/if}
            <button class="icon labeled" onclick={() => (editor.pendingCrop = null)}>{t("Cancelar")}</button>
          </div>
        {/if}
        {#if currentPage?.crop}
          <button class="icon labeled" onclick={() => currentPage && void editor.removeCrop([currentPage.id])}>
            <UndoDot size={16} />
            {t("Quitar el recorte de esta página")}
          </button>
        {/if}
        <span class="hint">
          {editor.pendingCrop
            ? t("Se conserva la zona marcada; lo demás deja de verse, pero sigue en el archivo. Intro para aplicar.")
            : hint}
        </span>
      {:else}
        {#if showTextControls}
          <div class="group">
            <select
              class="font"
              aria-label={t("Fuente")}
              value={fontValue}
              onchange={(event) => void setFont(event.currentTarget.value)}
            >
              {#if originalFonts.length > 0}
                <optgroup label={t("Del documento")}>
                  {#each originalFonts as font (font.css)}
                    <option value={font.css}>{font.label}</option>
                  {/each}
                </optgroup>
                <optgroup label={t("Otras fuentes")}>
                  {#each FONT_FAMILIES as family (family.id)}
                    <option value={family.css}>{family.label}</option>
                  {/each}
                </optgroup>
              {:else}
                {#each FONT_FAMILIES as family (family.id)}
                  <option value={family.css}>{family.label}</option>
                {/each}
              {/if}
            </select>
            <input
              class="size"
              type="number"
              min="4"
              max="400"
              step="1"
              list="font-sizes"
              aria-label={t("Tamaño de fuente")}
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
            {@render colorPicker(t("Color del texto"), textStyle.fill, (fill) => setStyle({ fill }))}
          </div>
          <div class="group">
            <button
              class="icon"
              class:active={textStyle.fontWeight === "bold"}
              aria-pressed={textStyle.fontWeight === "bold"}
              title={t("Negrita")}
              aria-label={t("Negrita")}
              onclick={() => setStyle({ fontWeight: textStyle.fontWeight === "bold" ? "normal" : "bold" })}
            >
              <Bold size={16} />
            </button>
            <button
              class="icon"
              class:active={textStyle.fontStyle === "italic"}
              aria-pressed={textStyle.fontStyle === "italic"}
              title={t("Cursiva")}
              aria-label={t("Cursiva")}
              onclick={() => setStyle({ fontStyle: textStyle.fontStyle === "italic" ? "normal" : "italic" })}
            >
              <Italic size={16} />
            </button>
            <button
              class="icon"
              class:active={textStyle.underline}
              aria-pressed={textStyle.underline}
              title={t("Subrayado")}
              aria-label={t("Subrayado")}
              onclick={() => setStyle({ underline: !textStyle.underline })}
            >
              <Underline size={16} />
            </button>
            {#if showParagraphControls}
              <button
                class="icon"
                class:active={textStyle.linethrough}
                aria-pressed={textStyle.linethrough}
                title={t("Tachado")}
                aria-label={t("Tachado")}
                onclick={() => setStyle({ linethrough: !textStyle.linethrough })}
              >
                <Strikethrough size={16} />
              </button>
            {/if}
          </div>
          {#if showParagraphControls}
            <div class="group" role="radiogroup" aria-label={t("Alineación")}>
              {#each ALIGNMENTS as alignment (alignment.value)}
                <button
                  class="icon"
                  role="radio"
                  class:active={textStyle.textAlign === alignment.value}
                  aria-checked={textStyle.textAlign === alignment.value}
                  title={alignment.label}
                  aria-label={alignment.label}
                  onclick={() => setStyle({ textAlign: alignment.value })}
                >
                  <alignment.icon size={16} />
                </button>
              {/each}
            </div>
            <label class="group">
              <span class="label">{t("Interlineado")}</span>
              <select
                class="line-height"
                aria-label={t("Interlineado")}
                value={lineHeight}
                onchange={(event) => setStyle({ lineHeight: Number(event.currentTarget.value) })}
              >
                {#each LINE_HEIGHTS as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        {/if}

        {#if showShapeControls}
          <div class="group">
            <span class="label">{t("Trazo")}</span>
            {@render colorPicker(t("Color del trazo"), shapeStyle.stroke, (stroke) => editor.applyShapeStyle({ stroke }))}
            {#if showStrokeWidth}
              <select
                class="stroke-width"
                aria-label={t("Grosor del trazo")}
                value={STROKE_WIDTHS.includes(shapeStyle.strokeWidth) ? shapeStyle.strokeWidth : 3}
                onchange={(event) => editor.applyShapeStyle({ strokeWidth: Number(event.currentTarget.value) })}
              >
                {#each STROKE_WIDTHS as width (width)}
                  <option value={width}>{width} pt</option>
                {/each}
              </select>
            {/if}
          </div>
          {#if showFill}
            <div class="group">
              <span class="label">{t("Relleno")}</span>
              <button
                class="swatch none"
                class:selected={shapeStyle.fill === null}
                title={t("Sin relleno")}
                aria-label={t("Sin relleno")}
                onclick={() => editor.applyShapeStyle({ fill: null })}
              ></button>
              <input
                class="color"
                type="color"
                aria-label={t("Color de relleno")}
                title={t("Color de relleno")}
                value={shapeStyle.fill ?? "#ffffff"}
                oninput={(event) => editor.applyShapeStyle({ fill: event.currentTarget.value })}
              />
            </div>
          {/if}
        {/if}

        {#if showHighlight}
          {@render highlightPicker()}
        {/if}

        {#if selection?.link && !locked}
          <div class="group dims link-target">
            <LinkIcon size={16} />
            <input
              type="text"
              value={linkText(selection.link)}
              placeholder={t("https://… o n.º de página")}
              aria-label={t("Destino del enlace")}
              title={t("Dirección web, correo o número de página")}
              spellcheck="false"
              onchange={(event) => setLink(event.currentTarget)}
              onkeydown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </div>
        {/if}

        {#if selection}
          {#if !locked}
            <div class="group">
              <button
                class="icon"
                title={t("Girar a la izquierda")}
                aria-label={t("Girar a la izquierda")}
                onclick={() => editor.rotateSelection(-90)}
              >
                <RotateCcw size={16} />
              </button>
              <button
                class="icon"
                title={t("Girar a la derecha")}
                aria-label={t("Girar a la derecha")}
                onclick={() => editor.rotateSelection(90)}
              >
                <RotateCw size={16} />
              </button>
              <button
                class="icon"
                class:active={selection.flipX}
                aria-pressed={selection.flipX}
                title={t("Voltear horizontalmente")}
                aria-label={t("Voltear horizontalmente")}
                onclick={() => editor.flipSelection("x")}
              >
                <FlipHorizontal2 size={16} />
              </button>
              <button
                class="icon"
                class:active={selection.flipY}
                aria-pressed={selection.flipY}
                title={t("Voltear verticalmente")}
                aria-label={t("Voltear verticalmente")}
                onclick={() => editor.flipSelection("y")}
              >
                <FlipVertical2 size={16} />
              </button>
            </div>

            <div class="group">
              <Menu label={t("Alinear y distribuir")} triggerClass="icon">
                {#snippet trigger()}
                  <AlignStartVertical size={16} />
                  <ChevronDown size={12} />
                {/snippet}
                {#snippet children(close)}
                  <p class="menu-note flush">
                    {selection.count > 1 ? t("Entre los objetos seleccionados") : t("Respecto a la página")}
                  </p>
                  {#each OBJECT_ALIGNMENTS as option (option.mode)}
                    <button
                      role="menuitem"
                      onclick={() => {
                        editor.alignSelection(option.mode);
                        close();
                      }}
                    >
                      <option.icon size={18} />
                      {option.label}
                    </button>
                  {/each}
                  {#if selection.count >= 3}
                    <div class="menu-separator" role="separator"></div>
                    <button
                      role="menuitem"
                      onclick={() => {
                        editor.distributeSelection("horizontal");
                        close();
                      }}
                    >
                      <AlignHorizontalDistributeCenter size={18} />
                      {t("Distribuir en horizontal")}
                    </button>
                    <button
                      role="menuitem"
                      onclick={() => {
                        editor.distributeSelection("vertical");
                        close();
                      }}
                    >
                      <AlignVerticalDistributeCenter size={18} />
                      {t("Distribuir en vertical")}
                    </button>
                  {/if}
                {/snippet}
              </Menu>
              {#if selection.kind === "group"}
                <button
                  class="icon"
                  title={t("Desagrupar (Ctrl Mayús G)")}
                  aria-label={t("Desagrupar")}
                  onclick={() => editor.ungroupSelection()}
                >
                  <Ungroup size={16} />
                </button>
              {:else if selection.canGroup}
                <button
                  class="icon"
                  title={t("Agrupar (Ctrl Mayús G)")}
                  aria-label={t("Agrupar")}
                  onclick={() => editor.groupSelection()}
                >
                  <Group size={16} />
                </button>
              {/if}
            </div>

            <div class="group dims" role="group" aria-label={t("Posición y tamaño (mm)")}>
              <label title={t("Distancia al borde izquierdo (mm)")}>
                X
                <input
                  type="number"
                  step="0.5"
                  value={toMm(selection.bounds.left)}
                  onchange={(event) => setDimension(event, "left")}
                />
              </label>
              <label title={t("Distancia al borde superior (mm)")}>
                Y
                <input type="number" step="0.5" value={toMm(selection.bounds.top)} onchange={(event) => setDimension(event, "top")} />
              </label>
              {#if selection.size}
                <label title={t("Ancho (mm)")}>
                  {t("An")}
                  <input
                    type="number"
                    step="0.5"
                    min="0.5"
                    value={toMm(selection.size.width)}
                    onchange={(event) => setDimension(event, "width")}
                  />
                </label>
                <label title={t("Alto (mm)")}>
                  {t("Al")}
                  <input
                    type="number"
                    step="0.5"
                    min="0.5"
                    value={toMm(selection.size.height)}
                    onchange={(event) => setDimension(event, "height")}
                  />
                </label>
                <button
                  class="icon small"
                  class:active={keepRatio}
                  aria-pressed={keepRatio}
                  title={keepRatio ? t("Mantener proporciones: activado") : t("Mantener proporciones: desactivado")}
                  aria-label={t("Mantener proporciones")}
                  onclick={() => (keepRatio = !keepRatio)}
                >
                  <Link2 size={14} />
                </button>
              {/if}
              <span class="unit">mm</span>
            </div>
          {/if}

          <div class="group" role="group" aria-label={t("Orden de capas")}>
            <button
              class="icon"
              title={t("Traer al frente (Ctrl Mayús ])")}
              aria-label={t("Traer al frente")}
              disabled={!selection.canRaise}
              onclick={() => editor.arrangeSelection("front")}
            >
              <BringToFront size={16} />
            </button>
            <button
              class="icon"
              title={t("Traer adelante (Ctrl ])")}
              aria-label={t("Traer adelante")}
              disabled={!selection.canRaise}
              onclick={() => editor.arrangeSelection("forward")}
            >
              <ArrowUp size={16} />
            </button>
            <button
              class="icon"
              title={t("Enviar atrás (Ctrl [)")}
              aria-label={t("Enviar atrás")}
              disabled={!selection.canLower}
              onclick={() => editor.arrangeSelection("backward")}
            >
              <ArrowDown size={16} />
            </button>
            <button
              class="icon"
              title={t("Enviar al fondo (Ctrl Mayús [)")}
              aria-label={t("Enviar al fondo")}
              disabled={!selection.canLower}
              onclick={() => editor.arrangeSelection("back")}
            >
              <SendToBack size={16} />
            </button>
          </div>

          {#if !locked}
            <label class="group opacity">
              <span>{t("Opacidad")}</span>
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

          {#if selection.native}
            <div class="group">
              <button
                class="icon labeled"
                title={t("Quitar los cambios y volver al texto original del documento")}
                aria-label={t("Restaurar el texto original")}
                onclick={() => editor.restoreOriginalText()}
              >
                <UndoDot size={16} />
                <span class="hide-mobile">{t("Restaurar original")}</span>
              </button>
            </div>
          {/if}

          <div class="group">
            <button
              class="icon"
              title={t("Duplicar (Ctrl D)")}
              aria-label={t("Duplicar")}
              onclick={() => void editor.duplicateSelection()}
            >
              <CopyPlus size={16} />
            </button>
            {#if editor.pages.length > 1}
              <button
                class="icon"
                title={t("Añadir una copia en el mismo sitio de todas las páginas")}
                aria-label={t("Añadir a todas las páginas")}
                onclick={() => editor.applySelectionToAllPages()}
              >
                <Files size={16} />
              </button>
            {/if}
            <button
              class="icon"
              class:active={locked}
              aria-pressed={locked}
              title={locked ? t("Desbloquear (Ctrl L)") : t("Bloquear para que no se mueva (Ctrl L)")}
              aria-label={locked ? t("Desbloquear") : t("Bloquear")}
              onclick={() => editor.toggleLockSelection()}
            >
              {#if locked}<Lock size={16} />{:else}<LockOpen size={16} />{/if}
            </button>
            <button
              class="icon danger"
              title={t("Eliminar (Supr)")}
              aria-label={t("Eliminar selección")}
              disabled={locked}
              onclick={() => editor.deleteSelection()}
            >
              <Trash2 size={16} />
            </button>
          </div>
          {#if locked}
            <span class="hint">{t("Bloqueado: no se puede mover ni editar hasta desbloquearlo.")}</span>
          {:else if selection.substituted.length > 0}
            <span class="hint">
              {t("La fuente original no tiene {chars}: se dibujarán con una fuente parecida.", {
                chars: selection.substituted.slice(0, 8).join(" "),
              })}
            </span>
          {/if}
        {:else}
          <span class="hint">{hint}</span>
        {/if}
      {/if}
    </div>
  {/if}
</header>

{#if confirmClose}
  <ConfirmModal
    title={t("¿Cerrar el documento?")}
    message={editor.keptWork
      ? t("Hay cambios que todavía no has exportado. El trabajo sigue guardado en este navegador.")
      : t("Hay cambios que todavía no has exportado. Si cierras el documento, se perderán.")}
    confirmText={t("Cerrar sin exportar")}
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
    background: var(--color-surface-raised);
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
    color: var(--color-heading);
  }
  .p {
    background: linear-gradient(to right, var(--color-heading) 50%, var(--color-primary) 50%);
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
    margin-left: 2px;
    padding: 4px 8px 4px 12px;
    border-left: 1px solid var(--color-border) !important;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    color: var(--color-text-muted);
    font: inherit;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.doc-name:hover {
    background: var(--color-surface-muted);
    color: var(--color-text);
  }
  .doc-name.editing {
    width: 220px;
    border: 1px solid var(--color-primary) !important;
    border-radius: var(--radius-sm);
    outline: none;
    color: var(--color-text);
  }
  .page-nav {
    gap: 6px;
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .page-input {
    width: 44px;
    height: 30px;
    padding: 0 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font: inherit;
    text-align: center;
  }
  .page-input:focus {
    border-color: var(--color-primary);
    outline: none;
  }
  .page-total {
    white-space: nowrap;
  }
  .export {
    display: flex;
    flex-shrink: 0;
  }
  .export .primary {
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
  }
  .toolbar :global(.export-more) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 36px;
    border-left: 1px solid rgba(255, 255, 255, 0.35) !important;
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: var(--color-primary) !important;
    color: white;
    flex-shrink: 0;
  }
  .toolbar :global(.export-more:hover) {
    background: var(--color-primary-hover) !important;
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
  /* When the window is narrow the tools scroll on their own, so saving and
     the menu stay in reach. */
  .group.tools {
    flex-shrink: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .group.tools::-webkit-scrollbar {
    display: none;
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
    color: var(--color-icon);
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
  .zoom-compact,
  .history-compact,
  .page-compact,
  .toolbar .icon.menu {
    display: none;
  }
  /* Labels of the less used tools give way first as the window narrows. */
  @media (max-width: 1600px) {
    .label-wide {
      display: none;
    }
  }
  @media (max-width: 1280px) {
    .label-medium {
      display: none;
    }
  }
  .toolbar :global(.zoom-value) {
    min-width: 56px;
    height: 32px;
    border-radius: var(--radius-sm);
    font: inherit;
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    color: var(--color-icon);
  }
  .toolbar :global(.zoom-value:hover) {
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
  .stroke-width,
  .line-height {
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
    .page-wide,
    .close-doc {
      display: none !important;
    }
    .zoom-compact,
    .history-compact,
    .page-compact {
      display: flex;
      padding-right: 6px;
      border-right: 1px solid var(--color-border);
    }
    .toolbar .icon.menu {
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
  .dims {
    gap: 6px;
  }
  .dims label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--color-text-muted);
    font-size: 12px;
  }
  .dims input {
    width: 62px;
    height: 30px;
    padding: 0 6px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    font: inherit;
    font-size: 13px;
  }
  .link-target input {
    width: 200px;
  }
  .dims .unit {
    color: var(--color-text-muted);
    font-size: 12px;
  }
  .toolbar :global(.icon.small) {
    min-width: 28px;
    height: 28px;
    padding: 0 4px;
  }
  :global(.menu-row) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    color: var(--color-text-muted);
  }
  :global(.menu .menu-row [role="menuitemradio"].chip) {
    width: auto;
    gap: 6px;
    padding: 5px 9px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    font-size: 12.5px;
  }
  :global(.menu .menu-row [role="menuitemradio"].chip[aria-checked="true"]) {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }
  :global(.menu .menu-note.flush) {
    margin-left: 10px;
  }
</style>
