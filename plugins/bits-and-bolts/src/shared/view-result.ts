import type { PublicCadPart } from "./contracts.js";

type ViewData = Record<string, unknown> & {
  part?: PublicCadPart;
  parts?: PublicCadPart[];
};

/** Keep preview images and the full catalog in component-only metadata. */
export function createViewResult(data: ViewData) {
  const { parts, part, ...state } = data;
  return {
    content: [],
    structuredContent: {
      ...state,
      ...(parts === undefined ? {} : { partCount: parts.length }),
      ...(part === undefined ? {} : { part: { ...part, previews: {} } }),
    },
    _meta: { "bits-and-bolts/view": data },
  };
}
