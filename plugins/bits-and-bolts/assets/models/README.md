# Codex Micro reference models

These meshes are visual replicas, not manufacturing CAD. Do not use their dimensions to verify fit or order replacement parts.

The library includes the complete assembly, sculpted dial, joystick cap, translucent agent keycap, and all 32 icon keycaps. The microphone keycap is 2U. The other icon keycaps are 1U. Each part has its own GLB display model, STL file, and library entry.

## References and scale

- [Work Louder product photos and layout drawing](https://worklouder.cc/codex-micro).
- [OpenAI product photos and keyset](https://openai.com/supply/co-lab/work-louder/).
- [Work Louder MX keycap spacing](https://worklouder.cc/wrk-mx-pure): 19.05 × 19.05 mm.
- Legend outlines are included in [the keycap assets](../keycap-legends/). The source path for each copied SVG is recorded in `../keycap-legends/keycaps.json`. The physical photos determine the keyset, rather than extra software-only key variants.

The estimated body is 108 × 108 mm. The caps are 18 mm wide on a 19.05 mm pitch. The 2U cap is 37.05 mm wide. Body thickness, cap dishes, stems, mounting recesses, fasteners, and port placement are photo-based estimates. The original placeholder STLs were not used to determine geometry.

GLB models preserve materials, translucency, and surface textures for library previews and the viewer. The viewer supplies its own lighting. STL files store geometry only. Printed legends use shallow engraved geometry so they remain visible in CAD tools. The assembly contains separate component shells and is not a single print-ready solid.

The Blender scene includes procedural plastic, aluminum, and silicone finishes, printed legends, indicator lights, and a soft studio light rig. These textures do not need external image files. Presentation bevels and frame lighting remain separate from the STL exports.

## Rebuild

All model sources, scripts, and pinned Python dependencies belong to this plugin. Model development requires Python 3.10 or later, uv, and Blender 5.2. The installed plugin does not need these tools.

If you change a legend SVG, first rebuild its planar mesh. Run this command from the plugin directory. It creates an isolated Python environment with the `models` dependencies declared in `pyproject.toml`:

```sh
uv run --extra models python scripts/prepare-legends.py
```

Run Blender 5.2 from this plugin directory:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python scripts/build-models.py
```

On other platforms, use the absolute path to the installed Blender executable. Add `-- --skip-render` to regenerate the models, catalog, and editable scene without rendering images. Add `-- --preview` for faster, 1000-pixel renders.

The script writes GLB models, ASCII STLs, and `catalog.json` here. It writes the editable Blender scene, comparison renders, and mesh report to `.local/codex-micro/`. Those local binary artifacts are not committed. The build does not require Blender and does not regenerate geometry.

The assembly STL uses a reduced mesh to stay within the MCP transport size limit. Individual parts and the Blender scene retain full detail. The exporter checks that each mesh has closed, manifold edges and is under 7 MiB before writing it.

The plugin reads these bundled assets when it creates a library. Existing libraries gain the new parts. An older bundled model is replaced only if its bytes match a known bundled version. Imported models, edited parts, and missing user files are preserved. Replaced models lose stale preview images.

The plugin uses GLB only when a library part still matches its bundled STL. Edited and imported CAD files display their own geometry.
