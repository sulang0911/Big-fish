import os
import sys
import time
import requests
import shutil

DOWNLOAD_ITEMS = [
    {
        "name": "dafeiyu.pth",
        "url": "https://hf-mirror.com/YukiKaze1337/DaFeiYu_rvc_v2_40k/resolve/main/dafeiyu.pth",
        "dest": "D:/deepseek-harness/rvc/weights/dafeiyu.pth",
        "copy_to": ["D:/deepseek-harness/rvc/dafeiyu.pth"]
    },
    {
        "name": "added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index",
        "url": "https://hf-mirror.com/YukiKaze1337/DaFeiYu_rvc_v2_40k/resolve/main/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index",
        "dest": "D:/deepseek-harness/rvc/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index",
        "copy_to": ["D:/deepseek-harness/rvc/weights/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index"]
    },
    {
        "name": "hubert_base.pt",
        "url": "https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/hubert_base.pt",
        "dest": "D:/deepseek-harness/rvc/hubert_base.pt",
        "copy_to": [
            "D:/ollama/GPT-SoVITS-v2pro/GPT-SoVITS-v2pro-20250604/runtime/lib/site-packages/rvc_python/base_model/hubert_base.pt"
        ]
    },
    {
        "name": "rmvpe.pt",
        "url": "https://hf-mirror.com/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt",
        "dest": "D:/deepseek-harness/rvc/rmvpe.pt",
        "copy_to": [
            "D:/ollama/GPT-SoVITS-v2pro/GPT-SoVITS-v2pro-20250604/runtime/lib/site-packages/rvc_python/base_model/rmvpe.pt"
        ]
    }
]

def download_file(url, dest_path, name):
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    temp_path = dest_path + ".tmp"
    
    print(f"\n[DOWNLOAD] Starting {name}...")
    headers = {"User-Agent": "Mozilla/5.0"}
    
    with requests.get(url, headers=headers, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        total_size = int(resp.headers.get("content-length", 0))
        downloaded = 0
        start_time = time.time()
        last_log = start_time
        
        with open(temp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                f.write(chunk)
                downloaded += len(chunk)
                
                now = time.time()
                if now - last_log >= 1.0 or downloaded == total_size:
                    percent = (downloaded / total_size * 100) if total_size else 0
                    speed = (downloaded / (now - start_time) / (1024 * 1024)) if now > start_time else 0
                    print(f"  -> {name}: {downloaded/(1024*1024):.1f}/{total_size/(1024*1024):.1f} MB ({percent:.1f}%) @ {speed:.2f} MB/s", end="\r")
                    last_log = now
        print(f"\n[DOWNLOAD] Finished {name} in {time.time()-start_time:.1f}s")
    
    if os.path.exists(dest_path):
        os.remove(dest_path)
    os.rename(temp_path, dest_path)

def main():
    print("=== DaFeiYu RVC v2 Models Downloader ===")
    for item in DOWNLOAD_ITEMS:
        dest = item["dest"]
        name = item["name"]
        
        need_download = True
        if os.path.exists(dest):
            size = os.path.getsize(dest)
            if size > 1024 * 1024:
                print(f"[EXISTS] {name} already exists ({size / (1024*1024):.1f} MB), skipping download.")
                need_download = False
        
        if need_download:
            download_file(item["url"], dest, name)
            
        for extra in item.get("copy_to", []):
            os.makedirs(os.path.dirname(extra), exist_ok=True)
            if not os.path.exists(extra) or os.path.getsize(extra) != os.path.getsize(dest):
                print(f"  [COPY] Copying {name} to {extra}...")
                shutil.copy2(dest, extra)

    print("\n[SUCCESS] All RVC models and weights ready!")

if __name__ == "__main__":
    main()
