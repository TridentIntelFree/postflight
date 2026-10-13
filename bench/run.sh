#!/bin/bash
# run.sh <repo> <test-command> <commit-list-file> <out.csv>
repo="$1"; cmd="$2"; list="$3"; out="$4"
cd "$repo"
echo "sha,subject,outcome,reason,ntests,secs" > "$out"
while read -r sha; do
  [ -z "$sha" ] && continue
  subj=$(git log -1 --format=%s "$sha" | tr ',' ';' | cut -c1-60)
  base=$(git rev-parse "$sha^" 2>/dev/null) || continue
  tmp=$(mktemp -d)
  printf '{"pull_request":{"number":1,"base":{"sha":"%s"},"head":{"sha":"%s"}}}' "$base" "$sha" > "$tmp/event.json"
  : > "$tmp/out"; : > "$tmp/sum"
  start=$(date +%s)
  GITHUB_EVENT_PATH="$tmp/event.json" GITHUB_OUTPUT="$tmp/out" GITHUB_STEP_SUMMARY="$tmp/sum" \
  GITHUB_SHA="$sha" GITHUB_REPOSITORY="bench/bench" \
  INPUT_TEST_COMMAND="$cmd" INPUT_COMMENT="false" INPUT_LINK_PATHS="${LINKS:-node_modules}" \
  timeout 240 node /home/user/postflight/src/main.js > "$tmp/log" 2>&1
  secs=$(( $(date +%s) - start ))
  oc=$(grep -o '"outcome": "[^"]*"' "$tmp/sum" | head -1 | sed 's/.*: "//;s/"//')
  rs=$(grep -o '"reason": "[^"]*"' "$tmp/sum" | head -1 | sed 's/.*: "//;s/"//')
  nt=$(grep -o '"testsEvaluated": [0-9]*' "$tmp/sum" | head -1 | grep -o '[0-9]*')
  echo "$sha,$subj,${oc:-NORESULT},${rs:-},${nt:-0},$secs" >> "$out"
  printf '  %-9s %-14s %-18s %ss  %s\n' "${sha:0:9}" "${oc:-NORESULT}" "${rs:-}" "$secs" "${subj:0:44}"
  rm -rf "$tmp"
done < "$list"
