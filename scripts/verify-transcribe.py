#!/usr/bin/env python3
"""Hubie coupled-sync proof — transcription spot check (off-air, local).

Extracts the proof recording's audio, transcribes it with faster-whisper
(small, CPU int8 — run with the clone-venv python and HF_HOME pointed at
voices-local/hf-cache), and fuzzy-matches >= 10 sampled displayed lines
against the transcript segments overlapping their speech window. The
primary coupling evidence is the line-id log correlation in
verify-proof.js; this is the independent spot check that what is HEARD
matches what was SHOWN.

Usage:
  HF_HOME=voices-local/hf-cache voices-local/clone-venv/bin/python \
    scripts/verify-transcribe.py
Writes logs/proof-transcription.json and prints a per-line table.
"""
import difflib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
MP4 = os.path.join(ROOT, "demo", "hubie-coupled-proof.mp4")
SAMPLES = os.path.join(ROOT, "logs", "proof-samples.json")
OUT = os.path.join(ROOT, "logs", "proof-transcription.json")
WAV = "/tmp/proof-audio-16k.wav"

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
    with open(SAMPLES) as f:
        samples = json.load(f)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", MP4, "-ar", "16000",
                    "-ac", "1", WAV], check=True)
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, _info = model.transcribe(WAV, beam_size=1)
    segs = [{"start": s.start, "end": s.end, "text": s.text} for s in segments]
    rows = []
    for s in samples:
        lo, hi = s["startOff"] - 0.6, s["endOff"] + 0.8
        heard = " ".join(x["text"] for x in segs if x["end"] >= lo and x["start"] <= hi)
        want, got = normalize(s["text"]), normalize(heard)
        ratio = difflib.SequenceMatcher(None, want, got).ratio() if got else 0.0
        rows.append({"id": s["id"], "line": s["text"], "heard": heard.strip(),
                     "ratio": round(ratio, 3), "match": ratio >= 0.55})
    passed = sum(1 for r in rows if r["match"])
    summary = {"samples": len(rows), "matched": passed, "rows": rows}
    with open(OUT, "w") as f:
        json.dump(summary, f, indent=2)
    for r in rows:
        print(f"{'MATCH' if r['match'] else 'MISS '} {r['ratio']:.2f} {r['id']}: {r['line']!r}  <- heard: {r['heard']!r}")
    print(f"\ntranscription spot check: {passed}/{len(rows)} sampled lines matched the audio")
    return 0 if rows and passed >= max(1, int(0.8 * len(rows))) else 1


if __name__ == "__main__":
    sys.exit(main())
