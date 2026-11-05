#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一键批量预置歌曲生成工具 (安全低内存分步流水线)
分步运行并自动释放内存，避免 8G 内存机器触发虚拟内存不足。
"""

import os
import sys
import time
import requests
import subprocess
import soundfile as sf
import numpy as np
import librosa

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"

RVC_DIR = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.path.join(RVC_DIR, "songs")

def add_song(song_name, preset_key):
    print(f"\n==========================================")
    print(f"[*] 开始生成歌曲: 《{song_name}》 (Key: {preset_key})")
    print(f"==========================================")
    
    out_cover = os.path.join(SONGS_DIR, f"{preset_key}_dafeiyu_cover.wav")
    if os.path.exists(out_cover):
        print(f"[EXISTS] 翻唱音频已就绪: {out_cover}")
        return out_cover

    temp_dir = os.path.join(SONGS_DIR, f"temp_{preset_key}")
    os.makedirs(temp_dir, exist_ok=True)
    temp_mp3 = os.path.join(temp_dir, "raw.mp3")
    temp_clip = os.path.join(temp_dir, "clip_25s.wav")

    # 1. 搜索下载
    print("[1/3] 搜索网易云音乐音源...")
    headers = {'User-Agent': 'Mozilla/5.0'}
    r = requests.get('https://music.163.com/api/search/get/web', params={'s': song_name, 'type': 1, 'limit': 5}, headers=headers, timeout=6)
    songs = r.json().get('result', {}).get('songs', [])
    downloaded = False
    for s in songs:
        sid = s.get('id')
        stream = f'http://music.163.com/song/media/outer/url?id={sid}.mp3'
        resp = requests.get(stream, headers=headers, timeout=8)
        if resp.status_code == 200 and 'audio' in str(resp.headers.get('content-type', '')):
            with open(temp_mp3, 'wb') as f:
                f.write(resp.content)
            downloaded = True
            print(f"      下载成功: {s.get('name')} - {s.get('artists', [{}])[0].get('name')} ({len(resp.content)} bytes)")
            break
    if not downloaded:
        raise RuntimeError(f"未找到可下载的音源: {song_name}")

    # 2. 截取 25s 副歌
    print("[2/3] 提取 25s 黄金副歌切片...")
    y, sr = librosa.load(temp_mp3, sr=44100, mono=True)
    target_samples = int(25.0 * sr)
    if len(y) > target_samples:
        hop_length = 4410
        rms = librosa.feature.rms(y=y, frame_length=8820, hop_length=hop_length)[0]
        frames_len = int(25.0 * sr / hop_length)
        skip_frames = int(15 * sr / hop_length)
        if len(rms) > frames_len + skip_frames:
            search_rms = rms[skip_frames:]
            rolling = np.convolve(search_rms, np.ones(frames_len), mode='valid')
            best_start = skip_frames + int(np.argmax(rolling))
            start_sample = best_start * hop_length
        else:
            start_sample = 0
        clip = y[start_sample : start_sample + target_samples]
    else:
        clip = y

    fade_len = int(0.1 * sr)
    if len(clip) > 2 * fade_len:
        clip[:fade_len] *= np.linspace(0, 1, fade_len)
        clip[-fade_len:] *= np.linspace(1, 0, fade_len)
    sf.write(temp_clip, clip, sr)

    # 3. UVR5 分离 (子进程)
    print("[3/3] UVR5 音轨分离 (独立进程)...")
    sep_script = os.path.join(RVC_DIR, "separate_stems.py")
    subprocess.run([sys.executable, sep_script, "--input", temp_clip, "--output_dir", temp_dir], check=True)
    
    clip_base = os.path.basename(temp_clip)
    vocal_stem = os.path.join(temp_dir, f"vocal_{clip_base}_10.wav")
    inst_stem = os.path.join(temp_dir, f"instrument_{clip_base}_10.wav")

    # 4. RVC 转换并混音 (调用 rvc_sing.py 子进程)
    print("[4/4] RVC 歌声转换与混音 (独立进程)...")
    rvc_script = os.path.join(RVC_DIR, "rvc_sing.py")
    rvc_cmd = [
        sys.executable, rvc_script,
        "--vocal", vocal_stem,
        "--bgm", inst_stem,
        "--output", out_cover
    ]
    subprocess.run(rvc_cmd, check=True)

    # 清理临时文件
    for f in [temp_mp3, temp_clip, vocal_stem, inst_stem]:
        if os.path.exists(f):
            try: os.remove(f)
            except: pass
    try: os.rmdir(temp_dir)
    except: pass

    print(f"[SUCCESS] 《{song_name}》生成完成 -> {out_cover} (大小: {os.path.getsize(out_cover)} 字节)")
    return out_cover

if __name__ == "__main__":
    songs_to_add = [
        ("夜曲 周杰伦", "yequ"),
        ("告白气球 周杰伦", "gaobaiqiqiu"),
        ("七里香 周杰伦", "qilixiang"),
    ]
    for q, k in songs_to_add:
        try:
            add_song(q, k)
        except Exception as e:
            print(f"[ERROR] 添加 {q} 失败: {e}")
