<script lang="ts">
  import { editorStore } from "./lib/store";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import Workspace from "./lib/components/Workspace.svelte";
  import GridOrganizer from "./lib/components/GridOrganizer.svelte";
  import { Plus, LayoutGrid, Trash2, Type } from "lucide-svelte";
  import * as pdfjsLib from "pdfjs-dist";

  import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

  import { PDFDocument, rgb, degrees } from "pdf-lib";

  async function handleFileUpload(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;

    let finalBytes = $editorStore.originalPdfBytes;
    let existingDoc: PDFDocument | null = null;

    try {
      if (finalBytes) {
        existingDoc = await PDFDocument.load(finalBytes, {
          ignoreEncryption: true,
        });
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const arrayBuffer = await file.arrayBuffer();
        const newBytes = new Uint8Array(arrayBuffer as ArrayBuffer);

        if (!existingDoc) {
          existingDoc = await PDFDocument.load(newBytes, {
            ignoreEncryption: true,
          });
          editorStore.update((s) => ({
            ...s,
            documentId: file.name,
            activeTool: "SELECT",
            pagesAnnotations: {},
            errorMessage: null,
            history: [{}],
            historyIndex: 0,
          }));
        } else {
          const newDoc = await PDFDocument.load(newBytes, {
            ignoreEncryption: true,
          });
          const newPageIndices = newDoc.getPageIndices();
          const copiedPages = await existingDoc.copyPages(
            newDoc,
            newPageIndices,
          );

          for (const page of copiedPages) {
            existingDoc.addPage(page);
          }
        }
      }

      if (existingDoc) {
        finalBytes = await existingDoc.save();
        editorStore.update((s) => ({
          ...s,
          originalPdfBytes: finalBytes,
          errorMessage: null,
          history: [s.pagesAnnotations],
          historyIndex: 0,
        }));

        const loadingTask = pdfjsLib.getDocument({
          data: finalBytes.slice(),
          fontExtraProperties: true,
          disableFontFace: false,
          standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/standard_fonts/`,
        });
        const pdf = await loadingTask.promise;

        $editorStore.numPages = pdf.numPages;
      }
    } catch (error) {
      console.error("Error loading PDF:", error);
      editorStore.update((s) => ({
        ...s,
        errorMessage:
          "No se pudo cargar o abrir uno de los documentos PDF. Asegúrate de que el archivo no esté corrupto o protegido con contraseña.",
      }));
    } finally {
      (e.target as HTMLInputElement).value = "";
    }
  }

  async function handleExport() {
    if (!$editorStore.originalPdfBytes) return;

    const pdfDoc = await PDFDocument.load($editorStore.originalPdfBytes);
    const pages = pdfDoc.getPages();

    for (const [pageStr, annotation] of Object.entries(
      $editorStore.pagesAnnotations,
    )) {
      const pageIndex = parseInt(pageStr) - 1;
      const page = pages[pageIndex];
      const { height: pdfHeight } = page.getSize();
      const pageRotation = page.getRotation().angle;
      const cropBox = page.getCropBox();
      const cLeft = cropBox.x || 0;
      const cBottom = cropBox.y || 0;
      const cWidth = cropBox.width;
      const cHeight = cropBox.height;

      const { viewportDimensions, fabricJSON } = annotation;
      const objects = fabricJSON.objects || [];
      const textDrawPromises: Promise<void>[] = [];

      for (const obj of objects) {
        const scaleY = obj.scaleY || 1;
        const scaleX = obj.scaleX || 1;
        const fabricAngle = obj.angle || 0;
        const rad = (fabricAngle * Math.PI) / 180;

        if (
          obj.type === "i-text" ||
          obj.type === "text" ||
          obj.type === "IText" ||
          obj.type === "Text"
        ) {
          const isBold = obj.fontWeight === "bold";
          const isItalic = obj.fontStyle === "italic";
          let fontType = "Helvetica";

          if (obj.fontFamily === "Times New Roman") fontType = "TimesRoman";
          if (obj.fontFamily === "Courier") fontType = "Courier";

          let pdfLibFontId = fontType;
          if (isBold && isItalic) pdfLibFontId += "-BoldOblique";
          else if (isBold) pdfLibFontId += "-Bold";
          else if (isItalic) pdfLibFontId += "-Oblique";

          if (pdfLibFontId === "TimesRoman-Oblique")
            pdfLibFontId = "TimesRoman-Italic";
          if (pdfLibFontId === "TimesRoman-BoldOblique")
            pdfLibFontId = "TimesRoman-BoldItalic";

          textDrawPromises.push(
            import("pdf-lib").then(async ({ StandardFonts }) => {
              const fontToUse = await pdfDoc.embedFont(
                StandardFonts[pdfLibFontId as keyof typeof StandardFonts] ||
                  StandardFonts.Helvetica,
              );

              const { drawFabricTextToPdf } =
                await import("./lib/pdfTextMatrix");
              const cropBoxData = {
                x: cLeft,
                y: cBottom,
                width: cWidth,
                height: cHeight,
              };

              await drawFabricTextToPdf(
                page,
                obj,
                viewportDimensions,
                cropBoxData,
                pageRotation,
                fontToUse,
              );
            }),
          );
        } else if (
          obj.type === "image" ||
          obj.type === "Image" ||
          obj.type === "FabricImage"
        ) {
          textDrawPromises.push(
            (async () => {
              if (!obj.src) return;
              try {
                let imgToDraw;
                if (obj.src.includes("image/png")) {
                  imgToDraw = await pdfDoc.embedPng(obj.src);
                } else {
                  imgToDraw = await pdfDoc.embedJpg(obj.src);
                }

                const { drawFabricImageToPdf } =
                  await import("./lib/pdfTextMatrix");
                const cropBoxData = {
                  x: cLeft,
                  y: cBottom,
                  width: cWidth,
                  height: cHeight,
                };

                await drawFabricImageToPdf(
                  page,
                  obj,
                  viewportDimensions,
                  cropBoxData,
                  pageRotation,
                  imgToDraw,
                );
              } catch (e) {
                console.error("Failed to embed image into PDF", e);
              }
            })(),
          );
        }
      }
      await Promise.all(textDrawPromises);
    }

    const modifiedBytes = await pdfDoc.save();

    const blob = new Blob([modifiedBytes as any], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const originalName = $editorStore.documentId || "document";
    const nameWithoutExt = originalName.toLowerCase().endsWith(".pdf")
      ? originalName.slice(0, -4)
      : originalName;
    a.download = `${nameWithoutExt}_ytaPDF.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function handleTextStyleUpdate(e: CustomEvent) {
    window.dispatchEvent(
      new CustomEvent("update-text-style", { detail: e.detail }),
    );
  }
</script>

<div class="app-container">
  <Toolbar
    on:exportPdf={handleExport}
    on:updateTextStyle={handleTextStyleUpdate}
  />

  {#if $editorStore.errorMessage}
    <div class="error-banner">
      <span class="error-text">{$editorStore.errorMessage}</span>
      <button
        class="close-error-btn"
        on:click={() => ($editorStore.errorMessage = null)}>✕</button
      >
    </div>
  {/if}

  <div class="main-content">
    {#if !$editorStore.originalPdfBytes}
      <div class="empty-state">
        <div class="upload-card">
          <div class="logo-container">
            <img src="/paty.png" alt="Paty Logo" />
          </div>
          <h2>
            Bienvenido a <span class="brand-yta">yta</span><span
              class="brand-pdf">PDF</span
            >
          </h2>
          <p class="subtitle">
            La herramienta web rápida y privada para gestionar tus documentos.
          </p>

          <div class="features-grid">
            <div class="feature-item">
              <Plus size={20} class="feat-icon" />
              <span>Unir múltiples PDFs</span>
            </div>
            <div class="feature-item">
              <LayoutGrid size={20} class="feat-icon" />
              <span>Reorganizar páginas</span>
            </div>
            <div class="feature-item">
              <Trash2 size={20} class="feat-icon" />
              <span>Eliminar hojas</span>
            </div>
            <div class="feature-item">
              <Type size={20} class="feat-icon" />
              <span>Añadir texto e imágenes</span>
            </div>
          </div>

          <label class="upload-btn">
            Cargar PDFs
            <input
              type="file"
              accept="application/pdf"
              multiple
              on:change={handleFileUpload}
            />
          </label>
        </div>
      </div>
    {:else}
      {#if $editorStore.isOrganizerMode}
        <GridOrganizer />
      {:else}
        {#if $editorStore.isMobileSidebarOpen}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="sidebar-overlay"
            on:click={() => ($editorStore.isMobileSidebarOpen = false)}
          ></div>
        {/if}
        <Sidebar
          on:addPdf={() => document.getElementById("merge-pdf-input")?.click()}
        />
        <Workspace />
      {/if}

      <input
        id="merge-pdf-input"
        type="file"
        accept="application/pdf"
        multiple
        on:change={handleFileUpload}
        style="display: none;"
      />
    {/if}
  </div>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family:
      "Inter",
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Roboto,
      sans-serif;
    background: #f5f5f5;
    color: #333;
    overflow: hidden;
  }
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
  }
  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fafafa;
  }
  .upload-card {
    background: white;
    padding: 60px;
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.05);
    text-align: center;
    border: 1px dashed #ccc;
    max-width: 600px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .logo-container {
    margin-bottom: 24px;
    max-width: 160px;
    display: flex;
    justify-content: center;
  }
  .logo-container img {
    max-width: 100%;
    height: auto;
  }
  .upload-card h2 {
    margin: 0 0 8px 0;
    font-size: 28px;
    font-weight: 600;
  }
  .subtitle {
    color: #666;
    margin-bottom: 32px;
    font-size: 15px;
  }
  .features-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    text-align: left;
    margin-bottom: 32px;
    background: #f8fafc;
    padding: 24px;
    border-radius: 12px;
    border: 1px solid #e2e8f0;
    width: 100%;
    box-sizing: border-box;
  }
  @media (max-width: 600px) {
    .features-grid {
      grid-template-columns: 1fr;
    }
    .upload-card {
      padding: 30px 20px;
    }
  }
  .feature-item {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 15px;
    font-weight: 500;
    color: #334155;
  }
  :global(.feat-icon) {
    color: #1976d2;
  }
  .brand-yta {
    color: #333;
  }
  .brand-pdf {
    color: #1976d2;
  }
  .upload-btn {
    display: inline-block;
    margin-top: 24px;
    padding: 12px 28px;
    background: #1976d2;
    color: white;
    font-size: 16px;
    font-weight: 500;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .upload-btn:hover {
    background: #1565c0;
  }
  .upload-btn input {
    display: none;
  }
  .error-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: #fee2e2;
    color: #b91c1c;
    padding: 12px 24px;
    font-size: 14px;
    font-weight: 500;
    border-bottom: 1px solid #fca5a5;
    z-index: 1000;
  }
  .error-text {
    flex: 1;
  }
  .close-error-btn {
    background: transparent;
    border: none;
    color: #b91c1c;
    font-size: 16px;
    cursor: pointer;
    padding: 0 8px;
  }
  .close-error-btn:hover {
    color: #7f1d1d;
  }
  .sidebar-overlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 90;
    backdrop-filter: blur(2px);
  }
  @media (max-width: 768px) {
    .sidebar-overlay {
      display: block;
    }
  }
</style>
