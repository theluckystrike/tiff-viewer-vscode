# Changelog

## 0.1.1 (2026-11-06)

- The status line at the bottom of the viewer has two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `tiffViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "TIFF Viewer: Support the developer" and "TIFF Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.
- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 11 that are coming soon.
- Extensions for related files now come first, starting with HDF5 & NetCDF Explorer (H5 Viewer).

## 0.1.0

- First release. Opens .tif and .tiff files, classic TIFF and BigTIFF, as a read-only custom editor.
- Multi-page files get a page strip with thumbnails and page names.
- 8, 16, 32 and 64-bit integer and float data, with auto contrast, percentile and min to max stretches.
- Channel picker, zoom and pan, pixel values under the pointer, a tags panel and a GeoTIFF section.
- Export the current page to PNG. Files over 1 GB show their tags and a clear message.
