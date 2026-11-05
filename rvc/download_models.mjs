import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const DOWNLOAD_ITEMS = [
  {
    name: 'dafeiyu.pth',
    url: 'https://hf-mirror.com/YukiKaze1337/DaFeiYu_rvc_v2_40k/resolve/main/dafeiyu.pth',
    dest: 'D:/deepseek-harness/rvc/weights/dafeiyu.pth',
    copyTo: ['D:/deepseek-harness/rvc/dafeiyu.pth']
  },
  {
    name: 'added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index',
    url: 'https://hf-mirror.com/YukiKaze1337/DaFeiYu_rvc_v2_40k/resolve/main/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index',
    dest: 'D:/deepseek-harness/rvc/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index',
    copyTo: ['D:/deepseek-harness/rvc/weights/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index']
  },
  {
    name: 'hubert_base.pt',
    url: 'https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/hubert_base.pt',
    dest: 'D:/deepseek-harness/rvc/hubert_base.pt',
    copyTo: [
      'D:/ollama/GPT-SoVITS-v2pro/GPT-SoVITS-v2pro-20250604/runtime/lib/site-packages/rvc_python/base_model/hubert_base.pt'
    ]
  },
  {
    name: 'rmvpe.pt',
    url: 'https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt',
    dest: 'D:/deepseek-harness/rvc/rmvpe.pt',
    copyTo: [
      'D:/ollama/GPT-SoVITS-v2pro/GPT-SoVITS-v2pro-20250604/runtime/lib/site-packages/rvc_python/base_model/rmvpe.pt'
    ]
  }
];

async function downloadFile(item) {
  const { name, url, dest, copyTo } = item;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    console.log(`[EXISTS] ${name} already downloaded (${(fs.statSync(dest).size / (1024*1024)).toFixed(1)} MB)`);
  } else {
    console.log(`\n[DOWNLOAD] Starting ${name}...`);
    const start = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const totalBytes = Number(res.headers.get('content-length') || 0);

    const tempPath = dest + '.tmp';
    const fileStream = fs.createWriteStream(tempPath);
    let downloaded = 0;
    let lastLog = Date.now();

    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on('data', chunk => {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastLog > 800 || downloaded === totalBytes) {
        const pct = totalBytes ? ((downloaded / totalBytes) * 100).toFixed(1) : 0;
        const spd = (downloaded / ((now - start) / 1000) / (1024 * 1024)).toFixed(2);
        process.stdout.write(`  -> ${name}: ${(downloaded/(1024*1024)).toFixed(1)} / ${(totalBytes/(1024*1024)).toFixed(1)} MB (${pct}%) @ ${spd} MB/s\r`);
        lastLog = now;
      }
    });

    await pipeline(nodeStream, fileStream);
    console.log(`\n[DOWNLOAD] Finished ${name} in ${((Date.now() - start) / 1000).toFixed(1)}s`);

    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(tempPath, dest);
  }

  for (const target of copyTo || []) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(dest).size) {
      console.log(`  [COPY] Copying ${name} to ${target}...`);
      fs.copyFileSync(dest, target);
    }
  }
}

async function main() {
  console.log('=== DaFeiYu RVC Model Downloader (Node.js fast stream) ===');
  for (const item of DOWNLOAD_ITEMS) {
    await downloadFile(item);
  }
  console.log('\n[SUCCESS] All RVC weights and base models ready!');
}

main().catch(err => {
  console.error('\n[ERROR]', err);
  process.exit(1);
});
