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

def add_song(song_name, preset_key, key_offset=None, force=False):
    print(f"\n==========================================")
    print(f"[*] 开始生成歌曲: 《{song_name}》 (Key: {preset_key}, 变调: {key_offset})")
    print(f"==========================================")
    
    out_cover = os.path.join(SONGS_DIR, f"{preset_key}_dafeiyu_cover.wav")
    if os.path.exists(out_cover) and not force:
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
        name = s.get('name', '')
        if any(w in name.lower() for w in ['伴奏', 'instrumental', 'inst', 'beat', '伴奏版', '纯音乐']):
            continue
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

    # 4. RVC 歌声转换 (纯清唱模式，独立进程)
    print("[4/4] RVC 歌声转换 (纯清唱模式)...")
    sovits_script = r"D:\deepseek-harness\sovits\sovits_sing.py"
    sovits_cmd = [
        sys.executable, sovits_script,
        "--vocal", vocal_stem,
        "--output", out_cover
    ]
    if key_offset is not None:
        sovits_cmd.extend(["--key", str(key_offset)])
    subprocess.run(sovits_cmd, check=True)

    # 清理临时文件
    for f in [temp_mp3, temp_clip, vocal_stem, inst_stem]:
        if os.path.exists(f):
            try: os.remove(f)
            except: pass
    try: os.rmdir(temp_dir)
    except: pass

    print(f"[SUCCESS] 《{song_name}》生成完成 -> {out_cover} (大小: {os.path.getsize(out_cover)} 字节)")
    return out_cover

def regenerate_all():
    # 1. 晴天与青花瓷直接使用现有分离人声升 12 半音纯清唱
    sovits_script = r"D:\deepseek-harness\sovits\sovits_sing.py"
    for k in ["qingtian", "qinghuaci"]:
        print(f"\n[*] 重新生成预置歌曲: {k} (升 12 半音纯清唱)")
        v = os.path.join(SONGS_DIR, f"{k}_vocal.wav")
        o = os.path.join(SONGS_DIR, f"{k}_dafeiyu_cover.wav")
        subprocess.run([sys.executable, sovits_script, "--vocal", v, "--output", o, "--key", "12"], check=True)

    # 2. 其他歌曲重新生成
    songs_to_add = [
        ("稻香 周杰伦", "daoxiang", 12),
        ("夜曲 周杰伦", "yequ", 12),
        ("告白气球 周杰伦", "gaobaiqiqiu", 12),
        ("爱你 王心凌", "aini", 0), # 女声原调 0
    ]
    for q, k, offset in songs_to_add:
        try:
            add_song(q, k, key_offset=offset, force=True)
        except Exception as e:
            print(f"[ERROR] 生成 {q} 失败: {e}")

if __name__ == "__main__":
    regenerate_all()
