<script lang="ts">
  import { Canvas, PencilBrush, type Path } from "fabric";
  import { Camera, Eraser, PenLine, Trash2, Type } from "lucide-svelte";
  import { editor, isSignatureImage, type SignatureContent, type SignatureData } from "../editor.svelte";
  import { t } from "../i18n.svelte";
  import { extractInk, hexToRgb } from "../signaturePhoto";
  import {
    combineStrokes,
    deleteSavedSignature,
    loadSavedSignatures,
    saveSignature,
    type SavedSignature,
  } from "../signatures";
  import { loadSignatureFont, SIGNATURE_FONTS, textToPath, type SignatureFontId } from "../typedSignature";
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
  // Names above are translated where they are shown.
  /** Photos are processed at most this large: plenty for a signature. */
  const PHOTO_SIDE = 1200;

  type Tab = "draw" | "type" | "photo";
  type Outline = { path: string; width: number; height: number };

  let tab = $state<Tab>("draw");
  let initials = $state(editor.signatureInitials);
  let color = $state(COLORS[1].color);
  let remember = $state(false);
  let saved = $state<SavedSignature[]>(loadSavedSignatures());
  const savedHere = $derived(saved.filter((s) => !!s.initials === initials));

  // ── Draw ──────────────────────────────────────────────────────────────────

  let padElement: HTMLCanvasElement;
  let padBox: HTMLDivElement;
  let pad: Canvas | null = null;
  let strokes = $state(0);
  let width = $state(WIDTHS[1].width);

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

  function drawn(): SignatureData | null {
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
    return { ...combined, color, strokeWidth: width, initials };
  }

  // ── Type ──────────────────────────────────────────────────────────────────

  let typed = $state("");
  let fontId = $state<SignatureFontId>(SIGNATURE_FONTS[0].id);
  let outlines = $state<Partial<Record<SignatureFontId, Outline | null>>>({});
  let fontError = $state(false);

  $effect(() => {
    const text = typed.trim();
    if (tab !== "type") return;
    if (!text) {
      outlines = {};
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const font of SIGNATURE_FONTS) {
        loadSignatureFont(font.id)
          .then((loaded) => {
            if (!cancelled) outlines = { ...outlines, [font.id]: textToPath(loaded, text) };
          })
          .catch((error) => {
            console.error("No se pudo cargar la fuente de firma:", error);
            if (!cancelled) fontError = true;
          });
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  function typedSignature(): SignatureData | null {
    const outline = outlines[fontId];
    if (!outline || !typed.trim()) return null;
    return { ...outline, color, strokeWidth: 0, filled: true, initials };
  }

  // ── Photo ─────────────────────────────────────────────────────────────────

  let photoInput: HTMLInputElement;
  let photoCanvas = $state<HTMLCanvasElement>();
  let photo = $state.raw<ImageData | null>(null);
  let sensitivity = $state(0.5);
  let inkFound = $state(true);
  let photoError = $state<string | null>(null);

  async function onPhotoChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    photoError = null;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Sin contexto 2D");
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      photo = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (error) {
      console.error("No se pudo leer la foto:", error);
      photoError = t("No se pudo leer la imagen. Prueba con una foto JPG o PNG.");
      photo = null;
    }
  }

  // The ink is extracted again whenever the sensitivity or the colour change.
  $effect(() => {
    const source = photo;
    const target = photoCanvas;
    const level = sensitivity;
    const ink = hexToRgb(color);
    if (!source || !target) return;
    const result = extractInk(source, ink, level);
    inkFound = result.found;
    target.width = result.width;
    target.height = result.height;
    if (result.found) {
      const pixels = new ImageData(result.data as Uint8ClampedArray<ArrayBuffer>, result.width, result.height);
      target.getContext("2d")?.putImageData(pixels, 0, 0);
    }
  });

  function photoSignature(): SignatureContent | null {
    if (!photo || !photoCanvas || !inkFound) return null;
    return { image: photoCanvas.toDataURL("image/png"), width: photoCanvas.width, height: photoCanvas.height, initials };
  }

  // ── Insert ────────────────────────────────────────────────────────────────

  const ready = $derived(
    tab === "draw" ? strokes > 0 : tab === "type" ? !!outlines[fontId] && typed.trim().length > 0 : !!photo && inkFound,
  );

  function current(): SignatureContent | null {
    if (tab === "draw") return drawn();
    if (tab === "type") return typedSignature();
    return photoSignature();
  }

  function insert() {
    const signature = current();
    if (!signature) return;
    if (remember) saved = saveSignature(signature);
    void editor.insertSignature(signature);
  }

  
</script>

<Modal title={initials ? t("Añadir iniciales") : t("Añadir firma")} onclose={() => (editor.signatureOpen = false)} wide>
  <div class="segmented kind" role="radiogroup" aria-label={t("Qué quieres añadir")}>
    <button role="radio" aria-checked={!initials} onclick={() => (initials = false)}>{t("Firma")}</button>
    <button role="radio" aria-checked={initials} onclick={() => (initials = true)}>{t("Iniciales")}</button>
  </div>

  {#if savedHere.length > 0}
    <section class="saved" aria-label={initials ? t("Iniciales guardadas") : t("Firmas guardadas")}>
      <h3>{initials ? t("Iniciales guardadas") : t("Firmas guardadas")}</h3>
      <div class="saved-list">
        {#each savedHere as signature (signature.id)}
          <div class="saved-item">
            <button class="use" title={t("Usar")} onclick={() => void editor.insertSignature(signature)}>
              {#if isSignatureImage(signature)}
                <img src={signature.image} alt="" />
              {:else}
                <svg viewBox="0 0 {signature.width} {signature.height}" aria-hidden="true">
                  <path
                    d={signature.path}
                    fill={signature.filled ? signature.color : "none"}
                    stroke={signature.filled ? "none" : signature.color}
                    stroke-width={signature.strokeWidth}
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              {/if}
              <span class="visually-hidden">{initials ? t("Usar estas iniciales") : t("Usar esta firma")}</span>
            </button>
            <button
              class="forget"
              title={t("Olvidar")}
              aria-label={t("Olvidar")}
              onclick={() => (saved = deleteSavedSignature(signature.id))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <div class="tabs" role="tablist" aria-label={t("Cómo crearla")}>
    <button role="tab" aria-selected={tab === "draw"} onclick={() => (tab = "draw")}>
      <PenLine size={16} /> {t("Dibujar")}
    </button>
    <button role="tab" aria-selected={tab === "type"} onclick={() => (tab = "type")}>
      <Type size={16} /> {t("Escribir")}
    </button>
    <button role="tab" aria-selected={tab === "photo"} onclick={() => (tab = "photo")}>
      <Camera size={16} /> {t("Desde una foto")}
    </button>
  </div>

  <div class="panel" class:hidden={tab !== "draw"} role="tabpanel">
    <p class="intro">{t("Dibuja con el ratón, el dedo o un lápiz digital. Se insertará como trazo vectorial.")}</p>
    <div class="pad" class:small={initials} bind:this={padBox}>
      <canvas bind:this={padElement}></canvas>
      {#if strokes === 0}
        <span class="placeholder" aria-hidden="true">{initials ? t("Iniciales aquí") : t("Firma aquí")}</span>
      {/if}
      <span class="baseline" aria-hidden="true"></span>
    </div>
  </div>

  <div class="panel" class:hidden={tab !== "type"} role="tabpanel">
    <label class="field">
      <span>{initials ? t("Tus iniciales") : t("Tu nombre")}</span>
      <input
        type="text"
        maxlength="60"
        autocomplete={initials ? "off" : "name"}
        placeholder={initials ? t("Por ejemplo, M. G.") : t("Por ejemplo, María García")}
        bind:value={typed}
      />
    </label>
    {#if fontError}
      <p class="error" role="alert">{t("No se pudieron cargar las letras manuscritas. Comprueba la conexión e inténtalo de nuevo.")}</p>
    {/if}
    <div class="styles" role="radiogroup" aria-label={t("Estilo de letra")}>
      {#each SIGNATURE_FONTS as font (font.id)}
        {@const outline = outlines[font.id]}
        <button role="radio" aria-checked={fontId === font.id} aria-label={font.label} onclick={() => (fontId = font.id)}>
          {#if outline}
            <svg viewBox="0 0 {outline.width} {outline.height}" aria-hidden="true">
              <path d={outline.path} fill={color} />
            </svg>
          {:else}
            <span class="style-name">{typed.trim() ? t("Cargando…") : font.label}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="panel" class:hidden={tab !== "photo"} role="tabpanel">
    <p class="intro">
      {initials
        ? t("Haz una foto de tus iniciales sobre papel blanco, con buena luz. Se quitará el fondo y quedará solo la tinta.")
        : t("Haz una foto de tu firma sobre papel blanco, con buena luz. Se quitará el fondo y quedará solo la tinta.")}
    </p>
    <input bind:this={photoInput} type="file" accept="image/*" hidden onchange={onPhotoChosen} />
    {#if photo}
      <div class="photo-result" class:empty={!inkFound}>
        <canvas bind:this={photoCanvas} aria-label={t("Vista previa sin fondo")}></canvas>
        {#if !inkFound}
          <span class="placeholder">{t("No se distingue la tinta. Sube la sensibilidad o prueba con otra foto.")}</span>
        {/if}
      </div>
      <div class="photo-controls">
        <label class="range">
          <span>{t("Sensibilidad")}</span>
          <input type="range" min="0" max="1" step="0.05" bind:value={sensitivity} />
        </label>
        <button class="secondary small" onclick={() => photoInput.click()}>{t("Otra foto")}</button>
      </div>
    {:else}
      <button class="pick-photo" onclick={() => photoInput.click()}>
        <Camera size={20} />
        {t("Elegir o hacer una foto")}
      </button>
    {/if}
    {#if photoError}
      <p class="error" role="alert">{photoError}</p>
    {/if}
  </div>

  <div class="options">
    <div class="option" role="radiogroup" aria-label={t("Color")}>
      {#each COLORS as option (option.color)}
        <button
          class="color"
          role="radio"
          aria-checked={color === option.color}
          aria-label={t(option.name)}
          title={t(option.name)}
          style:background-color={option.color}
          onclick={() => (color = option.color)}
        ></button>
      {/each}
    </div>
    {#if tab === "draw"}
      <div class="option" role="radiogroup" aria-label={t("Grosor")}>
        {#each WIDTHS as option (option.width)}
          <button class="width" role="radio" aria-checked={width === option.width} onclick={() => (width = option.width)}>
            {t(option.name)}
          </button>
        {/each}
      </div>
      <button class="clear" onclick={clear} disabled={strokes === 0}>
        <Eraser size={16} />
        {t("Borrar")}
      </button>
    {/if}
  </div>

  <label class="remember">
    <input type="checkbox" bind:checked={remember} />
    {initials ? t("Guardar estas iniciales en este navegador para reutilizarlas") : t("Guardar esta firma en este navegador para reutilizarla")}
  </label>

  <div class="actions">
    <button class="secondary" onclick={() => (editor.signatureOpen = false)}>{t("Cancelar")}</button>
    <button class="primary" onclick={insert} disabled={!ready}>{initials ? t("Insertar iniciales") : t("Insertar firma")}</button>
  </div>
</Modal>

<style>
  h3 {
    margin: 4px 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-muted);
  }
  .segmented,
  .tabs {
    display: flex;
    gap: 4px;
  }
  .segmented {
    width: fit-content;
    margin: 4px 0 14px;
    padding: 3px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-muted);
  }
  .segmented button {
    padding: 5px 14px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--color-text-muted);
    font-weight: 500;
    cursor: pointer;
  }
  .segmented button[aria-checked="true"] {
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-sm), 0 0 0 1px var(--color-border);
  }
  .tabs {
    margin-bottom: 12px;
    border-bottom: 1px solid var(--color-border);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: -1px;
    padding: 8px 12px;
    border: none;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--color-text-muted);
    font-weight: 500;
    cursor: pointer;
  }
  .tabs button[aria-selected="true"] {
    border-bottom-color: var(--color-primary);
    color: var(--color-primary);
  }
  .panel.hidden {
    display: none;
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
  .use svg,
  .use img {
    width: 100%;
    height: 100%;
    object-fit: contain;
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
    border: 1px dashed var(--color-border-dashed);
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
    padding: 12px;
    color: var(--color-placeholder);
    font-size: 22px;
    text-align: center;
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 500;
  }
  .field input {
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 15px;
  }
  .styles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 12px;
  }
  .styles button {
    display: grid;
    place-items: center;
    height: 84px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: #fff;
    cursor: pointer;
  }
  .styles button[aria-checked="true"] {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px var(--color-primary-soft);
  }
  .styles svg {
    width: 100%;
    height: 100%;
  }
  .style-name {
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .pick-photo {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    height: 140px;
    border: 1px dashed var(--color-border-dashed);
    border-radius: var(--radius-md);
    background: var(--color-surface-muted);
    color: var(--color-text-muted);
    font-weight: 500;
    cursor: pointer;
  }
  .pick-photo:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  .photo-result {
    position: relative;
    display: grid;
    place-items: center;
    height: 180px;
    padding: 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    /* A checkerboard shows that the background is now transparent. */
    background:
      repeating-conic-gradient(#f0f2f5 0% 25%, #ffffff 0% 50%) 50% / 16px 16px;
  }
  .photo-result canvas {
    max-width: 100%;
    max-height: 100%;
  }
  .photo-result.empty canvas {
    visibility: hidden;
  }
  .photo-result .placeholder {
    font-size: 14px;
    color: var(--color-text-muted);
  }
  .photo-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
  }
  .range {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .range input {
    flex: 1;
    accent-color: var(--color-primary);
  }
  .error {
    margin: 8px 0 0;
    color: var(--color-danger);
    font-size: 13px;
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
  .actions button,
  .secondary.small {
    padding: 9px 16px;
    border: none;
    border-radius: var(--radius-sm);
    font-weight: 500;
    cursor: pointer;
  }
  .secondary.small {
    padding: 6px 12px;
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
  @media (max-width: 520px) {
    .styles {
      grid-template-columns: 1fr;
    }
    .tabs button {
      padding: 8px;
      font-size: 13px;
    }
  }
</style>
