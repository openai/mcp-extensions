import type { PreviewImages, PublicCadPart } from "../shared/contracts.js";

export function filterParts(parts: PublicCadPart[], query: string) {
  return parts.filter((part) =>
    [part.name, part.description, part.fileName, part.format, ...part.tags]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
}

/** The library owns presentation and loads missing thumbnails one at a time. */
export function createLibrary({
  openPart,
  canOpen,
  loadPreviews,
  toggleSelection,
  isSelected,
  canSelect,
  showSelection,
}: {
  openPart: (part: PublicCadPart) => void | Promise<void>;
  canOpen: () => boolean;
  loadPreviews: (part: PublicCadPart) => Promise<PreviewImages | undefined>;
  toggleSelection: (part: PublicCadPart) => Promise<void>;
  isSelected: (partId: string) => boolean;
  canSelect: () => boolean;
  showSelection: () => boolean;
}) {
  const container = document.getElementById("parts")!;
  const count = document.getElementById("part-count")!;
  const pending = new Map<Element, PublicCadPart>();
  const queue: Array<{ element: HTMLElement; part: PublicCadPart }> = [];
  let loading = false;
  let disposed = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const part = pending.get(entry.target);
      observer.unobserve(entry.target);
      pending.delete(entry.target);
      if (part) queue.push({ element: entry.target as HTMLElement, part });
    }
    void loadNext();
  });
  async function loadNext() {
    if (loading) return;
    loading = true;
    try {
      while (queue.length && !disposed) {
        const { element, part } = queue.shift()!;
        if (!element.isConnected) continue;
        try {
          const previews = await loadPreviews(part);
          if (previews && !disposed) {
            part.previews = previews;
            if (element.isConnected) showPreview(element, part);
          }
        } catch {
          // A thumbnail failure must not prevent opening the CAD file.
          if (element.isConnected)
            element.firstChild!.textContent = "Open to preview";
        }
      }
    } finally {
      loading = false;
    }
  }
  function text(tag: string, className: string, value: string) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
  }
  function showPreview(element: HTMLElement, part: PublicCadPart) {
    const url = part.previews.isometric;
    if (!url) return;
    const image = document.createElement("img");
    image.decoding = "async";
    image.onerror = () => {
      if (part.previews.isometric === url) delete part.previews.isometric;
      image.replaceWith(text("span", "muted", "Open to preview"));
    };
    image.src = url;
    image.alt = `${part.name} isometric preview`;
    element.firstChild!.replaceWith(image);
  }
  function updateSelectionButton(button: HTMLButtonElement) {
    const selected = isSelected(button.dataset.partId!);
    const action = selected ? "Remove from chat" : "Add to chat";
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-label", `${action}: ${button.dataset.partName}`);
    button.title = action;
    button
      .querySelector("path")!
      .setAttribute("d", selected ? "m4 10 4 4 8-8" : "M4 10h12M10 4v12");
    button.hidden = !showSelection();
    button.disabled = !canSelect();
  }
  return {
    render(
      parts: PublicCadPart[],
      query: string,
      state: "loading" | "error" | "ready",
    ) {
      observer.disconnect();
      pending.clear();
      queue.length = 0;
      const matching = filterParts(parts, query);
      count.textContent =
        state === "loading"
          ? "Loading parts…"
          : state === "error"
            ? "Library unavailable"
            : `${matching.length} ${matching.length === 1 ? "part" : "parts"}`;
      container.replaceChildren();
      for (const part of matching) {
        const card = document.createElement("div");
        card.className = "part";
        const button = document.createElement("button");
        button.className = "btn btn-ghost part-open";
        button.setAttribute("aria-label", `Open ${part.name}`);
        button.disabled = !canOpen();
        const preview = text("span", "part-preview", "");
        preview.append(
          text("span", "muted", "Open to preview"),
          text("span", "part-format", part.format.toUpperCase()),
        );
        showPreview(preview, part);
        const tags = text("span", "part-tags", "");
        for (const tag of part.tags) tags.append(text("span", "part-tag", tag));
        const size =
          part.sizeBytes < 1024 * 1024
            ? `${Math.ceil(part.sizeBytes / 1024)} KB`
            : `${(part.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
        button.append(
          preview,
          text("strong", "", part.name),
          text("small", "part-description", part.description),
          text("small", "part-file", `${part.format.toUpperCase()} · ${size}`),
          tags,
        );
        button.onclick = async () => {
          const title = button.querySelector("strong")!;
          button.disabled = true;
          button.setAttribute("aria-busy", "true");
          title.textContent = `Opening ${part.name}…`;
          try {
            await openPart(part);
          } finally {
            title.textContent = part.name;
            button.disabled = false;
            button.removeAttribute("aria-busy");
          }
        };
        const select = document.createElement("button");
        select.className = "btn";
        select.innerHTML =
          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path /></svg>';
        select.dataset.partId = part.id;
        select.dataset.partName = part.name;
        updateSelectionButton(select);
        select.onclick = () => toggleSelection(part);
        card.append(button, select);
        container.append(card);
        if (!part.previews.isometric) {
          pending.set(preview, part);
          observer.observe(preview);
        }
      }
      if (!matching.length) {
        const empty = text(
          "p",
          "muted",
          state === "loading"
            ? "Loading your parts library…"
            : state === "error"
              ? "We couldn’t load the library. Try again."
              : parts.length
                ? "No matching parts."
                : "Your library is empty. Add a CAD file to get started.",
        );
        empty.id = "library-empty";
        container.append(empty);
      }
    },
    updateSelection() {
      for (const button of container.querySelectorAll<HTMLButtonElement>(
        "[data-part-id]",
      )) {
        updateSelectionButton(button);
      }
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      pending.clear();
      queue.length = 0;
    },
  };
}
