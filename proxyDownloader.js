const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const { pipeline } = require('stream/promises');

let proxyPool = [];
let badProxies = new Set();

async function refreshProxies() {
    console.log('[+] Fetching fresh public proxies...');
    try {
        const res = await axios.get('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt');
        const lines = res.data.split('\n').map(l => l.trim()).filter(l => l);
        proxyPool = lines;
        console.log(`[+] Loaded ${proxyPool.length} proxies.`);
    } catch (err) {
        console.log('[-] Failed to fetch proxy list:', err.message);
    }
}

function getRandomProxies(count) {
    const validProxies = proxyPool.filter(p => !badProxies.has(p));
    if (validProxies.length < count) {
        return validProxies; // returns whatever is left
    }
    const shuffled = validProxies.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

async function attemptLoaderDownload(proxy, youtubeUrl, videoPath) {
    const proxyUrl = `http://${proxy}`;
    const httpsAgent = new HttpsProxyAgent(proxyUrl);
    const client = axios.create({ httpsAgent, timeout: 15000, maxRedirects: 5 });

    try {
        // Step 1: Init
        const initRes = await client.get(`https://loader.to/ajax/download.php?format=1080&url=${encodeURIComponent(youtubeUrl)}`);
        if (!initRes.data || !initRes.data.id) throw new Error("Init failed");
        const taskId = initRes.data.id;

        // Step 2: Poll Progress
        let downloadUrl = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const progRes = await client.get(`https://loader.to/ajax/progress.php?id=${taskId}`);
            if (progRes.data && progRes.data.success === 1 && progRes.data.download_url) {
                downloadUrl = progRes.data.download_url;
                break;
            }
        }
        if (!downloadUrl) throw new Error("Progress timeout");

        // Step 3: Check Download
        const headRes = await client.get(downloadUrl, {
            responseType: 'stream', // Start stream
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const contentLength = parseInt(headRes.headers['content-length'] || '0', 10);
        const contentType = headRes.headers['content-type'] || '';
        
        if (contentType.includes('html') || contentLength < 300 * 1024) {
            headRes.data.destroy(); // Cancel stream
            throw new Error(`Invalid file (HTML or < 300KB) Size: ${contentLength}`);
        }

        // It's a real file! Let's download it.
        await pipeline(headRes.data, fs.createWriteStream(videoPath));
        return { proxy, success: true, size: contentLength };
    } catch (err) {
        badProxies.add(proxy);
        throw err; // Re-throw to indicate failure
    }
}

async function smartProxyDownload(youtubeUrl, videoPath, addLog) {
    if (proxyPool.length < 50) await refreshProxies();

    let maxBatches = 5; // Try up to 5 batches of 5 proxies (25 proxies total)
    
    for (let batch = 1; batch <= maxBatches; batch++) {
        const proxies = getRandomProxies(5);
        if (proxies.length === 0) throw new Error("No proxies available.");
        
        addLog(`[~] Batch ${batch}/${maxBatches}: Racing 5 proxies for loader.to...`);

        try {
            await new Promise((resolve, reject) => {
                let failures = 0;
                let finished = false;

                for (const proxy of proxies) {
                    attemptLoaderDownload(proxy, youtubeUrl, videoPath)
                        .then(result => {
                            if (finished) return;
                            finished = true;
                            addLog(`[+] Proxy ${proxy} WON! Downloaded successfully. Size: ${(result.size / 1024 / 1024).toFixed(2)} MB`);
                            resolve(true);
                        })
                        .catch(err => {
                            if (finished) return;
                            // addLog(`[-] Proxy ${proxy} failed: ${err.message}`); // Optional: mute individual fails to reduce log spam
                            failures++;
                            if (failures === proxies.length) {
                                reject(new Error(`All 5 proxies in batch ${batch} failed.`));
                            }
                        });
                }
            });
            // If Promise resolves, we are done!
            return true;
        } catch (batchErr) {
            addLog(`[-] ${batchErr.message}`);
            if (batch === maxBatches) {
                throw new Error("All proxy batches failed.");
            }
        }
    }
}

module.exports = { smartProxyDownload };
