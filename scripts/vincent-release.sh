#!/usr/bin/env bash
# Rebuild Vincent's Token Monitor integration branch on top of an upstream
# release: the release tag plus every fork branch in vincent/branches.txt.
#
#   scripts/vincent-release.sh status         [--tag vX.Y.Z]
#   scripts/vincent-release.sh build          [--tag vX.Y.Z] [--no-install | --node-modules DIR] [--no-test]
#   scripts/vincent-release.sh changed        # true when the build differs from fork vincent/release
#   scripts/vincent-release.sh next-version   # X.Y.((Z+1)*1000+N) for the build's upstream X.Y.Z
#   scripts/vincent-release.sh stamp VERSION  # commit the app version onto the build
#   scripts/vincent-release.sh publish-branch # fast-forward fork vincent/release to the stamped build
#
# build works in its own worktree under $TM_OUT and never touches the clone's
# checkout. vincent/release only ever moves forward: each rebuild becomes a
# merge whose tree is the fresh build and whose parents are the previous
# vincent/release tip and the rebuilt history, so no push needs --force.
#
# Exit codes from build: 0 ok, 10 merge conflict, 11 lint/test failure,
# 12 missing branch. $TM_OUT/report.md explains the result either way.
#
# Environment:
#   TM_REPO             clone to build from (default: the clone containing this script)
#   TM_UPSTREAM_REMOTE  remote of Javis603/token-monitor  (default: auto-detect by URL)
#   TM_FORK_REMOTE      remote of ump45nose/token-monitor (default: auto-detect by URL)
#   TM_OUT              scratch directory (default: ${TMPDIR:-/tmp}/vincent-release)
#   TM_MANIFEST         branch list (default: vincent/branches.txt beside this script)
#   GIT_AUTHOR          commit identity (default: "Vincent <1729065730@qq.com>")
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="${TM_MANIFEST:-$TOOLS_ROOT/vincent/branches.txt}"
TM_OUT="${TM_OUT:-${TMPDIR:-/tmp}/vincent-release}"
GIT_AUTHOR="${GIT_AUTHOR:-Vincent <1729065730@qq.com>}"
AUTHOR_NAME="${GIT_AUTHOR% <*}"
AUTHOR_EMAIL="${GIT_AUTHOR##*<}"; AUTHOR_EMAIL="${AUTHOR_EMAIL%>}"
RELEASE_BRANCH=vincent/release
WT="$TM_OUT/worktree"
REGISTRY_RE='(^|/)hubBuildRegistry\.json$'

log() { printf '[vincent-release] %s\n' "$*" >&2; }
die() { printf '[vincent-release] error: %s\n' "$*" >&2; exit 1; }

repo() {
  if [[ -n "${TM_REPO:-}" ]]; then echo "$TM_REPO"; return; fi
  local common
  common="$(git -C "$TOOLS_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
    die "set TM_REPO to a token-monitor clone"
  echo "${common%/.git}"
}
g() { git -C "$(repo)" "$@"; }
w() { git -C "$WT" -c "user.name=$AUTHOR_NAME" -c "user.email=$AUTHOR_EMAIL" -c rerere.enabled=false "$@"; }
remote_for() { g remote -v | awk -v p="$1" '$2 ~ p && $3 == "(fetch)" { print $1; exit }'; }
upstream_remote() { echo "${TM_UPSTREAM_REMOTE:-$(remote_for 'Javis603/token-monitor')}"; }
fork_remote() { echo "${TM_FORK_REMOTE:-$(remote_for 'ump45nose/token-monitor')}"; }
manifest_branches() { sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$MANIFEST"; }

fetch_all() {
  local up fork
  up="$(upstream_remote)"; fork="$(fork_remote)"
  [[ -n "$up" ]] || die "no remote for Javis603/token-monitor (set TM_UPSTREAM_REMOTE)"
  [[ -n "$fork" ]] || die "no remote for ump45nose/token-monitor (set TM_FORK_REMOTE)"
  log "fetching $up (main + tags) and $fork (branches)"
  g fetch --quiet --no-tags "$up" "+refs/heads/main:refs/remotes/$up/main"
  g fetch --quiet "$up" "+refs/tags/v*:refs/tags/v*"
  g fetch --quiet --no-tags "$fork" "+refs/heads/*:refs/remotes/$fork/*"
}

latest_tag() { # newest stable vX.Y.Z on upstream main
  g tag --merged "$(upstream_remote)/main" --list 'v[0-9]*' --sort=-v:refname |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
}

parse_opts() {
  TAG=""; NO_INSTALL=false; NO_TEST=false; NODE_MODULES=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --tag) TAG="${2:-}"; shift ;;
      --no-install) NO_INSTALL=true ;;
      --no-test) NO_TEST=true ;;
      --node-modules) NODE_MODULES="${2:-}"; NO_INSTALL=true; shift ;; # reuse an installed tree (same lockfile)
      *) die "unknown option $1" ;;
    esac
    shift
  done
}

cmd_status() {
  parse_opts "$@"; fetch_all
  [[ -n "$TAG" ]] || TAG="$(latest_tag)"
  local fork; fork="$(fork_remote)"
  echo "latest upstream release: $TAG"
  echo "fork $RELEASE_BRANCH:     $(g log -1 --format='%h %s' "$fork/$RELEASE_BRANCH" 2>/dev/null || echo missing)"
  local b ref
  for b in $(manifest_branches); do
    ref="$fork/$b"
    if ! g rev-parse -q --verify "$ref^{commit}" >/dev/null; then echo "  $b: MISSING on fork"
    elif g merge-base --is-ancestor "$ref" "$TAG"; then echo "  $b: already in $TAG (drop it)"
    else echo "  $b: $(g rev-list --count "$TAG..$ref") commits ahead, $(g rev-list --count "$ref..$TAG") behind $TAG"; fi
  done
}

report() { printf '%s\n' "$*" >> "$TM_OUT/report.md"; }

cmd_build() {
  parse_opts "$@"; fetch_all
  [[ -n "$TAG" ]] || TAG="$(latest_tag)"
  [[ -n "$TAG" ]] || die "no upstream release tag found"
  g rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || die "tag $TAG not found"
  local fork; fork="$(fork_remote)"
  mkdir -p "$TM_OUT"
  rm -f "$TM_OUT"/{report.md,tag,content-tree,build-sha,release-sha,version,lint.log,test.log}
  if [[ -e "$WT" ]]; then
    g worktree remove --force "$WT" 2>/dev/null || rm -rf "$WT"
    g worktree prune
  fi
  g worktree add --quiet --detach "$WT" "$TAG"
  echo "$TAG" > "$TM_OUT/tag"

  report "# vincent/release rebuild on upstream $TAG"
  report ""
  report "Base: \`$TAG\` ($(g rev-parse --short "$TAG^{commit}"))"
  report ""
  local b ref files conflicts=() missing=() merged=() skipped=()
  for b in $(manifest_branches); do
    ref="$fork/$b"
    if ! g rev-parse -q --verify "$ref^{commit}" >/dev/null; then missing+=("$b"); log "missing: $b"; continue; fi
    if w merge-base --is-ancestor "$ref" HEAD; then skipped+=("$b"); log "already contained: $b"; continue; fi
    log "merging $b"
    if w merge --no-ff --no-edit -q -m "Merge $b into $RELEASE_BRANCH on $TAG" "$ref" >/dev/null 2>&1; then
      merged+=("$b $(g rev-parse --short "$ref")"); continue
    fi
    files="$(w diff --name-only --diff-filter=U)"
    if [[ -n "$files" ]] && ! grep -Evq "$REGISTRY_RE" <<<"$files"; then
      # Every PR appends a Hub build revision, so the registries always collide.
      # Keep ours here; the registry is regenerated after the last merge.
      while read -r f; do w checkout --ours -- "$f"; w add -- "$f"; done <<<"$files"
      w commit -q --no-edit -s
      merged+=("$b $(g rev-parse --short "$ref") (Hub build registry regenerated)")
      continue
    fi
    conflicts+=("$b: $(tr '\n' ' ' <<<"$files")")
    log "conflict in $b: $files"
    w merge --abort
  done

  report "## Branches"
  local x
  for x in "${merged[@]}"; do report "- merged \`$x\`"; done
  for x in "${skipped[@]}"; do report "- already in $TAG, skipped: \`$x\`"; done
  for x in "${missing[@]}"; do report "- **missing on the fork**: \`$x\`"; done
  for x in "${conflicts[@]}"; do report "- **conflict**: \`$x\`"; done
  report ""
  if ((${#conflicts[@]})); then
    report "Resolve each conflict on a fork branch (merge $TAG into it, or add a vincent/* resolution branch to vincent/branches.txt), then rerun."
    log "build stopped: ${#conflicts[@]} conflict(s)"; return 10
  fi
  if ((${#missing[@]})); then log "build stopped: missing branches"; return 12; fi

  if [[ -n "$NODE_MODULES" ]]; then
    [[ -d "$NODE_MODULES" ]] || die "no node_modules at $NODE_MODULES"
    ln -s "$(cd "$NODE_MODULES" && pwd)" "$WT/node_modules"
  elif ! $NO_INSTALL; then
    log "npm ci"
    (cd "$WT" && npm ci --no-audit --no-fund >"$TM_OUT/npm-ci.log" 2>&1) || { report "npm ci failed; see the run log."; tail -40 "$TM_OUT/npm-ci.log" >&2; return 11; }
  fi
  (cd "$WT" && npm run --silent update:hub-build >/dev/null)
  if [[ -n "$(w status --porcelain --untracked-files=no)" ]]; then
    w add -u
    w commit -q -s -m "chore: refresh the Hub build registry for the merged branches"
  fi
  w rev-parse HEAD > "$TM_OUT/build-sha"
  w rev-parse 'HEAD^{tree}' > "$TM_OUT/content-tree"

  if ! $NO_TEST; then
    log "npm run lint"
    if ! (cd "$WT" && npm run lint >"$TM_OUT/lint.log" 2>&1); then
      report "## Lint failed"; report '```'; tail -60 "$TM_OUT/lint.log" >> "$TM_OUT/report.md"; report '```'; return 11
    fi
    log "npm test"
    if ! (cd "$WT" && npm test >"$TM_OUT/test.log" 2>&1); then
      report "## Tests failed"; report '```'
      { grep -E '^(not ok|✖)' "$TM_OUT/test.log" | head -40; tail -25 "$TM_OUT/test.log"; } >> "$TM_OUT/report.md"
      report '```'; return 11
    fi
    report "Lint and tests passed."
  fi
  log "build ok: $(cat "$TM_OUT/build-sha")"
}

require_build() { [[ -s "$TM_OUT/build-sha" && -d "$WT" ]] || die "run build first"; }

release_trailer() { # $1 = commit, $2 = trailer key; prints nothing when $1 does not exist yet
  local body
  body="$(g log -1 --format=%B "$1" 2>/dev/null)" || return 0
  sed -n "s/^$2: *//p" <<<"$body" | tail -1
}

cmd_changed() {
  require_build
  local fork previous
  fork="$(fork_remote)"
  previous="$(release_trailer "$fork/$RELEASE_BRANCH" Content-Tree)"
  if [[ "$previous" == "$(cat "$TM_OUT/content-tree")" ]]; then echo false; else echo true; fi
}

cmd_next_version() {
  require_build
  local base major minor patch prefix n=0 t k
  base="$(git -C "$WT" show "$(cat "$TM_OUT/tag"):package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
  [[ "$base" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "unexpected upstream version $base"
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"; patch="${BASH_REMATCH[3]}"
  prefix=$(( (patch + 1) * 1000 ))
  # Fork builds of X.Y.Z are X.Y.((Z+1)*1000+N): above every upstream X.Y.*
  # patch, ordered by upstream patch and then by rebuild N.
  while read -r t; do
    t="${t##*/}"
    [[ "$t" =~ ^v$major\.$minor\.([0-9]+)$ ]] || continue
    k="${BASH_REMATCH[1]}"
    if (( k > prefix && k < prefix + 1000 && k - prefix > n )); then n=$(( k - prefix )); fi
  done < <(g ls-remote --tags --refs "$(fork_remote)" "v$major.$minor.*" | awk '{print $2}')
  echo "$major.$minor.$(( prefix + n + 1 ))"
}

cmd_stamp() {
  require_build
  local version="${1:-}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "stamp needs X.Y.Z"
  (cd "$WT" && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)
  w add package.json package-lock.json
  w commit -q -s -m "chore(release): Token Monitor $version (Vincent build on upstream $(cat "$TM_OUT/tag"))" \
    -m "Upstream-Tag: $(cat "$TM_OUT/tag")" -m "Content-Tree: $(cat "$TM_OUT/content-tree")"
  echo "$version" > "$TM_OUT/version"
  w rev-parse HEAD > "$TM_OUT/release-sha"
  cat "$TM_OUT/release-sha"
}

cmd_publish_branch() {
  [[ -s "$TM_OUT/release-sha" ]] || die "run stamp first"
  local fork sha tip new tag version
  fork="$(fork_remote)"; sha="$(cat "$TM_OUT/release-sha")"; tag="$(cat "$TM_OUT/tag")"; version="$(cat "$TM_OUT/version")"
  if tip="$(g rev-parse -q --verify "refs/remotes/$fork/$RELEASE_BRANCH^{commit}")"; then
    new="$(GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
      g commit-tree "$sha^{tree}" -p "$tip" -p "$sha" \
        -m "Rebuild $RELEASE_BRANCH: Token Monitor $version on upstream $tag" \
        -m "The tree is the fresh build of $tag plus vincent/branches.txt; the second parent is that history." \
        -m "Upstream-Tag: $tag
Content-Tree: $(cat "$TM_OUT/content-tree")
Signed-off-by: $AUTHOR_NAME <$AUTHOR_EMAIL>")"
  else
    new="$sha"
  fi
  g push --quiet "$fork" "$new:refs/heads/$RELEASE_BRANCH"
  echo "$new" > "$TM_OUT/published-sha"
  log "pushed $RELEASE_BRANCH = $new"
  echo "$new"
}

case "${1:-}" in
  status) shift; cmd_status "$@" ;;
  build) shift; cmd_build "$@" ;;
  changed) shift; cmd_changed ;;
  next-version) shift; cmd_next_version ;;
  stamp) shift; cmd_stamp "$@" ;;
  publish-branch) shift; cmd_publish_branch ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
