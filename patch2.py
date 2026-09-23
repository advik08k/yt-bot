
import re
code = open('index.js', encoding='utf-8').read()

if 'browserlessDownload' not in code:
    code = code.replace('const { smartProxyDownload } = require(\'./proxyDownloader\');', 'const { browserlessDownload } = require(\'./browserlessDownloader\');')

download_block = '''
        let downloaded = false;
        try {
            addLog([+] Starting Browserless Remote Download via Loader.to...);
            await browserlessDownload(youtubeUrl, videoPath, addLog);
            downloaded = true;
        } catch (loaderErr) {
            addLog([-] Browserless Download failed: . Falling back to yt-dlp...);
            try {
                await youtubedl(youtubeUrl, {
                    output: videoPath,
                    format: 'best[height<=720][ext=mp4]/best[ext=mp4]/best',
                    noWarnings: true,
                    noCheckCertificates: true,
                    noPlaylist: true,
                    forceIpv6: true,
                    retries: 3
                });
                const stats = fs.statSync(videoPath);
                if (stats.size > 0) downloaded = true;
            } catch (err2) {
                // Ignore fallback error
            }
        }
        if (!downloaded) throw new Error('Failed to download video using both Browserless and yt-dlp.');
'''

code = re.sub(r'let downloaded = false;.*?if \(!downloaded\) throw new Error[^\n]+;', download_block.strip(), code, flags=re.DOTALL)
open('index.js', 'w', encoding='utf-8').write(code)
print('Done!')

