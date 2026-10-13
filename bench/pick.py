#!/usr/bin/env python3
"""Select commits that changed both tests and source.

Usage: pick.py <repo> <test-regex> <src-regex> [--since YYYY-MM-DD] [--limit N]

Prefer recent commits: the harness installs dependencies once at HEAD, so a
commit from a different dependency era fails to load and reports inconclusive
for reasons that have nothing to do with the tool.
"""
import argparse, re, subprocess, sys

p = argparse.ArgumentParser()
p.add_argument('repo'); p.add_argument('test_re'); p.add_argument('src_re')
p.add_argument('--since', default='2024-06-01'); p.add_argument('--limit', type=int, default=30)
a = p.parse_args()

test_re, src_re = re.compile(a.test_re), re.compile(a.src_re)
log = subprocess.run(['git', '-C', a.repo, 'log', '--format=%H', f'--since={a.since}'],
                     capture_output=True, text=True).stdout.split()

for sha in log:
    files = subprocess.run(['git', '-C', a.repo, 'show', '--name-only', '--format=', '-1', sha],
                           capture_output=True, text=True).stdout.split()
    if any(test_re.search(f) for f in files) and any(src_re.search(f) for f in files):
        print(sha)
        a.limit -= 1
        if a.limit <= 0:
            break
