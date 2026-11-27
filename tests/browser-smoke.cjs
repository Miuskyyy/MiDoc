const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const base = 'http://127.0.0.1:4173/';
  const openTool = async id => {
    await page.goto(base + '?tool=' + encodeURIComponent(id), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#toolWorkspaceView:not(.hidden)', { timeout: 20000 });
    await page.waitForTimeout(250);
  };
  const makePng = async color => {
    const dataUrl = await page.evaluate(colorValue => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colorValue;
      ctx.fillRect(0, 0, 4, 4);
      return canvas.toDataURL('image/png').split(',')[1];
    }, color);
    return Buffer.from(dataUrl, 'base64');
  };
  const redPng = await makePng('#ff0000');
  const bluePng = await makePng('#0000ff');

  try {
    // GIF creation: static raster images only, real .gif output, no automatic download.
    await openTool('gif-tools');
    const gifInput = page.locator('#fileInput');
    assert.match(await gifInput.getAttribute('accept'), /\.png/);
    assert.equal(await gifInput.evaluate(el => el.multiple), true);
    await page.waitForFunction(() => typeof window.GIF === 'function', { timeout: 20000 });
    await gifInput.setInputFiles([
      { name: 'frame-red.png', mimeType: 'image/png', buffer: redPng },
      { name: 'frame-blue.png', mimeType: 'image/png', buffer: bluePng }
    ]);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    let downloadCount = 0;
    page.on('download', () => downloadCount++);
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 45000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.gif$/i);
    await page.waitForTimeout(500);
    assert.equal(downloadCount, 0, 'GIF creation must not auto-download');
    const gifDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#reDownloadBtn').click();
    const gifDownload = await gifDownloadPromise;
    const gifPath = '/tmp/midoc-created-test.gif';
    await gifDownload.saveAs(gifPath);
    const gifHeader = fs.readFileSync(gifPath).subarray(0, 6).toString('ascii');
    assert.ok(gifHeader === 'GIF89a' || gifHeader === 'GIF87a', 'The generated file must have a real GIF signature.');

    // GIF extraction: exactly one real GIF input; output is ZIP containing frames.
    await openTool('gif-tools');
    await page.locator('#optGifMode').selectOption('extract');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.gif/);
    assert.equal(await page.locator('#fileInput').evaluate(el => el.multiple), false);
    await page.locator('#fileInput').setInputFiles([
      { name: 'not-a-gif.gif', mimeType: 'image/gif', buffer: redPng }
    ]);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#fileItemsGrid').evaluate(el => el.classList.contains('hidden')), true, 'PNG must be rejected in GIF extraction mode');
    await page.locator('#fileInput').setInputFiles(gifPath);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 45000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.zip$/i);
    const frameZipDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#reDownloadBtn').click();
    const frameZipDownload = await frameZipDownloadPromise;
    const frameZipPath = '/tmp/midoc-gif-frames-test.zip';
    await frameZipDownload.saveAs(frameZipPath);
    const frameZipBytes = fs.readFileSync(frameZipPath);
    assert.equal(frameZipBytes.subarray(0, 2).toString('ascii'), 'PK', 'GIF extraction must create a valid ZIP archive.');
    const frameNames = await page.evaluate(async base64 => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const archive = await JSZip.loadAsync(bytes);
      const files = Object.keys(archive.files).filter(name => !archive.files[name].dir);
      const firstFrame = new Uint8Array(await archive.file(files[0]).async('arraybuffer'));
      return { files, pngHeader: Array.from(firstFrame.slice(0, 8)) };
    }, frameZipBytes.toString('base64'));
    assert.equal(frameNames.files.length, 2, 'The two-frame GIF must extract exactly two image frames.');
    assert.ok(frameNames.files.every(name => /_frame_\d{4}\.png$/i.test(name)));
    assert.deepEqual(frameNames.pngHeader, [137, 80, 78, 71, 13, 10, 26, 10], 'Extracted frame output must be PNG.');

    // PDF-to-image: only PDF files are accepted, and wrong image signatures are rejected.
    await openTool('pdf-to-image');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.pdf/);
    await page.locator('#fileInput').setInputFiles([
      { name: 'not-a-pdf.pdf', mimeType: 'application/pdf', buffer: redPng }
    ]);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#fileItemsGrid').evaluate(el => el.classList.contains('hidden')), true, 'PNG must be rejected by PDF-to-image');

    // Image-to-PDF defaults must be source-sized, margin-free, and original quality.
    await openTool('image-to-pdf');
    assert.equal(await page.locator('#optPageSize').inputValue(), 'FIT');
    assert.equal(await page.locator('#optMargin').inputValue(), '0');
    assert.equal(await page.locator('#optImagePdfQuality').inputValue(), 'original');
    await page.locator('#fileInput').setInputFiles([
      { name: 'source-red.png', mimeType: 'image/png', buffer: redPng },
      { name: 'source-blue.png', mimeType: 'image/png', buffer: bluePng }
    ]);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 45000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.pdf$/i);
    const pdfDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#reDownloadBtn').click();
    const pdfDownload = await pdfDownloadPromise;
    const pdfPath = '/tmp/midoc-image-to-pdf-test.pdf';
    await pdfDownload.saveAs(pdfPath);
    assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString('ascii'), '%PDF-', 'Image-to-PDF must create a real PDF file.');

    // A real PDF must be accepted by PDF-to-image and produce a ZIP of rendered pages.
    await openTool('pdf-to-image');
    await page.locator('#fileInput').setInputFiles(pdfPath);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 45000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.zip$/i);

    // Organize PDF must require splitting the source into page cards before processing.
    await openTool('organize-pdf');
    await page.locator('#fileInput').setInputFiles(pdfPath);
    await page.waitForFunction(() => {
      const card = document.querySelector('#fileItemsGrid .file-card');
      return card && card.innerText.includes('PDF 2 HAL');
    }, { timeout: 15000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#resultOutputBox').evaluate(el => el.classList.contains('hidden')), true, 'Organize PDF must not silently return an unchanged file before page cards are split');
    await page.locator('#expandPdfPagesBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#fileItemsGrid .file-card').length === 2, { timeout: 15000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 30000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.pdf$/i);

    // ZIP Maker creates a real archive while preserving source names.
    await openTool('zip-tools');
    await page.locator('#fileInput').setInputFiles([
      { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha-content') },
      { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from('beta-content') }
    ]);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 30000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.zip$/i);
    const zipDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#reDownloadBtn').click();
    const zipDownload = await zipDownloadPromise;
    const zipPath = '/tmp/midoc-zip-maker-test.zip';
    await zipDownload.saveAs(zipPath);
    assert.equal(fs.readFileSync(zipPath).subarray(0, 2).toString('ascii'), 'PK', 'ZIP Maker must create a real ZIP file.');

    // ZIP Viewer and Extractor must load archive contents and expose per-file download.
    await openTool('zip-tools');
    await page.locator('#optZipMode').selectOption('view');
    await page.locator('#fileInput').setInputFiles(zipPath);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const panel = document.getElementById('zipContentsPanel');
      return panel && !panel.classList.contains('hidden');
    }, { timeout: 20000 });
    const zipContents = await page.locator('#zipContentsPanel').innerText();
    assert.match(zipContents, /alpha\.txt/);
    assert.match(zipContents, /beta\.txt/);

    await openTool('zip-tools');
    await page.locator('#optZipMode').selectOption('extract');
    await page.locator('#fileInput').setInputFiles(zipPath);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const panel = document.getElementById('zipContentsPanel');
      return panel && !panel.classList.contains('hidden');
    }, { timeout: 20000 });
    const fileDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#zipContentsPanel button[data-zip-entry-download="0"]').click();
    const extractedFile = await fileDownloadPromise;
    assert.equal(extractedFile.suggestedFilename(), 'alpha.txt');

    // ZIP modes must change the file picker rules.
    await openTool('zip-tools');
    assert.equal(await page.locator('#optZipMode').inputValue(), 'create');
    await page.locator('#optZipMode').selectOption('view');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.zip/);
    assert.equal(await page.locator('#fileInput').evaluate(el => el.multiple), false);
    await page.locator('#optZipMode').selectOption('extract');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.zip/);

    // QR generator must create a standards-compatible PNG result from supplied text.
    await openTool('qr-generator');
    await page.waitForFunction(() => typeof window.QRCode === 'function', { timeout: 20000 });
    await page.locator('#optQrText').fill('https://example.com/midoc-audit');
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    assert.deepEqual(errors, [], 'No uncaught browser exceptions should occur');
    console.log('Browser smoke tests passed: GIF create/extract, strict PDF input guard, Image-to-PDF defaults/export, valid PDF-to-image export, ZIP create/view/extract/download, QR output.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
