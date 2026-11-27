const { chromium } = require('playwright');
const assert = require('node:assert/strict');

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

    // GIF extraction: exactly one real GIF input; output is ZIP containing frames.
    await openTool('gif-tools');
    await page.locator('#optGifMode').selectOption('extract');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.gif/);
    assert.equal(await page.locator('#fileInput').evaluate(el => el.multiple), false);
    await page.locator('#fileInput').setInputFiles([
      { name: 'wrong.png', mimeType: 'image/png', buffer: redPng }
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

    // PDF-to-image: only PDF files are accepted, and wrong image signatures are rejected.
    await openTool('pdf-to-image');
    assert.match(await page.locator('#fileInput').getAttribute('accept'), /\.pdf/);
    await page.locator('#fileInput').setInputFiles([
      { name: 'not-a-pdf.png', mimeType: 'image/png', buffer: redPng }
    ]);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#fileItemsGrid').evaluate(el => el.classList.contains('hidden')), true, 'PNG must be rejected by PDF-to-image');

    // Image-to-PDF defaults must be source-sized, margin-free, and original quality.
    await openTool('image-to-pdf');
    assert.equal(await page.locator('#optPageSize').inputValue(), 'FIT');
    assert.equal(await page.locator('#optMargin').inputValue(), '0');
    assert.equal(await page.locator('#optImagePdfQuality').inputValue(), 'original');
    await page.locator('#fileInput').setInputFiles([
      { name: 'source.png', mimeType: 'image/png', buffer: redPng }
    ]);
    await page.waitForFunction(() => !document.getElementById('fileItemsGrid').classList.contains('hidden'), { timeout: 10000 });
    await page.locator('button[onclick="executeCurrentTool()"]').click();
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden');
    }, { timeout: 45000 });
    assert.match(await page.locator('#resultSavedFilename').innerText(), /\.pdf$/i);

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
    console.log('Browser smoke tests passed: GIF create/extract, PDF input guard, Image-to-PDF defaults/export, ZIP modes, QR output.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
