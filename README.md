# TIFF Viewer (16-bit, Float, GeoTIFF)

![License MIT](https://img.shields.io/badge/license-MIT-blue)
![Works offline](https://img.shields.io/badge/network-none-green)
![VS Code 1.90+](https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC)

Click a `.tif` or `.tiff` file and see it in VS Code, even when it is a 16-bit microscope image, a float32 elevation model or a 200-page stack.

![A 16-bit synthetic fluorescence image open in TIFF Viewer inside VS Code. The cells are bright on a dark background because the auto contrast stretches values 234 to 3082 of 65535. The status bar reads x 430, y 360, value 317. The right panel lists size 1024 x 768, 16-bit unsigned integer, PackBits, big-endian, min 189, max 4830, a histogram and the TIFF tags.](https://github.com/theluckystrike/tiff-viewer-vscode/raw/HEAD/images/microscopy-16bit.png)

*Real output from VS Code 1.142 on macOS. The file is `microscopy-16bit.tif`, made by `scripts/make-samples.js`. `scripts/e2e-vscode.mjs` installed the packaged extension in a clean VS Code profile, opened the file, moved the pointer over a cell and saved the window through the debug port.*

- You see the data, not a black square. 16-bit, 32-bit and float pages open with a percentile stretch, and you can switch to min to max, 2 to 98 percent or the full type range. The status bar shows the stored value under the pointer, not the display colour.
- GeoTIFF tags are readable. The panel shows the EPSG code, pixel size, bounds and nodata value, and the status bar gives the map coordinate of the pixel you point at. Nodata and NaN pixels stay transparent and are left out of the statistics.
- Big files don't block the editor. Pixels are decoded in a background worker. Files over 1 GB show a clear message and still list the tags of every page, read with a few small reads from disk.

## Quick start

1. Install TIFF Viewer.
2. Click any `.tif` or `.tiff` file in the Explorer. Scroll to zoom, drag to pan, and move the pointer to read values.

If another viewer opens, right-click the file and pick "Open in TIFF Viewer", or use "Reopen Editor With..." from the editor title menu. "TIFF Viewer: Get Started" in the Command Palette opens a short tour.

## What it reads

| | Supported |
|---|---|
| Containers | Classic TIFF and BigTIFF, little and big-endian, strips and tiles, chunky and planar |
| Sample types | 1, 2, 4, 8, 16, 32 and 64-bit unsigned and signed integers, 16, 32 and 64-bit float |
| Colour | Gray (BlackIsZero and WhiteIsZero), RGB and RGBA, palette, CMYK, YCbCr in JPEG |
| Compression | None, LZW, Deflate, PackBits, JPEG, CCITT Group 3 and 4 |
| Predictors | Horizontal (2) for every integer size, floating point (3) |
| Pages | Every page in the file, with thumbnails for the first 300 |

ZSTD, LERC, WebP and JPEG 2000 compressed pages are listed with their tags and a note that they can't be decoded.

## Pages, channels and contrast

![A 7-page stack. The page strip on the left shows a thumbnail for every page with its PageName, and page 3, Time point 3, is selected and shown at 190 percent.](https://github.com/theluckystrike/tiff-viewer-vscode/raw/HEAD/images/multipage-stack.png)

Multi-page files get a page strip with thumbnails and page names. PageUp and PageDown (or J and K) move through the pages.

The View menu offers the RGB composite and each channel on its own. Files with three or more gray channels, such as fluorescence stacks stored as planar samples, can be shown as RGB or one channel at a time.

![A planar 3-channel 16-bit BigTIFF with channel 2 selected. The status bar shows all three values under the pointer, C1 1114, C2 171 and C3 184.](https://github.com/theluckystrike/tiff-viewer-vscode/raw/HEAD/images/channels-16bit.png)

The Values section lists min, max, mean, the range on screen, nodata and NaN counts, and a small histogram with the range marked. 8-bit images open as stored. Everything else opens with the 0.5 to 99.5 percentile stretch.

## GeoTIFF

![A float32 elevation model in UTM zone 33N with a nodata lake shown as transparent. The GeoTIFF section lists EPSG 32633, a 30 metre pixel size, the bounds and every GeoKey, and the status bar reads 1125.17 at E 518915, N 5244225 m.](https://github.com/theluckystrike/tiff-viewer-vscode/raw/HEAD/images/geotiff-float32.png)

When a page has ModelPixelScale, ModelTiepoint, ModelTransformation or GeoKeyDirectory tags, the panel adds a GeoTIFF section with the CRS, pixel size, units, bounds, GDAL nodata value and each GeoKey by name. The pointer readout adds easting and northing, or longitude and latitude for geographic rasters. Map tiles and reprojection are not part of this extension, so it works with no network.

## Zoom, export and keys

| Action | How |
|---|---|
| Zoom | Mouse wheel or pinch, the + and - buttons, or the + and - keys |
| Fit and actual pixels | Fit and 1:1 buttons, keys 0 and 1, or double click |
| Pan | Drag the image |
| Next and previous page | PageDown and PageUp, J and K, or the page strip |
| Tags panel | Tags button or T |
| Export | Export PNG saves the page as shown, with the channel and stretch you picked |
| Copy tags | Copy, next to the Tags heading, puts every tag on the clipboard as tab-separated text |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `tiffViewer.maxFileMB` | 1024 | Files up to this size are decoded. Larger files show a message and the tags of every page. |
| `tiffViewer.askForRating` | true | Ask one time for a Marketplace rating after a few days of use. Nothing is sent anywhere. |
| `tiffViewer.showSupportLinks` | true | Show the small Sponsor and More free viewers links in the status line. |

## Privacy and safety

The extension makes no network calls and has no telemetry. The viewer is read-only. The TIFF file is never written, and the only file the extension writes is the PNG you save with Export PNG. The webview runs under a strict Content Security Policy, and tag text is shown as plain text.

## Limits

- Pages over 6000 pixels on a side, or over 24 million pixels, are shown with every Nth pixel. The Values section says when this happens, and the pointer readout still reads full resolution values. Statistics use every pixel.
- A file is held in memory while it is open, so the default limit is 1 GB. In our test an 8000 by 6000 16-bit page decoded, got its statistics and was drawn in about 0.6 s (Node on an Apple Silicon Mac).
- Tiled pages with fewer than 8 bits per pixel, uncompressed YCbCr and the compressions named above are not decoded.
- Sub-images stored in SubIFDs, such as some DNG and OME-TIFF pyramids, are listed in the tags but not shown as pages.

## Support

Zovo extensions have no ads and no tracking, and sponsors pay for the time that goes into fixes and new viewers. You can sponsor the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

## More viewers by Zovo

- [HDF5 & NetCDF Explorer (H5 Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, attributes and values in HDF5 and NetCDF files and plots slices.
- [PDF Viewer & PDF Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [CSV Viewer, Excel Viewer & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens CSV, TSV, Excel and Parquet files as a sortable, filterable table.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.
- [PPTX Viewer & PowerPoint Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Large JSON Viewer & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [JSONL Viewer & NDJSON Table Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite Viewer & DB Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [GGUF, Safetensors & NPY Viewer (NumPy Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.
- [MP4 Video Player & Video Preview with Sound](https://marketplace.visualstudio.com/items?itemName=zovo.video-preview-with-sound) plays MP4, MOV, MKV and WebM files with their sound.
- [DXF Viewer & CAD Viewer for 2D Drawings](https://marketplace.visualstudio.com/items?itemName=zovo.dxf-viewer) opens ASCII and binary DXF drawings with layers, measuring and PNG or SVG export.
- [AGENTS.md & CLAUDE.md Linter (Context Drift)](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale commands, paths and versions in AGENTS.md and CLAUDE.md files.
- [Agent Skills & Claude Skills (Skill Shelf)](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Claude Code History & Codex History Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.agent-session-viewer) browses and searches your local Claude Code and Codex sessions.
- [Claude Code Usage & Codex Usage Cost Meter](https://marketplace.visualstudio.com/items?itemName=zovo.ai-usage-meter) shows Claude Code and Codex tokens and estimated cost from your local session files.

Coming soon to the Marketplace, with the code on GitHub now.

- [DICOM Viewer & NIfTI Viewer for CT and MRI](https://github.com/theluckystrike/dicom-nifti-viewer-vscode) opens CT and MRI scans, DICOM folders and NIfTI volumes with window presets and three views.
- [Audio Preview & Loudness Meter](https://github.com/theluckystrike/audio-preview-vscode) plays audio files with a waveform, a spectrogram and LUFS loudness.
- [Graphviz Preview & DOT Viewer](https://github.com/theluckystrike/graphviz-preview-vscode) shows a live preview of DOT files and exports SVG or PNG.
- [Avro Viewer, Arrow Viewer & Feather Viewer](https://github.com/theluckystrike/arrow-avro-viewer-vscode) opens Avro, Arrow and Feather files as a paged table.
- [EML Viewer & MBOX Email Viewer](https://github.com/theluckystrike/eml-viewer-vscode) reads EML, EMLX and MBOX email files with remote images blocked.
- [3D Model Viewer (GLB, glTF, STL, OBJ, PLY)](https://github.com/theluckystrike/model-viewer-vscode) views GLB, glTF, STL, OBJ, PLY and 3MF models.
- [PKL Viewer & Pickle Viewer](https://github.com/theluckystrike/pickle-viewer-vscode) opens Python pickle files without Python and never runs their code.
- [ZIP Viewer & Archive Explorer (JAR, TAR, GZ)](https://github.com/theluckystrike/archive-explorer-vscode) browses ZIP, JAR, VSIX, TAR and GZ files, opens entries in tabs and extracts them safely.
- [GCode Viewer & 3D Print Preview](https://github.com/theluckystrike/gcode-viewer-vscode) shows GCode toolpaths in 3D layer by layer, with print time and filament use.
- [EPUB Reader & EPUB Viewer](https://github.com/theluckystrike/epub-reader-vscode) reads EPUB books with a table of contents, search and light, sepia or dark themes.
- [File Viewers Pack](https://github.com/theluckystrike/zovo-file-viewers) installs the PDF, table, Word, PowerPoint, HDF5 and tensor viewers in one step.

## License

MIT. The decoder uses [UTIF.js](https://github.com/photopea/UTIF.js) (MIT) and [pako](https://github.com/nodeca/pako) (MIT). See THIRD-PARTY-NOTICES.md.
