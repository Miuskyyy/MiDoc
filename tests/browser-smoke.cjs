const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  const consoleMessages = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleMessages.push(message.text()); });

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
    await page.locator('#executeActionBtn').click();
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
    await page.locator('#executeActionBtn').click();
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
    await page.locator('#executeActionBtn').click();
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
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 45000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.zip$/i);

    // Split PDF previews the actual first and last page for every configured range.
    await openTool('split-pdf');
    await page.locator('#fileInput').setInputFiles(pdfPath);
    await page.waitForFunction(() => {
      const end = document.querySelector('#splitRangeRows [data-page-to]');
      return end && end.value === '2' && document.querySelectorAll('#toolLivePreviewContent canvas').length === 2;
    }, { timeout: 20000 });
    assert.match(await page.locator('#splitPdfRangePreview').innerText(), /halaman 1–2/i);
    await page.locator('#splitRangeRows [data-page-to]').fill('1');
    await page.locator('#splitRangeRows [data-page-to]').dispatchEvent('input');
    await page.getByRole('button', { name: /Tambah Split/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('#toolLivePreviewContent canvas').length === 4, { timeout: 15000 });
    assert.match(await page.locator('#splitPdfRangePreview').innerText(), /PDF 2: halaman 2–2/i);
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 30000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.zip$/i);

    // PDF Crop uses a draggable grid, with no percentage-position inputs.
    await openTool('crop-pdf');
    await page.locator('#fileInput').setInputFiles(pdfPath);
    await page.waitForSelector('#toolLivePreviewContent canvas', { timeout: 15000 });
    await page.locator('#toolLivePreviewContent canvas').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#optPdfCropX').count(), 0, 'Numeric crop positioning inputs should be removed.');
    const pdfCropBox = await page.locator('#toolLivePreviewContent canvas').boundingBox();
    assert.ok(pdfCropBox && pdfCropBox.width > 100, 'PDF crop page should be visible at a usable size.');
    await page.mouse.move(pdfCropBox.x + pdfCropBox.width * 0.94, pdfCropBox.y + pdfCropBox.height * 0.94);
    await page.mouse.down();
    await page.mouse.move(pdfCropBox.x + pdfCropBox.width * 0.66, pdfCropBox.y + pdfCropBox.height * 0.66, { steps: 5 });
    await page.mouse.up();
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 30000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.pdf$/i);

    // Organize PDF automatically expands every page into an editable card as soon as a PDF is added.
    await openTool('organize-pdf');
    await page.locator('#fileInput').setInputFiles(pdfPath);
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#fileItemsGrid .file-card')];
      return cards.length === 2 && cards.some(card => card.innerText.includes('PDF HAL 1')) && cards.some(card => card.innerText.includes('PDF HAL 2'));
    }, { timeout: 15000 });
    assert.match(await page.locator('#fileItemsGrid').getAttribute('class'), /md:grid-cols-4/, 'PDF page cards should use four compact columns from medium screens.');
    assert.equal(await page.locator('#expandPdfPagesBtn').count(), 0, 'The manual split-per-page button must remain removed.');
    await page.locator('#executeActionBtn').click();
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
    await page.locator('#executeActionBtn').click();
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

    // ZIP viewer opens its contents in the central workspace immediately and offers individual downloads.
    await openTool('zip-tools');
    await page.locator('#optZipMode').selectOption('view');
    await page.locator('#fileInput').setInputFiles(zipPath);
    await page.waitForFunction(() => {
      const panel = document.getElementById('zipContentsCenter');
      return panel && !panel.classList.contains('hidden');
    }, { timeout: 20000 });
    const zipContents = await page.locator('#zipContentsCenter').innerText();
    assert.match(zipContents, /alpha\.txt/);
    assert.match(zipContents, /beta\.txt/);
    const fileDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('#zipContentsCenter button[data-zip-entry-download="0"]').click();
    const extractedFile = await fileDownloadPromise;
    assert.equal(extractedFile.suggestedFilename(), 'alpha.txt');

    // ZIP exposes only create/view modes and updates the file picker for the selected mode.
    await openTool('zip-tools');
    assert.equal(await page.locator('#optZipMode').inputValue(), 'create');
    assert.deepEqual(await page.locator('#optZipMode option').evaluateAll(options => options.map(option => option.value)), ['create','view']);
    await page.locator('#optZipMode').selectOption('view');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.zip/);
    assert.equal(await page.locator('#fileInput').evaluate(el => el.multiple), false);

    // QR and barcode share one generator and show a live preview before saving.
    await openTool('qr-generator');
    assert.equal(await page.locator('#toolPreviewColumn').evaluate(el => el.classList.contains('xl:col-span-8')), true, 'QR/Barcode preview should have a wide center area beside the settings.');
    await page.waitForFunction(() => typeof window.QRCode === 'function', { timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById('toolLivePreviewPanel').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('#optQrText').fill('https://example.com/midoc-audit');
    await page.waitForSelector('#toolLivePreviewContent canvas', { timeout: 15000 });
    await page.locator('#optCodeType').selectOption('barcode');
    await page.locator('#optQrText').fill('MIDO-C2026');
    await page.waitForFunction(() => document.getElementById('toolLivePreviewMeta')?.innerText === 'Barcode', { timeout: 15000 });
    const barcodeButtonState = await page.locator('#executeActionBtn').evaluate(el => ({ disabled: el.disabled, label: el.innerText }));
    assert.equal(barcodeButtonState.disabled, false, 'Barcode save button must be enabled.');
    await page.locator('#executeActionBtn').click();
    await page.waitForTimeout(1200);
    const barcodeSaveState = await page.evaluate(() => ({
      trace: window.__midocActionTrace || null,
      executeType: typeof window.executeCurrentTool,
      engine: state.activeEngine,
      toolId: state.activeToolObj?.id,
      itemCount: state.items.length,
      buttonDisabled: document.getElementById('executeActionBtn')?.disabled,
      resultHidden: document.getElementById('resultOutputBox')?.classList.contains('hidden'),
      toast: document.getElementById('toastContainer')?.innerText,
      pageReadyState: document.readyState
    }));
    if (barcodeSaveState.resultHidden) {
      throw new Error('QR/barcode save failed: ' + JSON.stringify({ state: barcodeSaveState, browserErrors: errors.slice(-5), consoleMessages: consoleMessages.slice(-5) }));
    }
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    // Resize Image preserves aspect ratio and updates the original/result pixel dimensions live.
    await openTool('resize-pixel');
    await page.locator('#fileInput').setInputFiles({ name: 'resize-source.png', mimeType: 'image/png', buffer: redPng });
    await page.waitForFunction(() => !document.getElementById('toolLivePreviewPanel').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('#optResizePercent').evaluate(el => { el.value = '200'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => document.getElementById('resizeDimensionPreview').innerText.includes('8 × 8 px'), { timeout: 10000 });
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    // Pixel Crop uses a draggable crop grid instead of numeric coordinate fields.
    await openTool('crop-image');
    await page.locator('#fileInput').setInputFiles({ name: 'crop-source.png', mimeType: 'image/png', buffer: redPng });
    await page.waitForFunction(() => document.querySelector('#fileItemsGrid .file-card-preview')?.classList.contains('h-[430px]'), { timeout: 10000 });
    await page.waitForSelector('#toolLivePreviewContent canvas', { timeout: 10000 });
    await page.locator('#toolLivePreviewContent canvas').scrollIntoViewIfNeeded();
    const cropCanvasBox = await page.locator('#toolLivePreviewContent canvas').boundingBox();
    assert.ok(cropCanvasBox && cropCanvasBox.width > 20, 'Crop preview canvas must be visible and large enough to edit.');
    await page.mouse.move(cropCanvasBox.x + cropCanvasBox.width * 0.95, cropCanvasBox.y + cropCanvasBox.height * 0.95);
    await page.mouse.down();
    await page.mouse.move(cropCanvasBox.x + cropCanvasBox.width * 0.55, cropCanvasBox.y + cropCanvasBox.height * 0.55, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => /2\s*×\s*2 px/.test(document.getElementById('cropPixelInfo')?.innerText || ''), { timeout: 10000 });
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    // Shape Crop provides a live circle/rounded crop; Filter Warna previews color changes on one selected image.
    await openTool('shape-crop');
    await page.locator('#fileInput').setInputFiles({ name: 'shape-source.png', mimeType: 'image/png', buffer: redPng });
    await page.locator('#optShapeMode').selectOption('circle');
    await page.waitForSelector('#toolLivePreviewContent canvas', { timeout: 10000 });
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    // Color palette appears automatically after image upload, with no extraction button.
    await openTool('color-picker');
    await page.locator('#fileInput').setInputFiles({ name: 'palette-red.png', mimeType: 'image/png', buffer: redPng });
    await page.waitForFunction(() => document.querySelectorAll('#toolLivePreviewContent button').length >= 1, { timeout: 10000 });
    assert.equal(await page.getByText('Ekstrak Palet Warna Gambar #1').count(), 0);

    await openTool('color-filters');
    await page.locator('#fileInput').setInputFiles([
      { name: 'filter-red.png', mimeType: 'image/png', buffer: redPng },
      { name: 'filter-blue.png', mimeType: 'image/png', buffer: bluePng }
    ]);
    assert.match(await page.locator('#fileItemsGrid').getAttribute('class'), /grid-cols-2/, 'Filter Warna should show two image cards per row.');
    await page.locator('#fileItemsGrid .file-card').nth(1).click();
    await page.locator('#optColorFilter').selectOption('grayscale(100%)');
    await page.waitForSelector('#toolLivePreviewContent canvas', { timeout: 10000 });
    assert.match(await page.locator('#toolLivePreviewMeta').innerText(), /filter-blue\.png/);
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    // Compression requires a separate preview action and reports source/result sizes before saving.
    await openTool('compress-image');
    await page.locator('#fileInput').setInputFiles({ name: 'compress-source.png', mimeType: 'image/png', buffer: redPng });
    await page.locator('button[onclick="previewCompressImage()"]').click();
    await page.waitForFunction(() => document.getElementById('compressPreviewInfo').innerText.includes('→'), { timeout: 15000 });
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.jpg$/i);

    // Layer composition selects background/foreground independently and exposes a draggable live preview.
    await openTool('overlay-images');
    await page.locator('#fileInput').setInputFiles([
      { name: 'background-red.png', mimeType: 'image/png', buffer: redPng },
      { name: 'foreground-blue.png', mimeType: 'image/png', buffer: bluePng }
    ]);
    await page.waitForFunction(() => !document.getElementById('toolLivePreviewPanel').classList.contains('hidden'), { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#optOverlayBase option').length === 2 && document.querySelectorAll('#optOverlayFront option').length === 2, { timeout: 10000 });
    assert.equal(await page.locator('#optOverlayBase option').count(), 2);
    assert.equal(await page.locator('#optOverlayFront option').count(), 2, 'Either uploaded image can be selected as the foreground layer.');
    await page.waitForSelector('#overlayPreviewScale', { timeout: 10000 });
    assert.equal(await page.locator('#optOverlayScale').getAttribute('type'), 'hidden', 'Layer size and position should not be duplicated in the settings panel.');
    assert.equal(await page.getByText('Gambar 1 · Latar / Belakang').count(), 1);
    assert.equal(await page.getByText('Gambar 2 · Depan / Overlay').count(), 1);
    await page.locator('#executeActionBtn').click();
    await page.waitForFunction(() => !document.getElementById('resultOutputBox').classList.contains('hidden'), { timeout: 20000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.png$/i);

    assert.deepEqual(errors, [], 'No uncaught browser exceptions should occur');
    console.log('Browser smoke tests passed: GIF, PDF, automatic page cards, ZIP view/download, QR/barcode preview, resize/crop/shape/filter/compression, and image layer composition.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
