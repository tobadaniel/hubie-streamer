#!/usr/bin/env python3
"""Resume-gap analysis for the reconnect test (logs/transport-report.md).

Reads logs/reconnect-test/sink-sizes.log (epoch, total sink bytes at 1s
cadence) and finds, for each kill epoch passed on the command line, the
viewer-visible byte gap around it: the window during which the sink
received nothing. gap_start is the last sample that still grew, the gap
ends at the first sample that grows again.

Usage: analyze-gaps.py EPOCH [EPOCH...] [--file PATH]
"""
import sys

path = 'logs/reconnect-test/sink-sizes.log'
epochs = []
args = sys.argv[1:]
if '--file' in args:
    i = args.index('--file')
    path = args[i + 1]
    epochs = [int(x) for x in args[:i]]
else:
    epochs = [int(x) for x in args]

samples = []
with open(path) as f:
    for line in f:
        parts = line.split()
        if len(parts) == 2:
            samples.append((int(parts[0]), int(parts[1])))

def growth(i):
    """Bytes gained between sample i-1 and sample i."""
    if i == 0:
        return 0
    return samples[i][1] - samples[i - 1][1]

for kill in epochs:
    # index of the first sample at or after the kill epoch
    k = next((i for i, (t, _) in enumerate(samples) if t >= kill), None)
    if k is None:
        print(f'kill {kill}: no samples at/after kill epoch')
        continue
    # walk back to the last sample that grew (end of pre-kill flow)
    start = k
    while start > 0 and growth(start) == 0:
        start -= 1
    # walk forward to the first sample that grows again
    end = k
    while end < len(samples) and growth(end) == 0:
        end += 1
    if end >= len(samples):
        print(f'kill {kill}: flow NEVER resumed within the recording')
        continue
    gap_start_t = samples[start][0]
    gap_end_t = samples[end][0]
    print(f'kill {kill}: last growth at {gap_start_t}, first new growth at {gap_end_t}, '
          f'byte gap = {gap_end_t - gap_start_t}s '
          f'(kill happened {kill - gap_start_t}s after last growth, '
          f'flow resumed {gap_end_t - kill}s after the kill epoch)')
