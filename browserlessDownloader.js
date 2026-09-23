const puppeteer = require('puppeteer-core');
const axios = require('axios');
const fs = require('fs');
const { pipeline } = require('stream/promises');

// Using the provided Browserless key
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '2VJShxJ7icjitaGa2aa839c5565d28f882ae36a6463131355';

async function browserlessDownload(youtubeUrl, videoPath, addLog) {
    addLog(`[+] Connecting to Browserless.io Remote Browser...`);
    
    let browser;
    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`,
            defaultViewport: null
        });
    } catch (e) {
        throw new Error(`Browserless connection failed: ${e.message}`);
    }

    let downloadUrl = null;

    try {
        const page = await browser.newPage();
        
        // Use a generic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        addLog(`[+] Requesting loader.to via Remote Browser...`);
        const targetInitUrl = `https://loader.to/ajax/download.php?format=1080&url=${encodeURIComponent(youtubeUrl)}`;
        
        await page.goto(targetInitUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const initDataStr = await page.evaluate(() => document.body.innerText);
        const initData = JSON.parse(initDataStr);
        
        if (!initData || !initData.id) {
            throw new Error('Failed to get loader.to Task ID');
        }

        const taskId = initData.id;
        addLog(`[+] Task ID obtained (${taskId}). Polling for final video URL...`);

        // Poll for completion
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const progressUrl = `https://loader.to/ajax/progress.php?id=${taskId}`;
            await page.goto(progressUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            
            const pStr = await page.evaluate(() => document.body.innerText);
            const pData = JSON.parse(pStr);
            
            if (pData.success === 1 && pData.download_url) {
                downloadUrl = pData.download_url;
                break;
            }
        }

        if (!downloadUrl) {
            throw new Error('Timeout waiting for loader.to progress.');
        }

    } catch (e) {
        throw new Error(`Browserless extraction failed: ${e.message}`);
    } finally {
        // Ensure browser is closed so we don't leak hours
        await browser.close().catch(() => {});
    }

    addLog(`[+] Extracted Final URL. Bypassed Cloudflare!`);
    addLog(`[+] Downloading directly to Render disk (Fast mode)...`);

    // We now have the direct URL. We can download it using Axios directly on Render,
    // because the final CDN (nora.savenow.to, etc) doesn't have a Cloudflare JS challenge.
    const res = await axios.get(downloadUrl, {
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    const contentLength = parseInt(res.headers['content-length'] || '0', 10);
    
    if (res.headers['content-type'].includes('html') || contentLength < 300 * 1024) {
        res.data.destroy();
        throw new Error('Downloaded file was too small or an HTML page.');
    }

    await pipeline(res.data, fs.createWriteStream(videoPath));
    addLog(`[+] Video download complete! Size: ${(contentLength / 1024 / 1024).toFixed(2)} MB`);
    
    return true;
}

module.exports = { browserlessDownload };
