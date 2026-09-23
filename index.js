const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { google } = require('googleapis');
const youtubedl = require('youtube-dl-exec');
const _ = require('lodash');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const crypto = require('crypto');
const { initDB, loadDB, saveDB } = require('./github-db');

// --- YouTube cookies (so yt-dlp isn't blocked with "Sign in to confirm you're
// not a bot" when downloading from a cloud server IP) ---
// Set YOUTUBE_COOKIES_B64 in Render's Environment tab to the base64 content
// of a cookies.txt file exported (e.g. via "Get cookies.txt LOCALLY") while
// logged into a YouTube account.
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES_B64) {
    try {
        fs.writeFileSync(COOKIES_PATH, Buffer.from(process.env.YOUTUBE_COOKIES_B64, 'base64'));
    } catch (e) {
        console.error('Failed to write cookies.txt:', e.message);
    }
}
const hasCookies = () => fs.existsSync(COOKIES_PATH) && fs.statSync(COOKIES_PATH).size > 0;

// --- Gemini Multi-Key Rotation ---
// Tries each key in order; skips to next on 429 quota error
const GEMINI_KEYS = [
    process.env.GEMINI_KEY_1 || '',
    process.env.GEMINI_KEY_2 || '',
    process.env.GEMINI_KEY_3 || '',
];
const generateAIDescription = async (title, fallbackKey) => {
    // Build key pool: env keys first, then DB key as last fallback
    const keys = [...GEMINI_KEYS.filter(k => k), fallbackKey].filter(k => k);
    for (const key of keys) {
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
            const prompt = `Write a highly engaging, catchy YouTube video description for a video titled: "${title}". Do not include the title itself. Keep it under 3 short sentences. Add exactly 5 highly relevant SEO hashtags at the very end. Ensure the tone is exciting and viral.`;
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (err) {
            if (err.message && (err.message.includes('429') || err.message.toLowerCase().includes('quota'))) {
                // Try next key
                continue;
            }
            throw err; // Other errors — rethrow
        }
    }
    throw new Error('All Gemini API keys exhausted (quota exceeded)');
};

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.set('trust proxy', true);

let logs = [];
const addLog = (msg) => {
    const time = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' });
    logs.push(`[${time}] ${msg}`);
    if (logs.length > 100) logs.shift();
    console.log(`[${time}] ${msg}`);
};

// --- Auth Routes ---
app.get('/auth/google', (req, res) => {
    const db = loadDB();
    if (!db.clientId || !db.clientSecret) return res.send('Please save Client ID and Secret in the panel first!');
    
    const targetChannel = req.query.targetChannel || '';
    const skipCount = req.query.skipCount || 0;
    
    // Pass custom params via state
    const stateObj = { t: targetChannel, s: parseInt(skipCount) };
    const stateStr = Buffer.from(JSON.stringify(stateObj)).toString('base64');
    
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const redirectUri = `${protocol}://${req.get('host')}/auth/google/callback`;
    const oauth2Client = new google.auth.OAuth2(db.clientId, db.clientSecret, redirectUri);
    
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
        state: stateStr
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const db = loadDB();
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const redirectUri = `${protocol}://${req.get('host')}/auth/google/callback`;
    const oauth2Client = new google.auth.OAuth2(db.clientId, db.clientSecret, redirectUri);
    
    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);
        
        let stateObj = { t: '', s: 0 };
        if (req.query.state) {
            stateObj = JSON.parse(Buffer.from(req.query.state, 'base64').toString('utf8'));
        }
        
        // Fetch User's Channel Name
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        let channelName = 'My Channel';
        try {
            const channelRes = await youtube.channels.list({ part: 'snippet', mine: true });
            if (channelRes.data.items && channelRes.data.items.length > 0) {
                channelName = channelRes.data.items[0].snippet.title;
            }
        } catch(e) {
            console.error("Could not fetch channel name", e.message);
        }

        if (tokens.refresh_token) {
            const newAccount = {
                id: crypto.randomUUID(),
                channelName: channelName,
                refreshToken: tokens.refresh_token,
                targetChannel: stateObj.t,
                skipCount: stateObj.s,
                clientId: db.clientId,
                clientSecret: db.clientSecret,
                uploadInterval: 'default',
                isPaused: false,
                uploadedVideos: [],
                shortsQueue: [],
                longsQueue: [],
                nextUploadTime: Date.now() + 10000 // start in 10s
            };
            
            db.accounts.push(newAccount);
            saveDB(db, addLog);
            addLog(`[+] Google Account Linked Successfully! Added [${channelName}]`);
            
            // Trigger background scrape
            setTimeout(() => refreshQueuesForAccount(newAccount.id), 2000);
            
            res.redirect('/');
        } else {
            res.send('No refresh token received. You must revoke access in your Google Account security settings and try again.');
        }
    } catch (e) {
        res.send('Error authenticating: ' + e.message);
    }
});

// --- API Routes ---
app.get('/api/config', (req, res) => {
    const db = loadDB();
    res.json({ clientId: db.clientId, clientSecret: db.clientSecret, geminiKey: db.geminiKey });
});

app.post('/api/config', (req, res) => {
    const db = loadDB();
    db.clientId = req.body.clientId;
    db.clientSecret = req.body.clientSecret;
    db.geminiKey = req.body.geminiKey;
    saveDB(db, addLog);
    addLog('[+] Global Settings saved successfully!');
    res.json({ success: true });
});

app.get('/api/accounts', (req, res) => {
    const db = loadDB();
    const safeAccounts = db.accounts.map(acc => ({
        id: acc.id,
        channelName: acc.channelName,
        targetChannel: acc.targetChannel,
        skipCount: acc.skipCount,
        shortsQueueLength: acc.shortsQueue.length,
        longsQueueLength: acc.longsQueue.length,
        uploadedCount: acc.uploadedVideos.length,
        nextUploadTime: acc.nextUploadTime,
        uploadInterval: acc.uploadInterval,
        isPaused: acc.isPaused || false
    }));
    res.json(safeAccounts);
});

app.delete('/api/accounts/:id', (req, res) => {
    const db = loadDB();
    db.accounts = db.accounts.filter(a => a.id !== req.params.id);
    saveDB(db, addLog);
    addLog(`[-] Account deleted.`);
    res.json({ success: true });
});

app.post('/api/accounts/:id/settings', (req, res) => {
    const db = loadDB();
    const acc = db.accounts.find(a => a.id === req.params.id);
    if (!acc) return res.status(404).json({ error: "Account not found" });
    
    if (req.body.isPaused !== undefined) {
        acc.isPaused = req.body.isPaused;
        addLog(`[+] Account [${acc.channelName}] auto-post set to: ${acc.isPaused ? 'PAUSED' : 'ACTIVE'}`);
    }
    
    if (req.body.uploadInterval !== undefined) {
        acc.uploadInterval = req.body.uploadInterval;
        // Reset timer immediately with the new interval
        const newMins = parseInt(req.body.uploadInterval) || 60;
        acc.nextUploadTime = Date.now() + (newMins * 60 * 1000);
        addLog(`[+] Account [${acc.channelName}] upload interval set to: ${acc.uploadInterval} mins. Timer reset.`);
    }
    
    saveDB(db, addLog);
    res.json({ success: true });
});

app.post('/api/trigger/:id', (req, res) => {
    const db = loadDB();
    const acc = db.accounts.find(a => a.id === req.params.id);
    if (acc) {
        acc.nextUploadTime = 0;
        saveDB(db, addLog);
        addLog(`[⚡] Forced immediate upload for ${acc.channelName}. Processing shortly.`);
    }
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => res.json({ logs }));

// --- Core Drip-Feed Logic ---

// Loader.to's "download_url" is now a JS-driven result page (progress bar +
// a final Download button), not the raw video file. Clicking that button is
// what actually triggers the real download; it also opens an ad in a new
// popup tab as a side effect. This opens the page in a real headless
// browser, auto-closes the ad popup, clicks the real button, and captures
// the file Chrome itself downloads.

const scrapeChannel = async (channelUrl, type) => {
    let targetUrl = channelUrl;
    try {
        const urlObj = new URL(channelUrl);
        urlObj.search = ''; 
        targetUrl = urlObj.toString().replace(/\/$/, '');
    } catch (e) {
        targetUrl = targetUrl.replace(/\/$/, '');
    }

    if (type === 'shorts') {
        if (!targetUrl.endsWith('/shorts')) targetUrl += '/shorts';
    } else {
        if (targetUrl.endsWith('/shorts')) targetUrl = targetUrl.replace('/shorts', '/videos');
        else if (!targetUrl.endsWith('/videos')) targetUrl += '/videos';
    }

    addLog(`[+] Scraping ${type} from ${targetUrl}...`);
    try {
        const ytInfo = await youtubedl(targetUrl, {
            print: '%(id)s|||%(title)s',
            flatPlaylist: true,
            noWarnings: true
        });

        const rawOutput = ytInfo.trim();
        if (!rawOutput) return [];
        
        const lines = rawOutput.split('\n');
        let videos = lines.map(line => {
            const [id, title] = line.split('|||');
            return { id, title: title || '' };
        }).reverse(); 
        
        return videos;
    } catch (e) {
        addLog(`[-] Error scraping ${type}: ${e.message}`);
        return [];
    }
};

const refreshQueuesForAccount = async (accountId) => {
    const db = loadDB();
    const acc = db.accounts.find(a => a.id === accountId);
    if (!acc || !acc.targetChannel) return;

    addLog(`[+] Checking for new videos for [${acc.channelName}]...`);
    const allShorts = await scrapeChannel(acc.targetChannel, 'shorts');
    const allLongs = await scrapeChannel(acc.targetChannel, 'videos');

    let validShorts = allShorts.slice(acc.skipCount);
    let validLongs = allLongs.slice(acc.skipCount);

    const newShorts = validShorts.filter(v => !acc.uploadedVideos.includes(v.id) && !acc.shortsQueue.find(q => q.id === v.id));
    const newLongs = validLongs.filter(v => !acc.uploadedVideos.includes(v.id) && !acc.longsQueue.find(q => q.id === v.id));

    if (newShorts.length > 0) {
        acc.shortsQueue = [...acc.shortsQueue, ...newShorts];
        addLog(`[+] Added ${newShorts.length} new Shorts for ${acc.channelName}.`);
    }
    if (newLongs.length > 0) {
        acc.longsQueue = [...acc.longsQueue, ...newLongs];
        addLog(`[+] Added ${newLongs.length} new Longs for ${acc.channelName}.`);
    }
    
    if (newShorts.length === 0 && newLongs.length === 0) {
        addLog(`[i] Scraping finished. No new videos found for ${acc.channelName}.`);
    }
    
    saveDB(db, addLog);
};

let isProcessing = false;

const tickEngine = async () => {
    if (isProcessing) return;
    
    const db = loadDB();
    const now = Date.now();
    
    // Find the first account that is due for an upload
    const accountToProcess = db.accounts.find(acc => !acc.isPaused && acc.nextUploadTime <= now && (acc.shortsQueue.length > 0 || acc.longsQueue.length > 0));
    
    if (!accountToProcess) return; // Nothing to do
    
    isProcessing = true;
    
    // Pick video: Alternate between Shorts and Longs, but favor Shorts if one is empty
    let type = 'shorts';
    let queue = accountToProcess.shortsQueue;
    
    // 50/50 chance to pick Long if both exist, else pick whichever has items
    if (accountToProcess.longsQueue.length > 0 && accountToProcess.shortsQueue.length > 0) {
        if (Math.random() > 0.5) { type = 'longs'; queue = accountToProcess.longsQueue; }
    } else if (accountToProcess.longsQueue.length > 0) {
        type = 'longs'; queue = accountToProcess.longsQueue;
    }
    
    const video = queue.shift(); 
    let intervalMins = type === 'shorts' ? 30 : 60;
    if (accountToProcess.uploadInterval && accountToProcess.uploadInterval !== 'default') {
        intervalMins = parseInt(accountToProcess.uploadInterval, 10);
    }
    accountToProcess.nextUploadTime = Date.now() + (intervalMins * 60 * 1000);
    saveDB(db, addLog); 

    addLog(`[+] [${accountToProcess.channelName}] Starting ${type.toUpperCase()}: "${video.title}"`);
    const youtubeUrl = `https://youtube.com/watch?v=${video.id}`;
    let videoPath = path.join(__dirname, `temp_${Date.now()}.mp4`);

    try {
        let downloaded = false;
        
        // --- DIRECT YOUTUBE DOWNLOAD ---
        // Without Puppeteer or Loader.to!
        try {
            addLog(`[+] Downloading directly from YouTube via yt-dlp (IPv6)${hasCookies() ? ' with cookies' : ''}...`);

            // Try IPv6 first: some cloud providers' IPv4 ranges are rate-limited/blocked
            // by YouTube, and IPv6 egress can sometimes dodge that. Not guaranteed to
            // work on every host - if Render has no IPv6 egress this will just fail
            // fast and fall through to the standard attempt below.
            await youtubedl(youtubeUrl, {
                output: videoPath,
                format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
                noWarnings: true,
                noCheckCertificates: true,
                noPlaylist: true,
                forceIpv6: true,
                retries: 3,
                ...(hasCookies() ? { cookies: COOKIES_PATH } : {})
            });

            if (!fs.existsSync(videoPath)) throw new Error('yt-dlp did not produce an output file.');
            const stats = fs.statSync(videoPath);
            if (stats.size === 0) throw new Error('yt-dlp produced an empty file.');
            addLog(`[+] YouTube direct download complete. Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            downloaded = true;
        } catch (ytErr) {
            addLog(`[-] IPv6 attempt failed: ${ytErr.message}. Trying standard (IPv4)...`);
            // Fallback: plain IPv4, still with cookies if we have them
            await youtubedl(youtubeUrl, {
                output: videoPath,
                format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
                noWarnings: true,
                noCheckCertificates: true,
                noPlaylist: true,
                retries: 3,
                ...(hasCookies() ? { cookies: COOKIES_PATH } : {})
            });
            if (!fs.existsSync(videoPath)) throw new Error('yt-dlp fallback did not produce an output file.');
            const stats = fs.statSync(videoPath);
            if (stats.size > 0) {
                addLog(`[+] Standard download complete. Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                downloaded = true;
            }
        }
        
        if (!downloaded) throw new Error('Failed to download video from YouTube.');
        let generatedDescription = `${video.title}\n\n#shorts #viral #trending #aesthetic`; 
        if (db.geminiKey || GEMINI_KEYS.some(k => k)) {
            try {
                addLog(`[+] Generating AI Description with Gemini...`);
                generatedDescription = await generateAIDescription(video.title, db.geminiKey);
            } catch (aiError) {
                addLog(`[-] Gemini AI Error: ${aiError.message}. Using fallback.`);
            }
        }

        addLog(`[+] Initiating Upload to YouTube for [${accountToProcess.channelName}]...`);
        const oauth2Client = new google.auth.OAuth2(
            accountToProcess.clientId || db.clientId, 
            accountToProcess.clientSecret || db.clientSecret
        );
        oauth2Client.setCredentials({ refresh_token: accountToProcess.refreshToken });
        const ytApi = google.youtube({ version: 'v3', auth: oauth2Client });

        const res = await ytApi.videos.insert({
            part: 'snippet,status',
            requestBody: {
                snippet: {
                    title: video.title,
                    description: generatedDescription,
                    tags: ['aesthetic', 'viral', 'shorts', 'trending']
                },
                status: {
                    privacyStatus: 'public',
                    selfDeclaredMadeForKids: false
                }
            },
            media: {
                body: fs.createReadStream(videoPath)
            }
        });

        addLog(`[+] SUCCESS! Uploaded to YT: https://youtu.be/${res.data.id}`);
        
        if (type === 'longs') {
            try {
                addLog(`[+] Fetching original thumbnail...`);
                let thumbRes = await fetch(`https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`);
                if (!thumbRes.ok) thumbRes = await fetch(`https://img.youtube.com/vi/${video.id}/hqdefault.jpg`);
                
                if (thumbRes.ok) {
                    const thumbBuffer = await thumbRes.arrayBuffer();
                    const thumbPath = path.join(__dirname, `thumb_${Date.now()}.jpg`);
                    fs.writeFileSync(thumbPath, Buffer.from(thumbBuffer));
                    
                    addLog(`[+] Applying Custom Thumbnail to the new video...`);
                    await ytApi.thumbnails.set({
                        videoId: res.data.id,
                        media: { body: fs.createReadStream(thumbPath) }
                    });
                    fs.unlinkSync(thumbPath);
                }
            } catch (thumbErr) {
                addLog(`[-] Thumbnail Error: ${thumbErr.message}.`);
            }
        }
        
        // Save success
        const latestDb = loadDB();
        const accToUpdate = latestDb.accounts.find(a => a.id === accountToProcess.id);
        if (accToUpdate) {
            accToUpdate.uploadedVideos.push(video.id);
            saveDB(latestDb, addLog);
        }

    } catch (e) {
        addLog(`[-] ERROR processing ${video.id}: ${e.message}`);
        // Re-queue (with a retry limit so one permanently-broken video can't block the queue forever)
        const recoveryDb = loadDB();
        const accToRecover = recoveryDb.accounts.find(a => a.id === accountToProcess.id);
        if (accToRecover) {
            const MAX_RETRIES = 3;
            video.failCount = (video.failCount || 0) + 1;

            if (video.failCount >= MAX_RETRIES) {
                addLog(`[!] "${video.title}" (${video.id}) failed ${MAX_RETRIES}x. Skipping it permanently so the queue can move on.`);
                // Mark as done so it's never re-added by scraping/queueing again
                if (!accToRecover.uploadedVideos.includes(video.id)) {
                    accToRecover.uploadedVideos.push(video.id);
                }
            } else {
                addLog(`[~] Will retry "${video.title}" later (attempt ${video.failCount}/${MAX_RETRIES}). Moving it to the back of the queue.`);
                if (type === 'shorts') accToRecover.shortsQueue.push(video);
                else accToRecover.longsQueue.push(video);
            }

            if (e.message.includes('uploadLimitExceeded') || e.message.toLowerCase().includes('quota')) {
                addLog(`[!] Limit Reached for [${accToRecover.channelName}]. Auto-pausing account to prevent spam.`);
                accToRecover.isPaused = true;
            }
            
            saveDB(recoveryDb, addLog);
        }
    } finally {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        isProcessing = false;
    }
};

const PORT = process.env.PORT || 10000;

(async () => {
    await initDB(addLog);

    // Engine ticks every 1 minute
    cron.schedule('* * * * *', tickEngine);

    // Init Queues
    setTimeout(async () => {
        addLog('[+] Initializing Queues sequentially to save RAM...');
        const db = loadDB();
        for (const acc of db.accounts) {
            await refreshQueuesForAccount(acc.id);
        }
    }, 1000);

    // Schedule queue refresh (every 12 hours)
    cron.schedule('0 */12 * * *', async () => {
        const db = loadDB();
        for (const acc of db.accounts) {
            await refreshQueuesForAccount(acc.id);
        }
    });

    app.listen(PORT, () => {
        addLog(`🚀 YT-to-YT Multi-Account Cloud Bot is running on port ${PORT}`);
    });
})();
