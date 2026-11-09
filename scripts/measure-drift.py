#!/usr/bin/env python3
"""Hubie proof — A/V DRIFT measurement (off-air, local evidence only).

The feeder-clock failure mode: the recorded audio timeline compresses
relative to wall clock, so a line the voice service started at wall
offset T (per its journal, correlated to the ffmpeg start epoch in
logs/proof-meta.json) is HEARD in the recording at a position that
drifts further from T the later the line starts. This script measures
that offset at anchors across the recording:

  1. transcribe the recording's audio (faster-whisper small, same
     setup as scripts/verify-transcribe.py);
  2. for every journaled speech-started line, fuzzy-match its text
     against windows of 1-3 consecutive transcript segments whose
     start lies within +/-25s of the journal offset;
  3. drift(line) = heardStart - journalStartOff, in seconds (positive
     = audio LATE vs wall, negative = audio AHEAD of wall);
  4. report the best-matching line nearest to each anchor (60s, 180s,
     300s) plus a least-squares fit over all confident matches.

Pre-fix reference (2026-11-08 coupled proof): audio ahead ~8s at 100s
in, ~14s at 215s in (drift ≈ -8s / -14s, slope ≈ -6%).
Pass bar after the wall-clock feeder fix: |drift| at the final anchor
under 1 second.

Usage:
  HF_HOME=voices-local/hf-cache voices-local/clone-venv/bin/python \
    scripts/measure-drift.py
Writes logs/proof-drift.json and prints the anchor table.
"""
import difflib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
MP4 = os.path.join(ROOT, "demo", "hubie-coupled-proof.mp4")
SYNC = os.path.join(ROOT, "logs", "proof-sync.json")
META = os.path.join(ROOT, "logs", "proof-meta.json")
OUT = os.path.join(ROOT, "logs", "proof-drift.json")
WAV = "/tmp/proof-drift-audio-16k.wav"

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
        "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
        "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
        "eighty", "ninety"]


def num_words(n):
    n = int(n)
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + (" " + ONES[n % 10] if n % 10 else "")
    if n < 1000:
        r = n % 100
        return ONES[n // 100] + " hundred" + (" " + num_words(r) if r else "")
    if n < 1000000:
        r = n % 1000
        return num_words(n // 1000) + " thousand" + (" " + num_words(r) if r else "")
    r = n % 1000000
    return num_words(n // 1000000) + " million" + (" " + num_words(r) if r else "")


def normalize(text):
    text = text.lower()
    text = re.sub(r"(\d[\d,]*\.?\d*)\s*k\b", lambda m: str(int(float(m.group(1).replace(",", "")) * 1000)), text)
    text = re.sub(r"\d[\d,]*\.?\d*", lambda m: num_words(round(float(m.group(0).replace(",", "")))), text)
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def main():
    with open(META) as f:
        meta = json.load(f)
    with open(SYNC) as f:
        sync = json.load(f)
    t0 = meta["ffmpegStartedAt"]
    ended = {e["data"]["id"]: e["data"]["ts"] for e in sync["events"] if e["type"] == "speech-ended"}
    lines = []
    for e in sync["events"]:
        if e["type"] != "speech-started":
            continue
        d = e["data"]
        if d["id"] not in ended:
            continue
        start_off = (d["ts"] - t0) / 1000.0
        if 10.0 <= start_off <= meta["durationSec"] - 5.0:
            lines.append({"id": d["id"], "text": d["text"], "startOff": start_off})

    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", MP4, "-ar", "16000",
                    "-ac", "1", WAV], check=True)
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(WAV, beam_size=1)
    segs = [{"start": s.start, "end": s.end, "text": s.text, "norm": normalize(s.text)}
            for s in segments]

    matches = []
    for ln in lines:
        want = normalize(ln["text"])
        best = None
        for i, s in enumerate(segs):
            if abs(s["start"] - ln["startOff"]) > 25.0:
                continue
            joined = ""
            for j in range(i, min(i + 3, len(segs))):
                joined = (joined + " " + segs[j]["norm"]).strip()
                if not joined:
                    continue
                ratio = difflib.SequenceMatcher(None, want, joined).ratio()
                if best is None or ratio > best["ratio"]:
                    best = {"ratio": ratio, "heardStart": s["start"]}
            if best and best["ratio"] >= 0.98:
                break
        if best and best["ratio"] >= 0.55:
            matches.append({"id": ln["id"], "text": ln["text"],
                            "journalOff": round(ln["startOff"], 2),
                            "heardOff": round(best["heardStart"], 2),
                            "driftSec": round(best["heardStart"] - ln["startOff"], 3),
                            "ratio": round(best["ratio"], 3)})

    anchors = []
    for target in (60.0, 180.0, 300.0):
        near = [m for m in matches if abs(m["journalOff"] - target) <= 30.0]
        if near:
            pick = min(near, key=lambda m: abs(m["journalOff"] - target))
            anchors.append({"targetSec": target, "line": pick})
    fit = None
    if len(matches) >= 3:
        xs = [m["journalOff"] for m in matches]
        ys = [m["driftSec"] for m in matches]
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        slope = sxy / sxx if sxx else 0.0
        intercept = my - slope * mx
        fit = {"slopeSecPerSec": round(slope, 5),
               "slopePct": round(slope * 100, 2),
               "interceptSec": round(intercept, 3),
               "fittedDrift": {str(t): round(intercept + slope * t, 3) for t in (60, 180, 300)}}
    summary = {"matchedLines": len(matches), "journalLines": len(lines),
               "anchors": anchors, "fit": fit, "matches": matches}
    with open(OUT, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"drift: {len(matches)}/{len(lines)} journal lines confidently matched in the transcript")
    for a in anchors:
        m = a["line"]
        print(f"  anchor ~{a['targetSec']:.0f}s: line {m['id']} journal {m['journalOff']}s, "
              f"heard {m['heardOff']}s, drift {m['driftSec']:+.2f}s (match {m['ratio']})")
    if fit:
        print(f"  fit: slope {fit['slopePct']:+.2f}% (audio timeline vs wall), "
              f"fitted drift at 60/180/300s = {fit['fittedDrift']}")
    last = anchors[-1]["line"]["driftSec"] if anchors else None
    ok = last is not None and abs(last) < 1.0
    print(f"  PASS BAR (|drift| at final anchor < 1s): {'PASS' if ok else 'FAIL'}"
          + (f" — final anchor drift {last:+.2f}s" if last is not None else " — no anchor matched"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
