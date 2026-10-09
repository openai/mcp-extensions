declare const __LOCAL_FILESYSTEM__: boolean;

type MessageOptions = { target: "active" | "new"; send: boolean };
type Guide = { target: string; text: string };
type Feature = {
  title: string;
  open: () => Promise<Guide | void> | Guide | void;
};
type Section = { title: string; items: (Feature | Section)[] };

/** Keep the feature tree aligned with the major sections of the spec. */
export function createExtensionsWalkthrough({
  menu,
  openLibrary,
  openPart,
  openCreatePart,
  hasActiveConversation,
  openSourceFile,
  openPluginDetails,
  openDeepLink,
  startConversation,
  runTool,
  fail,
}: {
  menu: HTMLDetailsElement;
  openLibrary: () => void;
  openPart: () => Promise<void>;
  openCreatePart: (options: MessageOptions) => void;
  hasActiveConversation: () => boolean;
  openSourceFile: () => Promise<boolean>;
  openPluginDetails: () => Promise<boolean>;
  openDeepLink: () => Promise<boolean>;
  startConversation: (prompt: string) => Promise<void>;
  runTool: (name: string, args?: Record<string, unknown>) => Promise<void>;
  fail: (error: unknown) => void;
}) {
  const libraryGuide = (text: string, target = "#heading"): Guide => {
    openLibrary();
    return { target, text };
  };
  const partGuide = async (
    text: string,
    target = "#viewport",
  ): Promise<Guide> => {
    await openPart();
    return { target, text };
  };
  const details = async (text: string) => {
    if (!(await openPluginDetails())) return libraryGuide(text);
  };
  const message = (
    title: string,
    target: MessageOptions["target"],
    send: boolean,
  ): Feature => ({
    title,
    open: async () => {
      if (target === "active" && !hasActiveConversation()) {
        await startConversation(
          "Open the Bits & Bolts Parts Tray so I can try Create part in this conversation.",
        );
        return;
      }
      openLibrary();
      openCreatePart({ target, send });
      return {
        target: "#part-prompt",
        text: send
          ? "Describe a part to create, choose the conversation, then send your request."
          : "Describe a part to create. Open the draft to finish your request in the composer before sending.",
      };
    },
  });
  const features: Section[] = [
    {
      title: "Entrypoints",
      items: [
        {
          title: "Sidebar library",
          open: () =>
            libraryGuide(
              "The sidebar entry opens this Parts Library. It stays available while you work.",
            ),
        },
        {
          title: "Conversation tray",
          open: () =>
            startConversation(
              "Open the Bits & Bolts Parts Tray beside this conversation.",
            ),
        },
        {
          title: "File viewer",
          open: () =>
            partGuide(
              "Open an STL, 3MF or STEP file with Bits & Bolts to use its file viewer.",
            ),
        },
        {
          title: "Deep links",
          open: async () => {
            if (!(await openDeepLink()))
              return partGuide(
                "A plugin deep link opens this part directly instead of returning to the library.",
              );
          },
        },
      ],
    },
    {
      title: "Structured settings",
      items: [
        {
          title: "Viewing preferences",
          open: () =>
            details(
              "Open Bits & Bolts plugin details, then Settings. Change units, the grid or the default view.",
            ),
        },
        {
          title: "Manage the Parts Library",
          open: () =>
            details(
              "Open Bits & Bolts plugin details, then Settings. Parts Library opens an app modal from the settings layout.",
            ),
        },
      ],
    },
    {
      title: "Display modes",
      items: [
        {
          title: "Inline and fullscreen",
          open: () =>
            startConversation(
              "Show the Codex Micro joystick cap inline with Bits & Bolts so I can inspect it.",
            ),
        },
      ],
    },
    {
      title: "Plugin onboarding",
      items: [
        {
          title: "Set up units and grid",
          open: () =>
            details(
              "Open Bits & Bolts plugin details and choose Set up. Onboarding asks for units and grid preferences.",
            ),
        },
      ],
    },
    {
      title: "Extended model context",
      items: [
        {
          title: "Reference parts",
          open: () =>
            libraryGuide(
              "Use a part's + button to attach its resource reference to the composer.",
              "#parts",
            ),
        },
        {
          title: "Point annotations",
          open: () =>
            partGuide(
              "Click a surface point. Include an image, choose a reference part and add a comment. Each point becomes one removable composer group.",
            ),
        },
        {
          title: "Live view state",
          open: () =>
            partGuide(
              "Orbit or zoom the model. The current view and dimensions reach the model as background state without another attachment.",
              "#camera",
            ),
        },
      ],
    },
    {
      title: "Extended message sending",
      items: [
        message("Create in this chat", "active", true),
        message("Create in a new chat", "new", true),
        message("Draft in this chat", "active", false),
        message("Draft in a new chat", "new", false),
      ],
    },
    {
      title: "Local files",
      items: [
        ...(__LOCAL_FILESYSTEM__
          ? [
              {
                title: "Open a source file",
                open: async () => {
                  if (!(await openSourceFile()))
                    return libraryGuide(
                      "Open a local CAD file with Bits & Bolts on Desktop. Source opening needs the Local plugin and local file access.",
                    );
                },
              },
            ]
          : []),
        {
          title: "Read, watch and save files",
          open: async () => {
            if (!(await openSourceFile()))
              return libraryGuide(
                "On Desktop, open a writable STL file with Bits & Bolts. The file entry watches the source. Rotate its geometry in chat, then use Save changes to write it back.",
              );
          },
        },
      ],
    },
    {
      title: "Composer mentions",
      items: [
        {
          title: "Find a part with @",
          open: () =>
            libraryGuide(
              "Type @Bits & Bolts in the composer, then search for a part. Selecting a result attaches its resource reference.",
            ),
        },
      ],
    },
    {
      title: "Extended forms",
      items: [
        { title: "Thumbnail choices", open: () => runTool("cad.pickFile") },
        {
          title: "Requirements and suggested values",
          open: () => runTool("cad.reviewForm"),
        },
        {
          title: "Resource selection",
          items: [
            {
              title: "One reference",
              open: () =>
                runTool("cad.pickReferences", { selection: "single" }),
            },
            {
              title: "Choose several references",
              open: () =>
                runTool("cad.pickReferences", { selection: "explicit" }),
            },
            {
              title: "All references except exclusions",
              open: () =>
                runTool("cad.pickReferences", { selection: "implicit" }),
            },
            {
              title: "Files and folders",
              open: () =>
                runTool("cad.pickReferences", {
                  selection: "explicit",
                  kind: "directory",
                }),
            },
          ],
        },
      ],
    },
  ];
  const popover = document.createElement("div");
  popover.className = "extension-guide";
  popover.setAttribute("popover", "auto");
  popover.setAttribute("role", "dialog");
  const heading = document.createElement("strong");
  const description = document.createElement("p");
  const close = document.createElement("button");
  close.className = "btn btn-ghost";
  close.textContent = "Got it";
  close.onclick = () => popover.hidePopover();
  popover.append(heading, description, close);
  document.body.append(popover);
  let highlighted: HTMLElement | undefined;
  popover.addEventListener("toggle", () => {
    if (!popover.matches(":popover-open"))
      highlighted?.classList.remove("walkthrough-target");
  });

  const render = (items: (Section | Feature)[], parent: HTMLElement) => {
    for (const item of items) {
      if ("items" in item) {
        const group = document.createElement("details");
        const label = document.createElement("summary");
        label.textContent = item.title;
        group.append(label);
        render(item.items, group);
        parent.append(group);
      } else {
        const button = document.createElement("button");
        button.className = "btn btn-ghost";
        button.textContent = item.title;
        button.onclick = async () => {
          menu.open = false;
          popover.hidePopover();
          try {
            const guide = await item.open();
            if (!guide) return;
            const target = document.querySelector<HTMLElement>(guide.target);
            if (!target) return;
            target.scrollIntoView({ block: "nearest" });
            (target.closest("dialog") ?? document.body).append(popover);
            highlighted?.classList.remove("walkthrough-target");
            highlighted = target;
            target.classList.add("walkthrough-target");
            heading.textContent = item.title;
            description.textContent = guide.text;
            const rect = target.getBoundingClientRect();
            popover.style.left =
              Math.max(12, Math.min(rect.left, innerWidth - 312)) + "px";
            popover.showPopover();
            popover.style.top =
              Math.max(
                12,
                Math.min(
                  rect.bottom + 8,
                  innerHeight - popover.offsetHeight - 12,
                ),
              ) + "px";
          } catch (error) {
            fail(error);
          }
        };
        parent.append(button);
      }
    }
  };
  render(features, menu.querySelector<HTMLElement>(".menu")!);
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !menu.contains(event.target))
      menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary")!.focus();
    }
  });
}
