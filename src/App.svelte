<script lang="ts">
  import { onMount } from "svelte";
  import "./lib/fabricSetup";
  import { editor, type ArrangeAction } from "./lib/editor.svelte";
  import { notifications } from "./lib/notifications.svelte";
  import { pwa } from "./lib/pwa.svelte";
  import GridOrganizer from "./lib/components/GridOrganizer.svelte";
  import PasswordModal from "./lib/components/PasswordModal.svelte";
  import ShortcutsModal from "./lib/components/ShortcutsModal.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import SignatureModal from "./lib/components/SignatureModal.svelte";
  import Toasts from "./lib/components/Toasts.svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import Welcome from "./lib/components/Welcome.svelte";
  import Workspace from "./lib/components/Workspace.svelte";

  /** Marks clipboard content copied from this app, to paste it back as objects. */
  const CLIPBOARD_TYPE = "application/x-ytapdf-objects";

  let fileInput: HTMLInputElement;
  let dragDepth = $state(0);

  onMount(() => {
    pwa.init((files) => void editor.openFiles(files));
    void editor.checkRecovery();
  });

  function openFilePicker() {
    fileInput.click();
  }

  function onFilesChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    void editor.openFiles(files);
  }

  // ── Drag & drop from the operating system ────────────────────────────────

  function carriesFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes("Files") ?? false;
  }

  function isPdf(file: File) {
    return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  }

  function ondragenter(event: DragEvent) {
    if (carriesFiles(event)) dragDepth += 1;
  }

  function ondragleave(event: DragEvent) {
    if (carriesFiles(event)) dragDepth = Math.max(0, dragDepth - 1);
  }

  function ondragover(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  async function ondrop(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    const pdfs = files.filter(isPdf);
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (pdfs.length === 0 && images.length === 0) {
      notifications.info("Solo se pueden abrir archivos PDF o añadir imágenes.");
      return;
    }
    if (pdfs.length > 0) await editor.openFiles(pdfs);
    if (images.length === 0) return;
    if (editor.hasDocument && editor.view === "editor") {
      for (const image of images) await editor.addImage(image);
    } else if (!editor.hasDocument) {
      notifications.info("Abre primero un PDF para poder añadir imágenes.");
    }
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────

  function isTypingTarget(target: EventTarget | null) {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    );
  }

  function modalOpen() {
    return document.querySelector("[role='dialog']") !== null;
  }

  /** Ctrl+] / Ctrl+[ (also with the physical bracket keys and Ctrl+↑/↓). */
  function arrangeShortcut(event: KeyboardEvent): ArrangeAction | null {
    const up = event.key === "]" || event.key === "}" || event.code === "BracketRight" || event.key === "ArrowUp";
    const down = event.key === "[" || event.key === "{" || event.code === "BracketLeft" || event.key === "ArrowDown";
    if (up) return event.shiftKey ? "front" : "forward";
    if (down) return event.shiftKey ? "back" : "backward";
    return null;
  }

  function onkeydown(event: KeyboardEvent) {
    if (editor.passwordRequest || modalOpen()) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const typing = isTypingTarget(event.target);

    if (!typing && event.key === "?") {
      event.preventDefault();
      editor.shortcutsOpen = true;
      return;
    }

    if (mod && key === "o") {
      event.preventDefault();
      openFilePicker();
      return;
    }
    if (!editor.hasDocument) return;

    if (mod && key === "s") {
      event.preventDefault();
      void editor.exportPdf();
      return;
    }
    // While typing, undo/redo belong to the text field.
    if (typing) {
      if (event.key === "Escape" && editor.isEditingText()) editor.clearSelection();
      return;
    }
    if (mod && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    if (mod && (key === "+" || key === "=")) {
      event.preventDefault();
      editor.zoomIn();
      return;
    }
    if (mod && key === "-") {
      event.preventDefault();
      editor.zoomOut();
      return;
    }
    if (mod && key === "0") {
      event.preventDefault();
      editor.setZoom(1);
      return;
    }
    if (editor.view === "editor" && editor.selection && mod) {
      const arrange = arrangeShortcut(event);
      if (arrange) {
        event.preventDefault();
        editor.arrangeSelection(arrange);
        return;
      }
      if (key === "d") {
        event.preventDefault();
        void editor.duplicateSelection();
        return;
      }
      if (key === "l") {
        event.preventDefault();
        editor.toggleLockSelection();
        return;
      }
    }
    if (mod || event.altKey || editor.view !== "editor") return;

    if (event.key === "Escape") {
      editor.clearSelection();
      editor.tool = "select";
      editor.sidebarOpen = false;
      return;
    }
    if (key === "t") editor.tool = "text";
    if (key === "v") editor.tool = "select";
    if (!editor.selection) return;

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      editor.deleteSelection();
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const nudges: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const nudge = nudges[event.key];
    if (nudge) {
      event.preventDefault();
      editor.nudgeSelection(nudge[0] / editor.zoom, nudge[1] / editor.zoom);
    }
  }

  // ── Clipboard ────────────────────────────────────────────────────────────

  function canUseClipboard(event: ClipboardEvent) {
    return editor.hasDocument && editor.view === "editor" && !isTypingTarget(event.target) && !modalOpen();
  }

  function copyTo(event: ClipboardEvent, text: string | null) {
    if (text === null) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    event.clipboardData?.setData(CLIPBOARD_TYPE, "1");
  }

  function oncopy(event: ClipboardEvent) {
    if (canUseClipboard(event) && editor.selection) copyTo(event, editor.copySelection());
  }

  function oncut(event: ClipboardEvent) {
    if (canUseClipboard(event) && editor.selection) copyTo(event, editor.cutSelection());
  }

  async function onpaste(event: ClipboardEvent) {
    const data = event.clipboardData;
    if (!data || !canUseClipboard(event)) return;
    const files = [...data.files];
    const images = files.filter((file) => file.type.startsWith("image/"));
    const pdfs = files.filter(isPdf);
    const text = data.getData("text/plain");
    event.preventDefault();

    const own = data.types.includes(CLIPBOARD_TYPE) || (files.length === 0 && editor.isOwnClipboardText(text));
    if (own && editor.hasClipboard) {
      await editor.pasteObjects();
    } else if (pdfs.length > 0) {
      await editor.openFiles(pdfs);
    } else if (images.length > 0) {
      for (const image of images) await editor.addImage(image);
    } else if (text.trim()) {
      editor.addTextFromClipboard(text);
    } else if (editor.hasClipboard) {
      await editor.pasteObjects();
    }
  }

  function onbeforeunload(event: BeforeUnloadEvent) {
    if (!editor.isDirty) return;
    event.preventDefault();
    // Legacy browsers only show the prompt when returnValue is set.
    event.returnValue = "";
  }

  // Focusing Fabric's hidden textarea can scroll the (overflow: hidden) page.
  function onscroll() {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  }
</script>

<svelte:window
  {onkeydown}
  {oncopy}
  {oncut}
  {onpaste}
  {onbeforeunload}
  {onscroll}
  {ondragenter}
  {ondragleave}
  {ondragover}
  {ondrop}
  ondropcapture={() => (dragDepth = 0)}
/>

<div class="app">
  <Toolbar onopenfiles={openFilePicker} />

  <main>
    {#if !editor.hasDocument}
      <Welcome onopenfiles={openFilePicker} />
    {:else if editor.view === "organizer"}
      <GridOrganizer onaddfiles={openFilePicker} />
    {:else}
      {#if editor.sidebarOpen}
        <button class="sidebar-backdrop" aria-label="Cerrar panel de páginas" onclick={() => (editor.sidebarOpen = false)}
        ></button>
      {/if}
      <Sidebar onaddfiles={openFilePicker} />
      <Workspace />
    {/if}
  </main>

  <input
    bind:this={fileInput}
    type="file"
    accept="application/pdf,.pdf"
    multiple
    hidden
    onchange={onFilesChosen}
  />

  {#if dragDepth > 0}
    <div class="drop-overlay" aria-hidden="true">
      <div>
        <strong>Suelta los archivos aquí</strong>
        <span>
          {editor.hasDocument
            ? "Los PDF se añaden al final del documento y las imágenes a la página actual."
            : "Se abrirán los archivos PDF."}
        </span>
      </div>
    </div>
  {/if}

  {#if editor.busy}
    <div class="busy" role="status" aria-live="polite">
      <div class="busy-card">
        <span class="spinner"></span>
        {editor.busy}
      </div>
    </div>
  {/if}

  {#if editor.signatureOpen}
    <SignatureModal />
  {/if}

  {#if editor.shortcutsOpen}
    <ShortcutsModal />
  {/if}

  {#if editor.passwordRequest}
    {#key editor.passwordRequest}
      <PasswordModal request={editor.passwordRequest} />
    {/key}
  {/if}

  <Toasts />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }
  main {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .sidebar-backdrop {
    display: none;
  }
  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 1500;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(25, 118, 210, 0.12);
    border: 3px dashed var(--color-primary);
    pointer-events: none;
  }
  .drop-overlay div {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 20px 28px;
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-lg);
    text-align: center;
  }
  .drop-overlay strong {
    font-size: 18px;
    color: var(--color-primary);
  }
  .drop-overlay span {
    color: var(--color-text-muted);
  }
  .busy {
    position: fixed;
    inset: 0;
    z-index: 1800;
    display: grid;
    place-items: center;
    background: rgba(255, 255, 255, 0.55);
    cursor: progress;
  }
  .busy-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 24px;
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-lg);
    color: var(--color-primary);
    font-weight: 500;
  }

  @media (max-width: 768px) {
    .sidebar-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 150;
      border: none;
      background: rgba(15, 23, 42, 0.4);
    }
  }
</style>
