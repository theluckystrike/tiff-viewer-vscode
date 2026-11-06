'use strict';
const vscode = require('vscode');
const path = require('path');
const { buildHtml } = require('./html');
const { FileSource } = require('./core/source');
const { parseTiff, BufferReader } = require('./core/tiff');
const { validateWebviewMessage, sizePlan, fmtSize, publicPages, MB } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');

const VIEW_TYPE = 'tiffViewer.preview';
const MAX_LISTED_PAGES = 2000;
let rating = { success() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('tiffViewer');
  return { maxFileMB: c.get('maxFileMB', 1024) };
}

/** Reads the tags with small range reads (local files) or from the whole file (remote and virtual files). */
async function readTags(uri, size) {
  if (uri.scheme === 'file') {
    const src = await FileSource.open(uri.fsPath);
    try { return await parseTiff(src, { maxValues: 4096, maxPages: MAX_LISTED_PAGES }); } finally { await src.close(); }
  }
  if (size > settings().maxFileMB * MB) throw new Error(`This file is not on local disk and is ${fmtSize(size)}. Such files are read whole, and the limit is ${settings().maxFileMB} MB (setting tiffViewer.maxFileMB).`);
  return parseTiff(new BufferReader(await vscode.workspace.fs.readFile(uri)), { maxValues: 4096, maxPages: MAX_LISTED_PAGES });
}

class TiffEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const folder = uri.with({ path: path.posix.dirname(uri.path) });
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media, folder] };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
    });
    let disposed = false;
    let counted = false; // one success per opened tab, for the rating prompt
    const post = m => (disposed ? Promise.resolve(false) : panel.webview.postMessage(m));

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      try {
        if (msg.type === 'ready') {
          const t0 = Date.now();
          const stat = await vscode.workspace.fs.stat(uri);
          const plan = sizePlan(stat.size, settings().maxFileMB);
          const parsed = await readTags(uri, plan.decode ? stat.size : 0);
          await post({
            type: 'init', name, size: stat.size, sizeText: fmtSize(stat.size), plan, big: parsed.big, le: parsed.le,
            pages: publicPages(parsed), problems: parsed.problems.slice(0, 20), listedMax: MAX_LISTED_PAGES,
            src: panel.webview.asWebviewUri(uri).toString(), tagMs: Date.now() - t0,
          });
          return;
        }
        if (msg.type === 'needBytes') {
          const data = await vscode.workspace.fs.readFile(uri);
          await post({ type: 'bytes', data });
          return;
        }
        if (msg.type === 'rendered') { if (!counted) { counted = true; rating.success(); } return; }
        if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); await post({ type: 'copied' }); return; }
        if (msg.type === 'export') {
          const base = name.replace(/\.(tiff?)$/i, '');
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(folder, `${base}-page${msg.page + 1}.png`), filters: { 'PNG image': ['png'] }, saveLabel: 'Export PNG',
          });
          if (!target) { await post({ type: 'exported', cancelled: true }); return; }
          if (target.toString() === uri.toString() || !/\.png$/i.test(target.path)) {
            await post({ type: 'error', message: 'Choose a file name that ends in .png. The TIFF file itself is never overwritten.', soft: true });
            return;
          }
          await vscode.workspace.fs.writeFile(target, msg.data);
          await post({ type: 'exported', path: target.scheme === 'file' ? target.fsPath : target.toString(), bytes: msg.data.length });
        }
      } catch (e) {
        await post({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    });
    panel.onDidDispose(() => { disposed = true; });
  }
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.tiff-viewer', section: 'tiffViewer', message: (n) => `TIFF Viewer has opened ${n} images for you. A rating helps other people find it.` });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new TiffEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('tiffViewer.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.tiff-viewer#tiffViewer.start', false)),
    vscode.commands.registerCommand('tiffViewer.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, TiffEditorProvider, VIEW_TYPE, readTags };
