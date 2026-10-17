#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
base=/opt/discord-worst-player-finder
data=/var/lib/discord-worst-player-finder
config=/etc/discord-worst-player-finder
unit=worst-player.service
node="$base/runtime/bin/node"
action=${1:-}
sha=${2:-}
if [[ $# -gt 2 || ! "$action" =~ ^(check|status|backup|start|stop|activate)$ ]]; then exit 64; fi
if [[ "$action" == check || "$action" == status || "$action" == activate ]]; then
  [[ "$sha" =~ ^[a-f0-9]{40}$ && -f "$base/releases/$sha/REVISION" && $(cat "$base/releases/$sha/REVISION") == "$sha" ]] || exit 64
fi
case "$action" in
  activate)
    ln -s "releases/$sha" "$base/.current-$sha-$$"
    mv -Tf "$base/.current-$sha-$$" "$base/current"
    ;;
  start|stop)
    [[ $# == 1 ]] || exit 64
    exec /usr/bin/systemctl "$action" "$unit"
    ;;
  check)
    [[ -f "$config/service.json" && -f "$config/service.env" ]] || { echo configuration-required >&2; exit 78; }
    exec /usr/sbin/runuser -u worst-player -- "$node" "--env-file=$config/service.env" "$base/releases/$sha/dist/src/operations/cli.js" check --config "$config/service.json"
    ;;
  status)
    result=$(/usr/sbin/runuser -u worst-player -- "$node" "$base/releases/$sha/dist/src/operations/cli.js" status --config "$config/service.json")
    printf '%s' "$result" | "$node" -e 'let s="";process.stdin.on("data",v=>s+=v);process.stdin.on("end",()=>{try{const v=JSON.parse(s);if(v.revision!==process.argv[1]||v.phase!=="ready")process.exitCode=1;else console.log(JSON.stringify({revision:v.revision,phase:v.phase,mode:v.mode,automatic:v.automatic}));}catch{process.exitCode=1;}});' "$sha"
    /usr/bin/systemctl is-active --quiet "$unit"
    ;;
  backup)
    [[ $# == 1 ]] || exit 64
    [[ -f "$data/app.sqlite" && -f "$data/operations-state.json" ]] || { echo data-initialization-required >&2; exit 78; }
    output="$data/backups/$(date -u +%Y%m%dT%H%M%S)-$RANDOM"
    exec /usr/sbin/runuser -u worst-player -- /usr/bin/flock -n -E 75 -F "$data/service.lock" "$node" "--env-file=$config/service.env" "$base/current/dist/src/operations/cli.js" backup --config "$config/service.json" --output "$output"
    ;;
esac
