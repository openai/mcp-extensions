import { z } from "zod";

import type { OpenAISettings } from "../src/server/index.js";

// Compile-only examples: unused @ts-expect-error directives fail the test build.
export function checkSettingsTypes(settings: OpenAISettings) {
  settings.register({
    layout: [
      {
        kind: "group",
        title: "Display",
        items: [{ kind: "property", property: "units" }],
      },
    ],
    fields: {
      units: { schema: z.enum(["mm", "in"]), title: "Units" },
      showGrid: { schema: z.boolean().optional(), title: "Grid" },
    },
    read: () => ({ units: "mm", showGrid: true }),
    update: async (set) => {
      const units: "mm" | "in" | undefined = set.units;
      const grid: boolean | undefined = set.showGrid;
      // @ts-expect-error Unknown setting.
      void set.unknown;
      // @ts-expect-error Updates may omit units.
      const required: "mm" | "in" = set.units;
      void required;
      return { units: units ?? "mm", showGrid: grid ?? true };
    },
  });
  settings.register({
    fields: { units: { schema: z.string(), title: "Units" } },
    layout: [
      // @ts-expect-error Layout entries must be groups.
      { kind: "property", property: "missing" },
      {
        kind: "group",
        title: "Display",
        items: [
          // @ts-expect-error Nested layout keys must also come from fields.
          { kind: "property", property: "missing" },
        ],
      },
    ],
    read: () => ({ units: "mm" }),
    update: () => ({ units: "mm" }),
  });
  settings.register({
    fields: {
      // @ts-expect-error A title is required.
      units: { schema: z.string() },
      // @ts-expect-error A schema is required.
      showGrid: { title: "Grid" },
    },
    read: () => ({ units: "mm", showGrid: true }),
    update: () => ({ units: "mm", showGrid: true }),
  });
  settings.register({
    fields: {
      units: { schema: z.enum(["mm", "in"]), title: "Units" },
      showGrid: { schema: z.boolean().optional(), title: "Grid" },
    },
    // @ts-expect-error Optional schemas still require effective values in read results.
    read: () => ({ units: "mm" }),
    // @ts-expect-error Async updates must return complete values too.
    update: async () => ({ units: "mm" }),
  });
  settings.register({
    fields: { units: { schema: z.enum(["mm", "in"]), title: "Units" } },
    // @ts-expect-error Invalid enum value.
    read: () => ({ units: "cm" }),
    // @ts-expect-error Invalid value type.
    update: () => ({ units: 1 }),
  });
}
