#!/usr/bin/env bash
set -euo pipefail
umask 027
base=/opt/discord-worst-player-finder
command=${SSH_ORIGINAL_COMMAND:-}
if [[ ! "$command" =~ ^deploy\ ([a-f0-9]{40})\ ([a-f0-9]{64})$ ]]; then echo unsupported-deploy-command >&2; exit 64; fi
sha=${BASH_REMATCH[1]}
digest=${BASH_REMATCH[2]}
exec 9>"$base/deploy.lock"
flock -n -E 75 9
upload=$(mktemp "$base/incoming/release.XXXXXXXX.tar.gz")
head -c 134217729 > "$upload"
[[ $(stat -c %s "$upload") -le 134217728 ]] || { echo artifact-too-large >&2; exit 65; }
printf '%s  %s\n' "$digest" "$upload" | sha256sum --check --status
tar -tzf "$upload" | awk '
  { name=$0; sub(/^\.\//,"",name); if(name=="")next;
    if(name !~ /^[a-zA-Z0-9_./-]+$/ || name ~ /(^|\/)\.\.(\/|$)/ || name ~ /^\//)exit 1;
    if(name !~ /^(dist(\/src(\/.*)?)?\/?|analysis(\/prompts(\/.*)?)?\/?|evaluation(\/dictionaries(\/dotaconstants-v1.json)?)?\/?|config\/?|config\/(service|group-settings).example.json|deploy\/?|deploy\/(control.sh|receive.sh|worst-player.service|README.md)|package.json|package-lock.json|REVISION)$/)exit 1;
  }'
tar -tvzf "$upload" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}'
release="$base/releases/$sha"
if [[ -e "$release" ]]; then
  [[ -f "$release/.artifact-sha256" && $(cat "$release/.artifact-sha256") == "$digest" ]] || { echo release-conflict >&2; exit 65; }
else
  stage=$(mktemp -d "$base/releases/.stage-$sha-XXXXXXXX")
  chmod 0750 "$stage"
  tar --no-same-owner --no-same-permissions -xzf "$upload" -C "$stage"
  [[ $(cat "$stage/REVISION") == "$sha" ]] || exit 65
  cd "$stage"
  "$base/runtime/bin/node" "$base/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund
  printf '%s\n' "$digest" > "$stage/.artifact-sha256"
  mv -T "$stage" "$release"
fi
sudo -n /usr/local/libexec/wpf-control check "$sha"
previous=$(readlink "$base/current" || true)
switched=false
stopped=false
rollback() {
  result=$?
  if [[ $result -ne 0 && "$stopped" == true ]]; then
    sudo -n /usr/local/libexec/wpf-control stop || true
    if [[ "$previous" =~ ^releases/[a-f0-9]{40}$ ]]; then
      if [[ "$switched" == true ]]; then
        sudo -n /usr/local/libexec/wpf-control activate "${previous#releases/}"
      fi
      sudo -n /usr/local/libexec/wpf-control start || true
    fi
  fi
  exit "$result"
}
trap rollback EXIT
sudo -n /usr/local/libexec/wpf-control stop
stopped=true
if [[ -n "$previous" ]]; then sudo -n /usr/local/libexec/wpf-control backup; fi
sudo -n /usr/local/libexec/wpf-control activate "$sha"
switched=true
sudo -n /usr/local/libexec/wpf-control start
for attempt in $(seq 1 45); do
  if sudo -n /usr/local/libexec/wpf-control status "$sha"; then
    echo deployment-ready
    trap - EXIT
    exit 0
  fi
  sleep 2
done
echo deployment-health-failed >&2
exit 1
