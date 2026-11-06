# Large files and export

- Files are decoded in a background worker, so the editor stays responsive.
- Files over `tiffViewer.maxFileMB` (1024 MB by default) are not decoded. You still get the tags of every page.
- Very large pages are shown with every Nth pixel; the Values section says when that happens.
- Export PNG saves the current page with the channel and stretch you picked.
- `tiffViewer.askForRating` turns off the one-time rating question.
