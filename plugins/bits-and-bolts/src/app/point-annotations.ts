import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { PublicCadPart } from "../shared/contracts.js";
import type { CadSelection } from "./viewer/scene.js";

type PointSnapshot = {
  partName: string;
  selection: CadSelection;
  dimensionsMm: number[];
  camera: string;
  image?: { data: string; mimeType: string };
};

type Annotation = PointSnapshot & {
  id: string;
  title: string;
  location: boolean;
  includeImage: boolean;
  reference?: PublicCadPart;
  comment: string;
  element: HTMLElement;
  imageToggle: HTMLInputElement;
  referenceSelect: HTMLSelectElement;
  commentInput: HTMLTextAreaElement;
};

/** Each picked point owns a frozen view and one composer context group. */
export function createPointAnnotations({
  container,
  getParts,
  onChange,
}: {
  container: HTMLElement;
  getParts: () => PublicCadPart[];
  onChange: () => void;
}) {
  let annotations: Annotation[] = [];
  let nextPoint = 1;

  function metadata(annotation: Annotation, kind: string, title: string) {
    return {
      "openai/group": { title: annotation.title },
      "openai/title": title,
      "bits-and-bolts/pointId": annotation.id,
      "bits-and-bolts/pointContent": kind,
    };
  }

  function updateReferences(annotation: Annotation) {
    annotation.referenceSelect.replaceChildren(
      new Option("No reference part", ""),
    );
    for (const part of getParts()) {
      if (part.resourceUri) {
        annotation.referenceSelect.add(new Option(part.name, part.resourceUri));
      }
    }
    annotation.referenceSelect.value = annotation.reference?.resourceUri ?? "";
    annotation.referenceSelect.parentElement!.hidden = getParts().length === 0;
  }

  function add(snapshot: PointSnapshot) {
    const title = `Point ${nextPoint++}`;
    const element = document.createElement("section");
    element.className = "point-annotation";
    const heading = document.createElement("div");
    heading.className = "point-heading";
    const label = document.createElement("strong");
    label.textContent = title;
    const remove = document.createElement("button");
    remove.className = "btn btn-ghost";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${title}`);
    heading.append(label, remove);

    const imageLabel = document.createElement("label");
    imageLabel.className = "form-check";
    const imageToggle = document.createElement("input");
    imageToggle.type = "checkbox";
    imageToggle.className = "form-check-input";
    imageToggle.checked = snapshot.image != null;
    imageLabel.hidden = snapshot.image == null;
    imageLabel.append(imageToggle, "Include image");
    const image = document.createElement("img");
    image.className = "point-image";
    image.alt = `${title} on ${snapshot.partName}`;
    image.hidden = snapshot.image == null;
    if (snapshot.image) {
      image.src = `data:${snapshot.image.mimeType};base64,${snapshot.image.data}`;
    }

    const referenceLabel = document.createElement("label");
    referenceLabel.className = "point-field";
    const referenceSelect = document.createElement("select");
    referenceSelect.className = "form-select";
    referenceLabel.append("Reference part", referenceSelect);
    const commentLabel = document.createElement("label");
    commentLabel.className = "point-field";
    const commentInput = document.createElement("textarea");
    commentInput.className = "form-control";
    commentInput.rows = 2;
    commentInput.placeholder = "What should change here?";
    commentLabel.append("Comment", commentInput);
    element.append(heading, imageLabel, image, referenceLabel, commentLabel);

    const annotation: Annotation = {
      ...snapshot,
      id: crypto.randomUUID(),
      title,
      location: true,
      includeImage: snapshot.image != null,
      comment: "",
      element,
      imageToggle,
      referenceSelect,
      commentInput,
    };
    updateReferences(annotation);
    annotations.push(annotation);
    container.append(element);
    remove.onclick = () => {
      annotations = annotations.filter((point) => point !== annotation);
      element.remove();
      onChange();
    };
    imageToggle.onchange = () => {
      annotation.includeImage = imageToggle.checked;
      image.hidden = !imageToggle.checked;
      onChange();
    };
    referenceSelect.onchange = () => {
      annotation.reference = getParts().find(
        (part) => part.resourceUri === referenceSelect.value,
      );
      onChange();
    };
    commentInput.oninput = () => {
      annotation.comment = commentInput.value;
      onChange();
    };
    onChange();
  }

  function content(): ContentBlock[] {
    return annotations.flatMap((annotation) => {
      const blocks: ContentBlock[] = [];
      if (annotation.location) {
        blocks.push({
          type: "resource",
          resource: {
            uri: `urn:uuid:${annotation.id}`,
            mimeType: "text/markdown",
            text: [
              `# ${annotation.title} on ${annotation.partName}`,
              `Position (mm): ${annotation.selection.point.join(", ")}`,
              `Surface: ${annotation.selection.component}`,
              `Part dimensions (mm): ${annotation.dimensionsMm.join(" × ")}`,
              `View: ${annotation.camera}`,
            ].join("\n\n"),
          },
          _meta: metadata(annotation, "location", "Point location"),
        });
      }
      if (annotation.includeImage && annotation.image) {
        blocks.push({
          type: "image",
          ...annotation.image,
          _meta: metadata(
            annotation,
            "image",
            `${annotation.title} on ${annotation.partName}`,
          ),
        });
      }
      if (annotation.reference) {
        const part = annotation.reference;
        blocks.push({
          type: "resource_link",
          uri: part.resourceUri,
          name: part.fileName,
          title: part.name,
          mimeType: "text/markdown",
          _meta: metadata(annotation, "reference", part.name),
        });
      }
      if (annotation.comment.trim()) {
        blocks.push({
          type: "text",
          text: `${annotation.title} on ${annotation.partName}: ${annotation.comment}`,
          _meta: metadata(annotation, "comment", "Comment"),
        });
      }
      return blocks;
    });
  }

  function reconcile(blocks: ContentBlock[], submitted: ContentBlock[]) {
    annotations = annotations.filter((annotation) => {
      const sent = submitted.filter(
        (block) => block._meta?.["bits-and-bolts/pointId"] === annotation.id,
      );
      if (!sent.length) return true;
      const remaining = blocks.filter(
        (block) => block._meta?.["bits-and-bolts/pointId"] === annotation.id,
      );
      if (!remaining.length) {
        annotation.element.remove();
        return false;
      }
      const removed = (kind: string) =>
        sent.some(
          (block) => block._meta?.["bits-and-bolts/pointContent"] === kind,
        ) &&
        !remaining.some(
          (block) => block._meta?.["bits-and-bolts/pointContent"] === kind,
        );
      if (removed("location")) annotation.location = false;
      if (removed("image")) {
        annotation.includeImage = false;
        annotation.imageToggle.checked = false;
        annotation.element.querySelector("img")!.hidden = true;
      }
      if (removed("reference")) {
        annotation.reference = undefined;
        annotation.referenceSelect.value = "";
      }
      if (removed("comment")) {
        annotation.comment = "";
        annotation.commentInput.value = "";
      }
      return true;
    });
  }

  return {
    add,
    content,
    reconcile,
    clear() {
      annotations = [];
      nextPoint = 1;
      container.replaceChildren();
    },
    refreshReferences() {
      annotations.forEach(updateReferences);
    },
  };
}
