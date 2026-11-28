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
    await page.goto(base + '#tool=' + encodeURIComponent(id), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#toolWorkspaceView:not(.hidden)', { timeout: 20000 });
    await page.waitForTimeout(200);
  };
  const makePng = async (color, width = 64, height = 48) => {
    const dataUrl = await page.evaluate(({ colorValue, widthValue, heightValue }) => {
      const canvas = document.createElement('canvas');
      canvas.width = widthValue;
      canvas.height = heightValue;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colorValue;
      ctx.fillRect(0, 0, widthValue, heightValue);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { colorValue: color, widthValue: width, heightValue: height });
    return Buffer.from(dataUrl, 'base64');
  };
  const downloadFrom = async selector => {
    const promise = page.waitForEvent('download', { timeout: 15000 });
    await page.locator(selector).click();
    const download = await promise;
    const path = '/tmp/' + download.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, '_');
    await download.saveAs(path);
    return { path, name: download.suggestedFilename(), bytes: fs.readFileSync(path) };
  };
  const waitForResult = async () => {
    await page.waitForFunction(() => {
      const box = document.getElementById('resultOutputBox');
      return box && !box.classList.contains('hidden') && document.getElementById('resultSavedFilename')?.textContent.trim();
    }, { timeout: 30000 });
  };

  const redPng = await makePng('#ff0000');
  const bluePng = await makePng('#0000ff');

  try {
    // This is the supplied Studio HTML itself: its eight directory groups and navigation are the app.
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#homeDirectoryView:not(.hidden)', { timeout: 20000 });
    const expectedGroups = [
      'Gabung, Pisah & Halaman',
      'Edit & Optimasi PDF',
      'Konversi ke PDF',
      'Konversi dari PDF',
      'Kompres & Konversi Gambar',
      'Potong, Ukuran & Susun',
      'Warna, Efek & Metadata',
      'Utilitas & Batch Tools'
    ];
    const headings = await page.locator('#directoryGroupsContainer h2').allTextContents();
    assert.deepEqual(headings.map(value => value.trim()), expectedGroups);
    assert.match(await page.locator('#homeGroupFilters [data-group="pdf"]').innerText(), /4 Sub-Grup/);
    assert.match(await page.locator('#homeGroupFilters [data-group="image"]').innerText(), /3 Sub-Grup/);

    await page.locator('#homeGroupFilters [data-group="pdf"]').click();
    assert.equal(await page.locator('#directoryGroupsContainer > div').count(), 4);
    await page.locator('#homeGroupFilters [data-group="image"]').click();
    assert.equal(await page.locator('#directoryGroupsContainer > div').count(), 3);
    await page.locator('#homeGroupFilters [data-group="converter"]').click();
    assert.equal(await page.locator('#directoryGroupsContainer > div').count(), 1);
    await page.locator('#homeGroupFilters [data-group="all"]').click();

    await page.locator('#homeSearchInput').fill('QR & Barcode');
    assert.match(await page.locator('#directoryGroupsContainer').innerText(), /QR & Barcode Generator/);
    await page.locator('#homeSearchInput').fill('');
    await page.locator('#navBtn-image').click();
    await page.waitForFunction(() => !document.getElementById('megaMenuContainer').classList.contains('hidden'));
    assert.match(await page.locator('#megaMenuContent').innerText(), /Kompres & Konversi Gambar/);
    await page.locator('#navBtn-image').click();

    // QR/Barcode uses the supplied large preview stage and the user's explicit download action.
    await openTool('qr-barcode-gen');
    await page.waitForSelector('#activeWorkspaceStage #liveCodeCanvas', { timeout: 15000 });
    assert.ok(await page.locator('#liveCodeCanvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    await page.locator('#optCodeType').selectOption('CODE128');
    await page.locator('#optCodeValue').fill('MIDOC-CODE128-2026');
    await page.waitForFunction(() => {
      const canvas = document.getElementById('liveCodeCanvas');
      return canvas && canvas.width > 0 && canvas.height > 0;
    }, { timeout: 10000 });
    await page.locator('#executeActionBtn').click();
    await waitForResult();
    const barcode = await downloadFrom('#reDownloadBtn');
    assert.deepEqual(Array.from(barcode.bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

    // Crop is an interactive, in-place stage and exports the requested pixel dimensions.
    await openTool('image-crop-pixel');
    await page.locator('#fileInput').setInputFiles([{ name: 'crop-source.png', mimeType: 'image/png', buffer: redPng }]);
    await page.waitForSelector('#activeWorkspaceStage #cropImgSelectionBox', { timeout: 15000 });
    await page.locator('#optCropPxW').fill('32');
    await page.locator('#optCropPxH').fill('20');
    await page.locator('#executeActionBtn').click();
    await waitForResult();
    const crop = await downloadFrom('#reDownloadBtn');
    assert.match(crop.name, /\.png$/i);
    assert.deepEqual(Array.from(crop.bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(crop.bytes.readUInt32BE(16), 32);
    assert.equal(crop.bytes.readUInt32BE(20), 20);

    // Image-to-PDF creates a real PDF from the supplied browser-side image workflow.
    await openTool('image-to-pdf');
    await page.locator('#fileInput').setInputFiles([{ name: 'source-red.png', mimeType: 'image/png', buffer: redPng }]);
    await page.waitForSelector('#activeWorkspaceStage .file-card', { timeout: 15000 });
    await page.locator('#executeActionBtn').click();
    await waitForResult();
    const pdf = await downloadFrom('#reDownloadBtn');
    assert.match(pdf.name, /\.pdf$/i);
    assert.equal(pdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-');

    // GIF creation uses the supplied built-in encoder and returns a real GIF file.
    await openTool('gif-tools');
    await page.locator('#fileInput').setInputFiles([
      { name: 'frame-red.png', mimeType: 'image/png', buffer: redPng },
      { name: 'frame-blue.png', mimeType: 'image/png', buffer: bluePng }
    ]);
    await page.waitForSelector('#activeWorkspaceStage .file-card', { timeout: 15000 });
    await page.locator('#executeActionBtn').click();
    await waitForResult();
    const gif = await downloadFrom('#reDownloadBtn');
    assert.ok(['GIF89a', 'GIF87a'].includes(gif.bytes.subarray(0, 6).toString('ascii')));

    // ZIP create, list, and per-file extraction must all remain available.
    await openTool('zip-tools');
    await page.locator('#fileInput').setInputFiles([
      { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha-content') },
      { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from('beta-content') }
    ]);
    await page.waitForSelector('#activeWorkspaceStage .file-card', { timeout: 15000 });
    await page.locator('#executeActionBtn').click();
    await waitForResult();
    const archive = await downloadFrom('#reDownloadBtn');
    assert.equal(archive.bytes.subarray(0, 2).toString('ascii'), 'PK');

    await openTool('zip-tools');
    await page.locator('#optZipMode').selectOption('extract');
    await page.locator('#fileInput').setInputFiles([{ name: 'sample.zip', mimeType: 'application/zip', buffer: archive.bytes }]);
    await page.waitForFunction(() => document.getElementById('activeWorkspaceStage')?.innerText.includes('alpha.txt'), { timeout: 20000 });
    assert.match(await page.locator('#activeWorkspaceStage').innerText(), /beta\.txt/);
    const extracted = await downloadFrom('#activeWorkspaceStage button[onclick="downloadSingleZipEntry(0)"]');
    assert.equal(extracted.name, 'alpha.txt');
    assert.equal(extracted.bytes.toString('utf8'), 'alpha-content');

    // Text-to-PDF editor is embedded directly into the workspace without a file upload.
    await openTool('doc-to-pdf');
    await page.locator('#directDocTextArea').fill('MiDoc preview validation - direct document editor.');
    await page.locator('#executeActionBtn').click();
    await waitForResult();
    const doc = await downloadFrom('#reDownloadBtn');
    assert.equal(doc.bytes.subarray(0, 5).toString('ascii'), '%PDF-');

    assert.deepEqual(errors, [], 'No uncaught browser exceptions should occur');
    console.log('Browser smoke tests passed: supplied studio homepage, filters, navigation, QR/barcode, pixel crop, image-to-PDF, GIF encoder, ZIP create/list/download, and direct text-to-PDF.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
