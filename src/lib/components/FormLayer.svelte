<script lang="ts">
  import type { PDFPageProxy } from "pdfjs-dist";
  import { editor, type PageRef } from "../editor.svelte";
  import { pageWidgets, viewportOf, type FormValue, type FormWidget } from "../pdfjs";

  interface Props {
    page: PageRef;
    pdfPage: PDFPageProxy;
    zoom: number;
  }

  let { page, pdfPage, zoom }: Props = $props();

  let widgets = $state.raw<FormWidget[]>([]);
  /** Field being typed into, shown on top of the rendered value until it is committed. */
  let editing = $state<{ id: string; value: string } | null>(null);

  $effect(() => {
    let cancelled = false;
    void pageWidgets(pdfPage).then((list) => {
      if (!cancelled) widgets = list.filter((widget) => !widget.readOnly);
    });
    return () => {
      cancelled = true;
    };
  });

  const viewport = $derived(viewportOf(pdfPage, zoom, page.rotation));
  const values = $derived(editor.formValues[page.sourceId] ?? {});

  function box(widget: FormWidget) {
    const [x1, y1] = viewport.convertToViewportPoint(widget.rect[0], widget.rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(widget.rect[2], widget.rect[3]);
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  function valueOf(widget: FormWidget): FormValue {
    return widget.fieldName in values ? values[widget.fieldName] : widget.initialValue;
  }

  function set(widget: FormWidget, value: FormValue) {
    editor.setFormValue(page.sourceId, widget.fieldName, value);
  }

  function fontSize(widget: FormWidget, height: number) {
    const size = widget.fontSize > 0 ? widget.fontSize * zoom : height * (widget.multiLine ? 0.28 : 0.62);
    return Math.max(8, Math.min(size, 40));
  }

  function commitText(widget: FormWidget) {
    if (editing?.id !== widget.id) return;
    set(widget, editing.value);
    editing = null;
  }
</script>

{#if widgets.length > 0}
  <div class="form-layer" aria-label="Campos del formulario">
    {#each widgets as widget (widget.id)}
      {@const rect = box(widget)}
      {@const value = valueOf(widget)}
      {@const style = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`}
      {#if widget.kind === "text"}
        {#if widget.multiLine}
          <textarea
            class="field text"
            class:editing={editing?.id === widget.id}
            {style}
            style:font-size="{fontSize(widget, rect.height)}px"
            style:text-align={widget.textAlign}
            aria-label={widget.fieldName}
            maxlength={widget.maxLen > 0 ? widget.maxLen : undefined}
            value={editing?.id === widget.id ? editing.value : String(value ?? "")}
            onfocus={(event) => (editing = { id: widget.id, value: event.currentTarget.value })}
            oninput={(event) => (editing = { id: widget.id, value: event.currentTarget.value })}
            onblur={() => commitText(widget)}
          ></textarea>
        {:else}
          <input
            class="field text"
            class:editing={editing?.id === widget.id}
            {style}
            style:font-size="{fontSize(widget, rect.height)}px"
            style:text-align={widget.textAlign}
            type="text"
            aria-label={widget.fieldName}
            maxlength={widget.maxLen > 0 ? widget.maxLen : undefined}
            value={editing?.id === widget.id ? editing.value : String(value ?? "")}
            onfocus={(event) => (editing = { id: widget.id, value: event.currentTarget.value })}
            oninput={(event) => (editing = { id: widget.id, value: event.currentTarget.value })}
            onblur={() => commitText(widget)}
            onkeydown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        {/if}
      {:else if widget.kind === "checkbox"}
        <button
          class="field toggle"
          {style}
          role="checkbox"
          aria-checked={value === true}
          aria-label={widget.fieldName}
          onclick={() => set(widget, value !== true)}
        ></button>
      {:else if widget.kind === "radio"}
        <button
          class="field toggle"
          {style}
          role="radio"
          aria-checked={value === widget.onValue}
          aria-label="{widget.fieldName}: {widget.onValue}"
          onclick={() => set(widget, widget.onValue ?? null)}
        ></button>
      {:else if widget.kind === "choice"}
        <select
          class="field choice"
          class:list={widget.multiSelect}
          {style}
          aria-label={widget.fieldName}
          multiple={widget.multiSelect}
          onchange={(event) => {
            const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
            set(widget, widget.multiSelect ? selected : (selected[0] ?? ""));
          }}
        >
          {#each widget.options ?? [] as option (option.value)}
            <option
              value={option.value}
              selected={Array.isArray(value) ? value.includes(option.value) : value === option.value}
            >
              {option.label}
            </option>
          {/each}
        </select>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .form-layer {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
  }
  .field {
    position: absolute;
    margin: 0;
    padding: 0 3px;
    border: 1px solid transparent;
    border-radius: 2px;
    /* Same tint PDF viewers use to show that a field can be filled. */
    background: rgba(0, 84, 255, 0.08);
    font-family: Helvetica, Arial, sans-serif;
    pointer-events: auto;
    cursor: text;
  }
  .field:hover {
    border-color: rgba(25, 118, 210, 0.6);
  }
  .field:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
  /* The page itself shows the stored value; the control only shows it while typing. */
  .text {
    color: transparent;
    caret-color: transparent;
    resize: none;
  }
  .text.editing {
    color: #111;
    caret-color: auto;
    background: #fff;
    border-color: var(--color-primary);
  }
  .toggle {
    cursor: pointer;
  }
  .choice {
    cursor: pointer;
    opacity: 0;
  }
  .choice.list {
    opacity: 1;
    color: #111;
    background: #fff;
  }
  .choice:focus-visible {
    opacity: 1;
    background: #fff;
    color: #111;
  }
</style>
