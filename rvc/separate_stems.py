#!/usr/bin/env python
# -*- coding: utf-8 -*-
import os
import sys
import argparse

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"

uvr5_dir = "D:/ollama/GPT-SoVITS-v2pro/GPT-SoVITS-v2pro-20250604/tools/uvr5"
sys.path.append(uvr5_dir)
from vr import AudioPre

def separate_song(inp_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    model_path = os.path.join(uvr5_dir, "uvr5_weights", "HP5_only_main_vocal.pth")
    
    pre_fun = AudioPre(
        agg=10,
        model_path=model_path,
        device="cuda:0",
        is_half=False
    )
    
    pre_fun._path_audio_(inp_path, ins_root=out_dir, vocal_root=out_dir, format="wav", is_hp3=False)
    base_name = os.path.basename(inp_path)
    vocal_path = os.path.join(out_dir, f"vocal_{base_name}_10.wav")
    inst_path = os.path.join(out_dir, f"instrument_{base_name}_10.wav")
    print(f"[SEPARATED_VOCAL] {vocal_path}")
    print(f"[SEPARATED_INST] {inst_path}")
    return vocal_path, inst_path

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="UVR5 音轨分离工具")
    parser.add_argument("--input", type=str, required=True, help="输入音频文件")
    parser.add_argument("--output_dir", type=str, required=True, help="输出目录")
    args = parser.parse_args()
    separate_song(args.input, args.output_dir)
